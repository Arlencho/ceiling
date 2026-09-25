/** European Central Bank daily reference rates. Public, no key.
 *
 * The document is one XML file: one Cube time="YYYY-MM-DD", one Cube
 * currency="USD", and one Cube currency="SEK". Both rates are units of that
 * currency per euro. USD per SEK is the USD rate divided by the SEK rate.
 * Parsing is a small regex. There is no XML library and no float.
 */

import { stockholmYmd } from "./feed.js";
import { parseDecimalToScaled } from "./money.js";

export const ECB_FX_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/** ECB rates are stored at 6 decimal places. */
export const FX_RATE_SCALE = 6;

/** Friday's fixing serves the weekend and Monday morning, plus one spare day. */
export const FX_MAX_CALENDAR_DAYS = 4;

export type FxFailureKind = "unreachable" | "http_error" | "malformed" | "missing_currency";

export type FxQuote = {
  usdRateScaled: bigint;
  sekRateScaled: bigint;
  fixingDate: string;
  sourceUrl: string;
};

export type FxRead =
  | { ok: true; quote: FxQuote }
  | { ok: false; kind: FxFailureKind; sourceUrl: string; httpStatus: number | null };

export type FxSource = {
  read(at: Date): Promise<FxRead>;
};

type Ymd = { y: number; m: number; d: number };

function digits(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    n = n * 10 + (text.charCodeAt(i) - 48);
  }
  return n;
}

function div(n: number, d: number): number {
  return (n - (n % d)) / d;
}

function isLeap(y: number): boolean {
  if (y % 400 === 0) return true;
  if (y % 100 === 0) return false;
  return y % 4 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
  return 31;
}

export function parseCalendarDate(ymd: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (m === null) return null;
  const yearText = m[1];
  const monthText = m[2];
  const dayText = m[3];
  if (yearText === undefined || monthText === undefined || dayText === undefined) return null;
  const y = digits(yearText);
  const month = digits(monthText);
  const d = digits(dayText);
  if (month < 1 || month > 12) return null;
  if (d < 1 || d > daysInMonth(y, month)) return null;
  return { y, m: month, d };
}

function julianDay(y: number, m: number, d: number): number {
  const a = div(14 - m, 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + div(153 * mm + 2, 5) + 365 * yy + div(yy, 4) - div(yy, 100) + div(yy, 400) - 32045;
}

/** Calendar days from earlier to later. Negative when later comes first. */
export function calendarDaysBetween(earlierYmd: string, laterYmd: string): number | null {
  const earlier = parseCalendarDate(earlierYmd);
  const later = parseCalendarDate(laterYmd);
  if (earlier === null || later === null) return null;
  return julianDay(later.y, later.m, later.d) - julianDay(earlier.y, earlier.m, earlier.d);
}

/** True when the fixing is the slot's Stockholm date, or up to 4 calendar days before it. */
export function fxFixingIsFresh(fixingDate: string, slot: Date): boolean {
  const parts = stockholmYmd(slot);
  const slotYmd = `${parts.yyyy}-${parts.mm}-${parts.dd}`;
  const age = calendarDaysBetween(fixingDate, slotYmd);
  return age !== null && age >= 0 && age <= FX_MAX_CALENDAR_DAYS;
}

function attributeMap(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:'([^']*)'|"([^"]*)")/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const name = match[1];
    const value = match[2] !== undefined ? match[2] : match[3];
    if (name === undefined || value === undefined) continue;
    out.set(name, value);
  }
  return out;
}

function cubeTags(text: string): Array<Map<string, string>> {
  const tags: Array<Map<string, string>> = [];
  const re = /<Cube\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tags.push(attributeMap(match[1] ?? ""));
  }
  return tags;
}

function currencyRate(tags: Array<Map<string, string>>, currency: string): "missing" | "bad" | string {
  let found: string | null = null;
  for (const tag of tags) {
    if (tag.get("currency") !== currency) continue;
    const rate = tag.get("rate");
    if (rate === undefined || rate.length === 0) return "bad";
    if (found !== null && found !== rate) return "bad";
    found = rate;
  }
  return found === null ? "missing" : found;
}

function scaledRate(raw: string): bigint | null {
  try {
    const scaled = parseDecimalToScaled(raw, FX_RATE_SCALE);
    if (scaled <= 0n) return null;
    return scaled;
  } catch {
    return null;
  }
}

/** Parse one daily reference document. Does not fetch. */
export function parseEcbDailyXml(text: string, sourceUrl: string = ECB_FX_URL): FxRead {
  const tags = cubeTags(text);
  const dates: string[] = [];
  for (const tag of tags) {
    const time = tag.get("time");
    if (time === undefined) continue;
    if (!dates.includes(time)) dates.push(time);
  }
  if (dates.length !== 1) {
    return { ok: false, kind: "malformed", sourceUrl, httpStatus: null };
  }
  const fixingDate = dates[0];
  if (fixingDate === undefined || parseCalendarDate(fixingDate) === null) {
    return { ok: false, kind: "malformed", sourceUrl, httpStatus: null };
  }

  const usdRaw = currencyRate(tags, "USD");
  const sekRaw = currencyRate(tags, "SEK");
  if (usdRaw === "bad" || sekRaw === "bad") {
    return { ok: false, kind: "malformed", sourceUrl, httpStatus: null };
  }
  if (usdRaw === "missing" || sekRaw === "missing") {
    return { ok: false, kind: "missing_currency", sourceUrl, httpStatus: null };
  }

  const usdRateScaled = scaledRate(usdRaw);
  const sekRateScaled = scaledRate(sekRaw);
  if (usdRateScaled === null || sekRateScaled === null) {
    return { ok: false, kind: "malformed", sourceUrl, httpStatus: null };
  }

  return {
    ok: true,
    quote: { usdRateScaled, sekRateScaled, fixingDate, sourceUrl },
  };
}

export class EcbFxFeed implements FxSource {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async read(_at: Date): Promise<FxRead> {
    try {
      const res = await this.fetchImpl(ECB_FX_URL, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) {
        return { ok: false, kind: "http_error", sourceUrl: ECB_FX_URL, httpStatus: res.status };
      }
      return parseEcbDailyXml(await res.text(), ECB_FX_URL);
    } catch {
      return { ok: false, kind: "unreachable", sourceUrl: ECB_FX_URL, httpStatus: null };
    }
  }
}

/** A thrown read is the same outage as a failed connection: no rate is invented. */
export async function readFxOrUnreachable(fx: FxSource | undefined, at: Date): Promise<FxRead> {
  if (fx === undefined) {
    return { ok: false, kind: "unreachable", sourceUrl: ECB_FX_URL, httpStatus: null };
  }
  try {
    return await fx.read(at);
  } catch {
    return { ok: false, kind: "unreachable", sourceUrl: ECB_FX_URL, httpStatus: null };
  }
}
