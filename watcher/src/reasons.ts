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

const TEXT: Record<number, string> = {
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
};

export function reasonText(code: number): string {
  return TEXT[code] ?? "unknown";
}
