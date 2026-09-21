/** Nordic day-ahead electricity spot. Public, no key, 15-minute SE3 windows.
 *
 * The PriceFeed interface exists because the feed choice may be revisited
 * (docs/DECISIONS.md, 2026-09-20). This file ships one implementation.
 * There is no synthetic fallback: a missing or failed fetch is a gap.
 */

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

// The price is captured as raw text, never parsed into a float, because every
// amount downstream is integer base units. EUR_per_kWh and EXR are captured
// loosely on purpose: we do not use them, and the feed emits them in
// scientific notation for very cheap windows ("EUR_per_kWh": 1e-05). A strict
// numeric pattern on those fields silently dropped the whole entry, and
// because scientific notation appears exactly when the price is tiny, the
// windows lost were the cheapest ones, which are the ones that would have
// paid. Four of ninety-six windows on 2026-09-20, including a cadence slot.
const ENTRY_RE =
  /"SEK_per_kWh"\s*:\s*([-+0-9.eE]+)\s*,\s*"EUR_per_kWh"\s*:\s*[^,]+,\s*"EXR"\s*:\s*[^,]+,\s*"time_start"\s*:\s*"([^"]+)"\s*,\s*"time_end"\s*:\s*"([^"]+)"/g;

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

export function parseFeedBody(text: string): PriceWindow[] {
  const windows: PriceWindow[] = [];
  ENTRY_RE.lastIndex = 0;
  for (;;) {
    const match = ENTRY_RE.exec(text);
    if (!match) break;
    const sek = match[1];
    const timeStart = match[2];
    const timeEnd = match[3];
    if (sek === undefined || timeStart === undefined || timeEnd === undefined) {
      continue;
    }
    windows.push({ timeStart, timeEnd, sekPerKwh: sek });
  }
  return windows;
}

export function windowContaining(windows: PriceWindow[], at: Date): PriceWindow | null {
  const t = at.getTime();
  for (const w of windows) {
    const start = Date.parse(w.timeStart);
    const end = Date.parse(w.timeEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (t >= start && t < end) return w;
  }
  return null;
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
