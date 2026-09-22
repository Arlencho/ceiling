/** Quoting for the merchant terminal.
 *
 * All arithmetic is imported from the watcher: the same feed parsing, the same
 * integer money conversion, the same charge nonce. Nothing here parses a
 * price into a float, and every amount is a bigint of mint base units.
 */

import type { PriceWindow } from "../../watcher/src/feed.js";
import { amountBaseUnits, sekPerKwhToScaled } from "../../watcher/src/money.js";
import { nonceFromSlot } from "../../watcher/src/nonce.js";

export type Quote = {
  windowStart: string;
  windowEnd: string;
  sekPerKwh: string;
  kwhMilli: bigint;
  amount: bigint;
  nonce: bigint;
};

/** Price a fixed kWh volume for one feed window.
 *
 * Returns null when the fetched price cannot become a charge (negative or
 * zero amount), matching the watcher's skip rule. An unreadable price throws,
 * because a quote built on a guessed number is worse than no quote.
 */
export function quoteForWindow(args: {
  window: PriceWindow;
  kwhMilli: bigint;
  mintDecimals: number;
}): Quote | null {
  const scaled = sekPerKwhToScaled(args.window.sekPerKwh);
  if (scaled < 0n) return null;
  const amount = amountBaseUnits({
    kwhMilli: args.kwhMilli,
    sekPerKwhScaled: scaled,
    mintDecimals: args.mintDecimals,
  });
  if (amount === 0n) return null;
  return {
    windowStart: args.window.timeStart,
    windowEnd: args.window.timeEnd,
    sekPerKwh: args.window.sekPerKwh,
    kwhMilli: args.kwhMilli,
    amount,
    nonce: nonceFromSlot(args.window.timeStart),
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
