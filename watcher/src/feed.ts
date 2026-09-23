/** Nordic day-ahead electricity spot. Public, no key, 15-minute SE3 windows.
 *
 * The PriceFeed interface exists because the feed choice may be revisited
 * (docs/DECISIONS.md, 2026-09-20). This file ships one implementation.
 * There is no synthetic fallback: a missing or failed fetch is a gap.
 */

import { sekPerKwhToScaled } from "./money.js";

export type PriceWindow = {
  timeStart: string;
  timeEnd: string;
  sekPerKwh: string;
};

export type FeedStatus = "ok" | "unreachable" | "http_error" | "malformed" | "missing_window";

/** One classified read of the day file. */
export type FeedRead = {
  status: FeedStatus;
  sourceUrl: string;
  /** Time of the last successful price read. Null when no price was read. */
  readAt: Date | null;
  refreshFailed: boolean;
  window: PriceWindow | null;
  /** Set when the feed answered with a non-2xx status. */
  httpStatus: number | null;
};

export interface PriceFeed {
  getWindow(at: Date): Promise<PriceWindow | null>;
  readWindow?(at: Date): Promise<FeedRead>;
}

export const FEED_ORIGIN = "https://www.elprisetjustnu.se";

// The price is captured as raw text from the same object it belongs to, never
// parsed into a float, because every amount downstream is integer base units.
// JSON.parse would turn 1e-05 into a float and the cheap windows would be the
// ones lost. The token is read by field name so key order and a quoted decimal
// still yield a window. A quoted value that is not a decimal does not. A nested
// object repeating the key cannot shift a neighbour: the source token is taken
// from that entry's own text.
const SEK_VALUE_RE = /"SEK_per_kWh"\s*:\s*(?:"([^"]*)"|([-+0-9.eE]+))/;

/** Expand scientific notation to a plain decimal string, textually.
 *
 * Never goes through a float: the digits are shifted as strings so the value
 * handed to the integer money math is exact. The feed can emit a SEK price
 * this way too, and the strict decimal parser in money.ts rejects scientific
 * notation by design, so normalising at the money boundary keeps that guard
 * intact while the screen can still show the source text byte for byte.
 */
export function plainDecimal(raw: string): string {
  const t = raw.trim();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(t);
  if (!m) return t;
  const sign = m[1] === "-" ? "-" : "";
  const intPart = m[2] ?? "0";
  const fracPart = m[3] ?? "";
  const exp = Number.parseInt(m[4] ?? "0", 10);
  const digits = intPart + fracPart;
  let pointAt = intPart.length + exp;
  let out: string;
  if (pointAt <= 0) {
    out = "0." + "0".repeat(-pointAt) + digits;
  } else if (pointAt >= digits.length) {
    out = digits + "0".repeat(pointAt - digits.length);
  } else {
    out = digits.slice(0, pointAt) + "." + digits.slice(pointAt);
  }
  return sign + out;
}

export function stockholmYmd(at: Date): { yyyy: string; mm: string; dd: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(at);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("feed.stockholmYmd: failed to format date");
  }
  return { yyyy: year, mm: month, dd: day };
}

