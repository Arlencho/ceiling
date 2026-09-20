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

export interface PriceFeed {
  getWindow(at: Date): Promise<PriceWindow | null>;
}

export const FEED_ORIGIN = "https://www.elprisetjustnu.se";

const ENTRY_RE =
  /"SEK_per_kWh"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"EUR_per_kWh"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"EXR"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"time_start"\s*:\s*"([^"]+)"\s*,\s*"time_end"\s*:\s*"([^"]+)"/g;

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
    const timeStart = match[4];
    const timeEnd = match[5];
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

export class EnergySpotFeed implements PriceFeed {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async getWindow(at: Date): Promise<PriceWindow | null> {
    const url = feedUrlFor(at);
    let text = this.cache.get(url);
    if (text === undefined) {
      try {
        const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) {
          return null;
        }
        text = await res.text();
        this.cache.set(url, text);
      } catch {
        return null;
      }
    }
    return windowContaining(parseFeedBody(text), at);
  }
}
