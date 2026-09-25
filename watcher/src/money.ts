/** Integer conversion from a spot price and a fixed kWh volume to mint base units.
 *
 * Nothing in this file uses IEEE floats. Prices arrive as decimal strings
 * taken from the feed body. Volume is millikWh. The mint uses 6 decimals.
 * amountBaseUnits treats 1 token as 1 SEK. amountBaseUnitsUsd converts that
 * SEK amount with the ECB USD and SEK rates, both quoted against EUR.
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

/** SEK spot converted to USD mint base units.
 *
 * floor(kwhMilli * sekPerKwhScaled * usdRateScaled * 10^mintDecimals
 *       / (10^3 * 10^8 * sekRateScaled))
 *
 * usd per sek is usdRate / sekRate. Both rates share a scale, so it cancels.
 */
export function amountBaseUnitsUsd(args: {
  kwhMilli: bigint;
  sekPerKwhScaled: bigint;
  usdRateScaled: bigint;
  sekRateScaled: bigint;
  mintDecimals: number;
}): bigint {
  if (args.kwhMilli <= 0n) {
    throw new Error("money.amountBaseUnitsUsd: kWh volume must be positive");
  }
  if (args.sekPerKwhScaled < 0n) {
    throw new Error("money.amountBaseUnitsUsd: negative price cannot become a charge");
  }
  if (args.usdRateScaled < 0n) {
    throw new Error("money.amountBaseUnitsUsd: negative USD rate cannot become a charge");
  }
  if (args.sekRateScaled <= 0n) {
    throw new Error("money.amountBaseUnitsUsd: SEK rate must be positive");
  }
  if (args.sekPerKwhScaled === 0n || args.usdRateScaled === 0n) {
    return 0n;
  }
  const numerator =
    args.kwhMilli * args.sekPerKwhScaled * args.usdRateScaled * pow10(args.mintDecimals);
  const denominator = pow10(KWH_MILLI_SCALE) * pow10(PRICE_SCALE) * args.sekRateScaled;
  return numerator / denominator;
}

/** USD per SEK as a decimal with exactly 8 places, floored by integer division. */
export function usdPerSekDecimal(usdRateScaled: bigint, sekRateScaled: bigint): string {
  if (sekRateScaled <= 0n) {
    throw new Error("money.usdPerSekDecimal: SEK rate must be positive");
  }
  if (usdRateScaled < 0n) {
    throw new Error("money.usdPerSekDecimal: USD rate must be non-negative");
  }
  const places = 8;
  const scaled = (usdRateScaled * pow10(places)) / sekRateScaled;
  const digits = scaled.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places);
  return `${whole}.${frac}`;
}

export type SpotQuoteCurrency = "SEK" | "USD";

/** SEK arithmetic when the currency is unset or SEK. USD only when asked, and only with both rates. */
export function amountBaseUnitsQuoted(args: {
  kwhMilli: bigint;
  sekPerKwhScaled: bigint;
  mintDecimals: number;
  quoteCurrency?: SpotQuoteCurrency;
  usdRateScaled?: bigint;
  sekRateScaled?: bigint;
}): bigint {
  if ((args.quoteCurrency ?? "SEK") !== "USD") {
    return amountBaseUnits({
      kwhMilli: args.kwhMilli,
      sekPerKwhScaled: args.sekPerKwhScaled,
      mintDecimals: args.mintDecimals,
    });
  }
  if (args.usdRateScaled === undefined || args.sekRateScaled === undefined) {
    throw new Error("money.amountBaseUnitsQuoted: USD quote needs both ECB rates");
  }
  return amountBaseUnitsUsd({
    kwhMilli: args.kwhMilli,
    sekPerKwhScaled: args.sekPerKwhScaled,
    usdRateScaled: args.usdRateScaled,
    sekRateScaled: args.sekRateScaled,
    mintDecimals: args.mintDecimals,
  });
}
