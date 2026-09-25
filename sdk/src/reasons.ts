/** Reason codes as the program writes them. Zero means the charge was paid. */
export const REASON_OK = 0;
export const REASON_NOT_ACTIVE = 1;
export const REASON_EXPIRED = 2;
export const REASON_STALE_NONCE = 3;
export const REASON_MERCHANT_NOT_ALLOWED = 4;
export const REASON_OVER_PER_TX_MAX = 5;
export const REASON_OVER_CAP = 6;
export const REASON_DELEGATE_MISSING = 7;
export const REASON_INSUFFICIENT_FUNDS = 8;
export const REASON_ZERO_AMOUNT = 9;
export const REASON_ACCOUNT_FROZEN = 10;
export const REASON_OUTPUT_ACCOUNT_NOT_ALLOWED = 11;
export const REASON_POOL_NOT_ALLOWED = 12;
export const REASON_OVER_DAILY_LIMIT = 13;
export const REASON_QUOTE_BELOW_FLOOR = 14;

/** Texts copied from app/lib/constants.ts. A drift test fails if they diverge. */
export const REASON_TEXT: Readonly<Record<number, string>> = Object.freeze({
  [REASON_OK]: "ok",
  [REASON_NOT_ACTIVE]: "mandate not active",
  [REASON_EXPIRED]: "past expiry",
  [REASON_STALE_NONCE]: "nonce already settled",
  [REASON_MERCHANT_NOT_ALLOWED]: "merchant not allowed",
  [REASON_OVER_PER_TX_MAX]: "over per-payment maximum",
  [REASON_OVER_CAP]: "over remaining cap",
  [REASON_DELEGATE_MISSING]: "delegation withdrawn",
  [REASON_INSUFFICIENT_FUNDS]: "insufficient funds",
  [REASON_ZERO_AMOUNT]: "zero amount",
  [REASON_ACCOUNT_FROZEN]: "account frozen",
  [REASON_OUTPUT_ACCOUNT_NOT_ALLOWED]: "output account not allowed",
  [REASON_POOL_NOT_ALLOWED]: "pool account not allowed",
  [REASON_OVER_DAILY_LIMIT]: "over daily limit",
  [REASON_QUOTE_BELOW_FLOOR]: "quote below floor",
});

export function reasonText(reason: number): string {
  return REASON_TEXT[reason] ?? "unknown";
}
