import { Buffer } from 'buffer';

export const PURPOSE_MAX_LEN = 64;
export const LEDGER_CAPACITY = 32;
export const ENTRY_SIZE = 72;
export const LEDGER_HEADER_SIZE = 40;
export const LEDGER_ACCOUNT_SIZE = 8 + LEDGER_HEADER_SIZE + LEDGER_CAPACITY * ENTRY_SIZE;
// Discriminator plus Mandate::INIT_SPACE. Live mandates are this size.
export const MANDATE_ACCOUNT_SIZE = 310;
// One signature's base fee. Rent for the new accounts does not pay it.
export const OPEN_FEE_MARGIN_LAMPORTS = 5_000;

export const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
export const MANDATE_DISCRIMINATOR = Buffer.from([113, 216, 98, 159, 185, 63, 55, 18]);

export const OPEN_MANDATE_DISC = Buffer.from([116, 145, 190, 28, 86, 223, 105, 74]);
export const REVOKE_MANDATE_DISC = Buffer.from([252, 97, 140, 119, 67, 43, 177, 108]);
export const CLOSE_MANDATE_DISC = Buffer.from([117, 87, 189, 5, 254, 125, 248, 180]);
export const GRANT_OVERRIDE_DISC = Buffer.from([225, 146, 123, 110, 56, 16, 99, 141]);
export const CHARGE_IX_DISC = Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]);

export const PAID_EVENT_DISC = Buffer.from([240, 193, 17, 238, 238, 210, 129, 235]);
export const REFUSED_EVENT_DISC = Buffer.from([230, 49, 133, 208, 106, 62, 106, 169]);

export const STATUS_ACTIVE = 0;
export const STATUS_REVOKED = 1;
export const STATUS_EXHAUSTED = 2;
export const STATUS_EXPIRED = 3;

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
export const REASON_ACCOUNT_FROZEN = 10;

export const KIND_NAME: Record<number, string> = {
  [KIND_OPENED]: 'opened',
  [KIND_PAID]: 'paid',
  [KIND_REFUSED]: 'refused',
  [KIND_OVERRIDE]: 'override',
  [KIND_REVOKED]: 'revoked',
};

export const REASON_TEXT: Record<number, string> = {
  [REASON_OK]: 'ok',
  [REASON_NOT_ACTIVE]: 'mandate not active',
  [REASON_EXPIRED]: 'past expiry',
  [REASON_STALE_NONCE]: 'nonce already settled',
  [REASON_MERCHANT_NOT_ALLOWED]: 'merchant not allowed',
  [REASON_OVER_PER_TX_MAX]: 'over per-payment maximum',
  [REASON_OVER_CAP]: 'over remaining cap',
  [REASON_DELEGATE_MISSING]: 'delegation withdrawn',
  [REASON_INSUFFICIENT_FUNDS]: 'insufficient funds',
  [REASON_ZERO_AMOUNT]: 'zero amount',
  [REASON_ACCOUNT_FROZEN]: 'account frozen',
};

export const STATUS_NAME: Record<number, string> = {
  [STATUS_ACTIVE]: 'active',
  [STATUS_REVOKED]: 'revoked',
  [STATUS_EXHAUSTED]: 'exhausted',
  [STATUS_EXPIRED]: 'expired',
};

export function kindName(kind: number): string {
  return KIND_NAME[kind] ?? `kind:${kind}`;
}

export function reasonText(reason: number): string {
  return REASON_TEXT[reason] ?? 'unknown';
}

export function statusName(status: number): string {
  return STATUS_NAME[status] ?? `status:${status}`;
}

function viewAt(buf: Uint8Array, offset: number, length: number): DataView {
  return new DataView(buf.buffer, buf.byteOffset + offset, length);
}

export function writeU64Le(buf: Uint8Array, offset: number, value: bigint): void {
  viewAt(buf, offset, 8).setBigUint64(0, value, true);
}

export function writeI64Le(buf: Uint8Array, offset: number, value: bigint): void {
  viewAt(buf, offset, 8).setBigInt64(0, value, true);
}

export function writeU32Le(buf: Uint8Array, offset: number, value: number): void {
  viewAt(buf, offset, 4).setUint32(0, value, true);
}

export function u64Le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  writeU64Le(buf, 0, value);
  return buf;
}

export function readU64Le(buf: Uint8Array, offset: number): bigint {
  return viewAt(buf, offset, 8).getBigUint64(0, true);
}

export function readI64Le(buf: Uint8Array, offset: number): bigint {
  return viewAt(buf, offset, 8).getBigInt64(0, true);
}

export function readU32Le(buf: Uint8Array, offset: number): number {
  return viewAt(buf, offset, 4).getUint32(0, true);
}

export function readU16Le(buf: Uint8Array, offset: number): number {
  return viewAt(buf, offset, 2).getUint16(0, true);
}

export function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
