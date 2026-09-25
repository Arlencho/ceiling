/** Quoting for the merchant terminal.
 *
 * All arithmetic is imported from the watcher: the same feed parsing, the same
 * integer money conversion, the same charge nonce. Nothing here parses a
 * price into a float, and every amount is a bigint of mint base units.
 */

import type { PriceWindow } from "../../watcher/src/feed.js";
import type { FxQuote } from "../../watcher/src/fx.js";
import { amountBaseUnitsQuoted, sekPerKwhToScaled, usdPerSekDecimal } from "../../watcher/src/money.js";
import { nonceFromSlot, nonceFromWindowStart } from "../../watcher/src/nonce.js";

export const USD_TOKEN_SYMBOL = "USDC";

export type Quote = {
  windowStart: string;
  windowEnd: string;
  sekPerKwh: string;
  kwhMilli: bigint;
  amount: bigint;
  /** Cadence slot being quoted. Null when the feed window does not start on that slot. */
  nonce: bigint | null;
  /** "USDC" when the amount was converted. "tokens" keeps the historical SEK label. */
  tokenSymbol: string;
  quoteCurrency: "SEK" | "USD";
  fxRate: string | null;
  fxDate: string | null;
  fxSource: string | null;
};

/** Price a fixed kWh volume for one feed window.
 *
 * Returns null when the fetched price cannot become a charge (negative or
 * zero amount), matching the watcher's skip rule. An unreadable price throws,
 * because a quote built on a guessed number is worse than no quote.
 *
 * `at` is the cadence instant being acted on. The nonce is that slot, never
 * the feed window. A window that does not start on the slot carries no nonce.
 */
export function quoteForWindow(args: {
  window: PriceWindow;
  kwhMilli: bigint;
  mintDecimals: number;
  at: Date | string;
  /** When set, the amount is USDC from the shared watcher conversion. Omit to keep SEK units. */
  fx?: FxQuote;
}): Quote | null {
  const scaled = sekPerKwhToScaled(args.window.sekPerKwh);
  if (scaled < 0n) return null;
  const amount = amountBaseUnitsQuoted({
    kwhMilli: args.kwhMilli,
    sekPerKwhScaled: scaled,
    mintDecimals: args.mintDecimals,
    quoteCurrency: args.fx ? "USD" : "SEK",
    usdRateScaled: args.fx?.usdRateScaled,
    sekRateScaled: args.fx?.sekRateScaled,
  });
  if (amount === 0n) return null;
  const slot = nonceFromSlot(args.at);
  const startsOnSlot = nonceFromWindowStart(args.window.timeStart) === slot;
  return {
    windowStart: args.window.timeStart,
    windowEnd: args.window.timeEnd,
    sekPerKwh: args.window.sekPerKwh,
    kwhMilli: args.kwhMilli,
    amount,
    nonce: startsOnSlot ? slot : null,
    tokenSymbol: args.fx ? USD_TOKEN_SYMBOL : "tokens",
    quoteCurrency: args.fx ? "USD" : "SEK",
    fxRate: args.fx ? usdPerSekDecimal(args.fx.usdRateScaled, args.fx.sekRateScaled) : null,
    fxDate: args.fx ? args.fx.fixingDate : null,
    fxSource: args.fx ? args.fx.sourceUrl : null,
  };
}

/** Render integer base units as a decimal string. Pure string math, no float. */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`terminal.formatBaseUnits: decimals must be a non-negative integer: ${decimals}`);
  }
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac.length > 0 ? `.${frac}` : ""}`;
}

/** Render a millikWh volume as kWh. */
export function formatKwh(kwhMilli: bigint): string {
  return formatBaseUnits(kwhMilli, 3);
}
