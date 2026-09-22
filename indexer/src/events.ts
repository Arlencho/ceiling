import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  buffersEqual,
  CHARGE_IX_DISC,
  KIND_PAID,
  PAID_EVENT_DISC,
  reasonText,
  readU64Le,
  REFUSED_EVENT_DISC,
} from "./constants.js";
import type { CompiledIx, Decision, DecisionKind, TxView } from "./types.js";

const PROGRAM_DATA = /^Program data: ([A-Za-z0-9+/=]+)$/;

export type DecodedEvent = {
  kind: DecisionKind;
  kindCode: number;
  mandate: string;
  amount: bigint;
  nonce: bigint;
  reason: number;
  suggestedOverride: bigint;
};

export function decodeEventsFromLogs(logs: readonly string[]): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const line of logs) {
    const match = PROGRAM_DATA.exec(line);
    if (!match?.[1]) continue;
    const raw = Buffer.from(match[1], "base64");
    const event = decodeEventBytes(raw);
    if (event) out.push(event);
  }
  return out;
}

export function decodeEventBytes(raw: Uint8Array): DecodedEvent | null {
  if (raw.length < 8) return null;
  const disc = raw.subarray(0, 8);
  if (buffersEqual(disc, PAID_EVENT_DISC)) {
    if (raw.length < 64) return null;
    return {
      kind: "paid",
      kindCode: KIND_PAID,
      mandate: new PublicKey(raw.subarray(8, 40)).toBase58(),
      amount: readU64Le(raw, 40),
      nonce: readU64Le(raw, 48),
      reason: 0,
      suggestedOverride: 0n,
    };
  }
  if (buffersEqual(disc, REFUSED_EVENT_DISC)) {
    if (raw.length < 65) return null;
    return {
      kind: "refused",
      kindCode: 2,
      mandate: new PublicKey(raw.subarray(8, 40)).toBase58(),
      amount: readU64Le(raw, 40),
      nonce: readU64Le(raw, 48),
      reason: raw[56] ?? 0,
      suggestedOverride: readU64Le(raw, 57),
    };
  }
  return null;
}

export function decodeIxData(data: string | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  try {
    return Buffer.from(bs58.decode(data));
  } catch {
    return Buffer.alloc(0);
  }
}

export function isChargeIx(ix: CompiledIx): boolean {
  return ix.data.length >= 8 && buffersEqual(ix.data.subarray(0, 8), CHARGE_IX_DISC);
}

export function counterpartyFromCharge(tx: TxView, mandate: string): string {
  for (const ix of tx.instructions) {
    if (!isChargeIx(ix)) continue;
    if (ix.accounts.length < 5) continue;
    if (ix.accounts[1] === mandate || ix.accounts.includes(mandate)) {
      return ix.accounts[4] ?? "";
    }
  }
  const charge = tx.instructions.find(isChargeIx);
  return charge?.accounts[4] ?? "";
}

export function decisionsFromTx(tx: TxView, programId: string, mandateFilter?: string): Decision[] {
  if (tx.err) return [];
  const events = decodeEventsFromLogs(tx.logs);
  if (events.length > 0) {
    const out: Decision[] = [];
    for (const event of events) {
      if (mandateFilter && event.mandate !== mandateFilter) continue;
      out.push({
        signature: tx.signature,
        slot: tx.slot,
        timestamp: tx.blockTime,
        mandate: event.mandate,
        amount: event.amount,
        nonce: event.nonce,
        counterparty: counterpartyFromCharge(tx, event.mandate),
        kind: event.kind,
        reason: event.reason,
        reasonText: reasonText(event.reason),
        suggestedOverride: event.suggestedOverride,
      });
    }
    return out;
  }
  const fromLog = decisionFromChargeLog(tx, programId);
  if (!fromLog) return [];
  if (mandateFilter && fromLog.mandate !== mandateFilter) return [];
  return [fromLog];
}

// A charge that landed before event logs were available, or a fixture that
// only kept the text line, still names one decision. Program data wins when
// both are present, so a normal charge is not counted twice.
function decisionFromChargeLog(tx: TxView, programId: string): Decision | null {
  const parsed = parseVetoTextLog(tx.logs);
  if (!parsed) return null;
  const charge = tx.instructions.find(
    (ix) => ix.programId === programId && isChargeIx(ix) && ix.accounts.length >= 5 && ix.data.length >= 24,
  );
  if (!charge) return null;
  const amount = readU64Le(charge.data, 8);
  const nonce = readU64Le(charge.data, 16);
  if (amount !== parsed.amount) return null;
  const mandate = charge.accounts[1] ?? "";
  if (mandate.length === 0) return null;
  return {
    signature: tx.signature,
    slot: tx.slot,
    timestamp: tx.blockTime,
    mandate,
    amount,
    nonce,
    counterparty: charge.accounts[4] ?? "",
    kind: parsed.kind,
    reason: parsed.reason,
    reasonText: reasonText(parsed.reason),
    suggestedOverride: parsed.suggestedOverride,
  };
}

function parseVetoTextLog(logs: readonly string[]): {
  kind: DecisionKind;
  reason: number;
  amount: bigint;
  suggestedOverride: bigint;
} | null {
  for (const line of logs) {
    const paid = /VETO PAID amount=(\d+)/.exec(line);
    if (paid?.[1]) {
      return { kind: "paid", reason: 0, amount: BigInt(paid[1]), suggestedOverride: 0n };
    }
    const refused = /VETO REFUSED reason=(\d+) \([^)]*\) amount=(\d+).*override_to_clear=(\d+)/.exec(line);
    if (refused?.[1] && refused[2] && refused[3]) {
      return {
        kind: "refused",
        reason: Number.parseInt(refused[1], 10),
        amount: BigInt(refused[2]),
        suggestedOverride: BigInt(refused[3]),
      };
    }
  }
  return null;
}

export function encodePaidLog(args: {
  mandate: PublicKey;
  amount: bigint;
  nonce: bigint;
  spent: bigint;
}): string {
  const raw = Buffer.concat([
    PAID_EVENT_DISC,
    args.mandate.toBuffer(),
    u64(args.amount),
    u64(args.nonce),
    u64(args.spent),
  ]);
  return `Program data: ${raw.toString("base64")}`;
}

export function encodeRefusedLog(args: {
  mandate: PublicKey;
  amount: bigint;
  nonce: bigint;
  reason: number;
  suggestedOverride: bigint;
}): string {
  const raw = Buffer.concat([
    REFUSED_EVENT_DISC,
    args.mandate.toBuffer(),
    u64(args.amount),
    u64(args.nonce),
    Buffer.from([args.reason & 0xff]),
    u64(args.suggestedOverride),
  ]);
  return `Program data: ${raw.toString("base64")}`;
}

function u64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}