export function feedUrlFor(at: Date): string {
  const { yyyy, mm, dd } = stockholmYmd(at);
  return `${FEED_ORIGIN}/api/v1/prices/${yyyy}/${mm}-${dd}_SE3.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipWs(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") break;
    i += 1;
  }
  return i;
}

function indexAfterJsonString(text: string, quoteAt: number): number {
  let escape = false;
  for (let i = quoteAt + 1; i < text.length; i += 1) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') return i + 1;
  }
  return -1;
}

function indexAfterJsonValue(text: string, start: number): number {
  const i = skipWs(text, start);
  if (i >= text.length) return -1;
  const c = text[i];
  if (c === '"') return indexAfterJsonString(text, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  const rest = text.slice(i);
  const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
  if (literal === null) return -1;
  return i + literal[0].length;
}

/** Source text of each top-level array value, in order. Null when the walk
 * cannot follow a document JSON.parse already accepted. */
function topLevelArraySpans(text: string): string[] | null {
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  i = skipWs(text, i);
  if (text[i] !== "[") return null;
  i += 1;
  const spans: string[] = [];
  let expectValue = true;
  while (i < text.length) {
    i = skipWs(text, i);
    if (i >= text.length) return null;
    const c = text[i];
    if (c === "]") return spans;
    if (c === ",") {
      if (expectValue) return null;
      expectValue = true;
      i += 1;
      continue;
    }
    if (!expectValue) return null;
    const end = indexAfterJsonValue(text, i);
    if (end < 0) return null;
    spans.push(text.slice(i, end));
    i = end;
    expectValue = false;
  }
  return null;
}

/** Raw SEK_per_kWh token at object depth 1. Nested copies of the key are ignored. */
function topLevelSekToken(objectSrc: string): string | undefined {
  let i = skipWs(objectSrc, 0);
  if (objectSrc[i] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  let found: string | undefined;
  while (i < objectSrc.length) {
    const c = objectSrc[i];
    if (inString) {
      if (escape) {
        escape = false;
        i += 1;
        continue;
      }
      if (c === "\\") {
        escape = true;
        i += 1;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (depth === 1) {
        const slice = objectSrc.slice(i);
        const match = SEK_VALUE_RE.exec(slice);
        if (match !== null && match.index === 0) {
          const quoted = match[1];
          const unquoted = match[2];
          if (quoted !== undefined) found = quoted;
          else if (unquoted !== undefined) found = unquoted;
        }
      }
      inString = true;
      i += 1;
      continue;
    }
    if (c === "{" || c === "[") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}" || c === "]") {
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/** True when a quoted price is a decimal the money path will price, as written.
 *
 * The grammar is sekPerKwhToScaled: the same acceptance the rest of the money
 * path uses, including scientific text that expands before the strict parser.
 * Surrounding space is not part of that decimal, so a padded token is not a
 * price. An empty string and a non-numeric token are not either.
 */
function quotedPriceIsDecimal(value: string): boolean {
  if (value.length === 0 || value !== value.trim()) return false;
  try {
    sekPerKwhToScaled(value);
    return true;
  } catch {
    return false;
  }
}

function sekFromParsed(value: unknown, raw: string | undefined): string | null {
  if (typeof value === "string") {
    if (!quotedPriceIsDecimal(value)) return null;
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (raw === undefined || raw.length === 0) return null;
    return raw;
  }
  return null;
}

export function parseFeedBody(text: string): PriceWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const spans = topLevelArraySpans(text);
  const windows: PriceWindow[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i];
    if (!isRecord(item)) continue;
    const timeStart = item.time_start;
    const timeEnd = item.time_end;
    if (typeof timeStart !== "string" || typeof timeEnd !== "string") continue;
    if (timeStart.length === 0 || timeEnd.length === 0) continue;

    const sekValue = item.SEK_per_kWh;
    const readable =
      typeof sekValue === "string" || (typeof sekValue === "number" && Number.isFinite(sekValue));
    if (!readable) continue;

    const span = spans?.[i];
    const raw = span === undefined ? undefined : topLevelSekToken(span);
    const sekPerKwh = sekFromParsed(sekValue, raw);
    if (sekPerKwh === null || sekPerKwh.length === 0) continue;
    windows.push({ timeStart, timeEnd, sekPerKwh });
  }
  return windows;
}

/** Prefer the window that starts at `at`. A wider window listed first still
 * contains the instant, and taking it first leaves the slot unpaid. Containment
 * is only the fallback when no window starts on the instant. */
export function windowContaining(windows: PriceWindow[], at: Date): PriceWindow | null {
  const t = at.getTime();
  if (!Number.isFinite(t)) return null;
  let contained: PriceWindow | null = null;
  for (const w of windows) {
    const start = Date.parse(w.timeStart);
    const end = Date.parse(w.timeEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start === t) return w;
    if (contained === null && t >= start && t < end) contained = w;
  }
  return contained;
}

/** True when the body is not a day file the parser can read.
 *
 * HTML, an object, truncated JSON, and a JSON array whose entries are not in
 * the expected shape are all unreadable. An empty array is understood: it has
 * no windows, including none for this hour.
 */
export function isMalformedDayBody(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return true;
    if (parsed.length === 0) return false;
    return parseFeedBody(text).length === 0;
  } catch {
    return true;
  }
}

function noPrice(
  status: Exclude<FeedStatus, "ok">,
  sourceUrl: string,
  extra: { refreshFailed?: boolean; httpStatus?: number | null } = {},
): FeedRead {
  return {
    status,
    sourceUrl,
    readAt: null,
    refreshFailed: extra.refreshFailed ?? false,
    window: null,
    httpStatus: extra.httpStatus ?? null,
  };
}

function classifyDayBody(
  text: string,
  at: Date,
  sourceUrl: string,
  readAt: Date,
  refreshFailed: boolean,
): FeedRead {
  const windows = parseFeedBody(text);
  if (windows.length === 0) {
    return noPrice(isMalformedDayBody(text) ? "malformed" : "missing_window", sourceUrl, {
      refreshFailed,
    });
  }
  const window = windowContaining(windows, at);
  if (window === null) {
    return noPrice("missing_window", sourceUrl, { refreshFailed });
  }
  return { status: "ok", sourceUrl, readAt, refreshFailed, window, httpStatus: null };
}

type CachedDay = { text: string; readAt: Date };

export class EnergySpotFeed implements PriceFeed {
  private readonly cache = new Map<string, CachedDay>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async readWindow(at: Date): Promise<FeedRead> {
    const sourceUrl = feedUrlFor(at);
    const cached = this.cache.get(sourceUrl);
    let text: string;
    let readAt = at;
    let refreshFailed = false;

    try {
      const res = await this.fetchImpl(sourceUrl, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) {
        refreshFailed = true;
        if (cached === undefined) {
          return noPrice("http_error", sourceUrl, { refreshFailed: true, httpStatus: res.status });
        }
        text = cached.text;
        readAt = cached.readAt;
      } else {
        text = await res.text();
        readAt = at;
      }
    } catch {
      refreshFailed = true;
      if (cached === undefined) {
        return noPrice("unreachable", sourceUrl, { refreshFailed: true });
      }
      text = cached.text;
      readAt = cached.readAt;
    }

    const classified = classifyDayBody(text, at, sourceUrl, readAt, refreshFailed);
    if (!refreshFailed && !isMalformedDayBody(text)) {
      this.cache.set(sourceUrl, { text, readAt });
    }
    return classified;
  }

  async getWindow(at: Date): Promise<PriceWindow | null> {
    const read = await this.readWindow(at);
    return read.window;
  }
}
