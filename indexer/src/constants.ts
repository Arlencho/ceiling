import { PublicKey } from "@solana/web3.js";

export const DEFAULT_PROGRAM_ID = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
export const DEFAULT_RPC = "http://127.0.0.1:8999";
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export const LEDGER_CAPACITY = 32;
export const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
export const ENTRY_SIZE = 72;
export const LEDGER_HEADER_SIZE = 40;
export const LEDGER_ACCOUNT_SIZE = 8 + LEDGER_HEADER_SIZE + LEDGER_CAPACITY * ENTRY_SIZE;

export const KIND_OPENED = 0;
export const KIND_PAID = 1;
export const KIND_REFUSED = 2;
export const KIND_OVERRIDE = 3;
export const KIND_REVOKED = 4;

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

export const PAID_EVENT_DISC = Buffer.from([240, 193, 17, 238, 238, 210, 129, 235]);
export const REFUSED_EVENT_DISC = Buffer.from([230, 49, 133, 208, 106, 62, 106, 169]);
export const CHARGE_IX_DISC = Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]);

export const KIND_NAME: Record<number, string> = {
  [KIND_OPENED]: "opened",
  [KIND_PAID]: "paid",
  [KIND_REFUSED]: "refused",
  [KIND_OVERRIDE]: "override",
  [KIND_REVOKED]: "revoked",
};

export const REASON_TEXT: Record<number, string> = {
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

export function kindName(kind: number): string {
  return KIND_NAME[kind] ?? `kind:${kind}`;
}

export function reasonText(reason: number): string {
  return REASON_TEXT[reason] ?? "unknown";
}

export function u64Le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function readU64Le(buf: Uint8Array, offset: number): bigint {
  return Buffer.from(buf.subarray(offset, offset + 8)).readBigUInt64LE(0);
}

export function readI64Le(buf: Uint8Array, offset: number): bigint {
  return Buffer.from(buf.subarray(offset, offset + 8)).readBigInt64LE(0);
}

export function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
