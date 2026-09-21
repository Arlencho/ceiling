/** Integer conversion from a spot price and a fixed kWh volume to mint base units.
 *
 * Nothing in this file uses IEEE floats. Prices arrive as decimal strings
 * taken from the feed body. Volume is millikWh. The mint uses 6 decimals,
 * matching the test SPL mint in docs/DEVNET.md, so 1 token is treated as 1 SEK.
 */

import { plainDecimal } from "./feed.js";

export const PRICE_SCALE = 8;
export const KWH_MILLI_SCALE = 3;
export const DEFAULT_KWH_MILLI = 50_000n;
export const DEFAULT_MINT_DECIMALS = 6;

export function parseDecimalToScaled(raw: string, scale: number): bigint {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("money.parseDecimalToScaled: empty decimal");
  }
  if (/[eE]/.test(trimmed)) {
    throw new Error(`money.parseDecimalToScaled: scientific notation is not allowed: ${trimmed}`);
  }

  let sign = 1n;
  let body = trimmed;
  if (body.startsWith("-")) {
    sign = -1n;
    body = body.slice(1);
  } else if (body.startsWith("+")) {
    body = body.slice(1);
  }

  const parts = body.split(".");
  if (parts.length > 2) {
    throw new Error(`money.parseDecimalToScaled: bad decimal: ${trimmed}`);
  }
  const wholeRaw = parts[0] ?? "";
  const fracRaw = parts[1] ?? "";
  if (!/^\d*$/.test(wholeRaw) || !/^\d*$/.test(fracRaw)) {
    throw new Error(`money.parseDecimalToScaled: bad decimal: ${trimmed}`);
  }
  if (wholeRaw.length === 0 && fracRaw.length === 0) {
    throw new Error(`money.parseDecimalToScaled: bad decimal: ${trimmed}`);
  }

  const wholeDigits = wholeRaw.length === 0 ? "0" : wholeRaw;
  let fracDigits = fracRaw;
  if (fracDigits.length > scale) {
    fracDigits = fracDigits.slice(0, scale);
  } else {
    fracDigits = fracDigits.padEnd(scale, "0");
  }

  const magnitude = BigInt(wholeDigits) * 10n ** BigInt(scale) + BigInt(fracDigits);
  return sign * magnitude;
}

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`money.pow10: scale must be a non-negative integer: ${n}`);
  }
  return 10n ** BigInt(n);
}

/** Convert millikWh * SEK/kWh into mint base units, rounding down leftover subunits. */
export function amountBaseUnits(args: {
  kwhMilli: bigint;
  sekPerKwhScaled: bigint;
  mintDecimals: number;
}): bigint {
  if (args.kwhMilli <= 0n) {
    throw new Error("money.amountBaseUnits: kWh volume must be positive");
  }
  if (args.sekPerKwhScaled < 0n) {
    throw new Error("money.amountBaseUnits: negative price cannot become a charge");
  }
  if (args.sekPerKwhScaled === 0n) {
    return 0n;
  }
  const numerator =
    args.kwhMilli * args.sekPerKwhScaled * pow10(args.mintDecimals);
  const denominator = pow10(KWH_MILLI_SCALE) * pow10(PRICE_SCALE);
  return numerator / denominator;
}

export function sekPerKwhToScaled(sekPerKwh: string): bigint {
  return parseDecimalToScaled(plainDecimal(sekPerKwh), PRICE_SCALE);
}
