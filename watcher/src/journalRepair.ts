import { PublicKey } from "@solana/web3.js";
import { ledgerPda, mandatePda } from "./chain.js";
import type { JournalRow } from "./journal.js";
import { JsonlJournal } from "./journal.js";
import { reasonText } from "./reasons.js";

/** Marker so maxSettledNonce counts a paid row rebuilt from the ring. */
export const RECOVERED_SIGNATURE = "recovered-from-chain";

const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
const LEDGER_CAPACITY = 32;
const ENTRY_SIZE = 72;
const LEDGER_HEADER_SIZE = 40;
const KIND_PAID = 1;
const KIND_REFUSED = 2;

export type ChainDecision = {
  nonce: bigint;
  decision: "paid" | "refused";
  amount: bigint;
  ts: Date;
  reason: number;
  suggestedOverride: bigint;
};

export type AccountReader = {
  getAccountInfo(
    address: PublicKey,
    commitment?: "confirmed",
  ): Promise<{ data: Uint8Array | Buffer } | null>;
};

function readU64Le(buf: Uint8Array, offset: number): bigint {
  return Buffer.from(buf.subarray(offset, offset + 8)).readBigUInt64LE(0);
}

function readI64Le(buf: Uint8Array, offset: number): bigint {
  return Buffer.from(buf.subarray(offset, offset + 8)).readBigInt64LE(0);
}

function readU32Le(buf: Uint8Array, offset: number): number {
  return Buffer.from(buf.subarray(offset, offset + 4)).readUInt32LE(0);
}

function readU16Le(buf: Uint8Array, offset: number): number {
  return Buffer.from(buf.subarray(offset, offset + 2)).readUInt16LE(0);
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function decodeLedgerDecisions(data: Uint8Array): ChainDecision[] {
  if (data.length < 8 + LEDGER_HEADER_SIZE) {
    throw new Error("journal repair: ledger account is too small");
  }
  if (!buffersEqual(data.subarray(0, 8), LEDGER_DISCRIMINATOR)) {
    throw new Error("journal repair: account is not a Ledger");
  }
  const body = data.subarray(8);
  const total = readU32Le(body, 32);
  const head = readU16Le(body, 36);
  const occupied = Math.min(total, LEDGER_CAPACITY);
  const start = total >= LEDGER_CAPACITY ? head % LEDGER_CAPACITY : 0;
  const out: ChainDecision[] = [];
  for (let i = 0; i < occupied; i++) {
    const idx = (start + i) % LEDGER_CAPACITY;
    const off = LEDGER_HEADER_SIZE + idx * ENTRY_SIZE;
    const raw = body.subarray(off, off + ENTRY_SIZE);
    if (raw.length < ENTRY_SIZE) continue;
    const kind = raw[64] ?? 0;
    if (kind !== KIND_PAID && kind !== KIND_REFUSED) continue;
    const tsUnix = readI64Le(raw, 0);
    const reason = raw[65] ?? 0;
    out.push({
      nonce: readU64Le(raw, 48),
      decision: kind === KIND_PAID ? "paid" : "refused",
      amount: readU64Le(raw, 8),
      ts: new Date(Number(tsUnix) * 1000),
      reason,
      suggestedOverride: readU64Le(raw, 56),
    });
  }
  return out;
}

export async function fetchChainDecisions(args: {
  connection: AccountReader;
  programId: PublicKey;
  owner: PublicKey;
  mandateId: bigint;
}): Promise<ChainDecision[]> {
  const mandate = mandatePda(args.programId, args.owner, args.mandateId);
  const ledger = ledgerPda(args.programId, mandate);
  const info = await args.connection.getAccountInfo(ledger, "confirmed");
  if (info === null) return [];
  return decodeLedgerDecisions(info.data);
}

export function chainDecisionToRow(entry: ChainDecision): JournalRow {
  const windowStart = new Date(Number(entry.nonce) * 1000).toISOString();
  return {
    ts: entry.ts.toISOString(),
    window_start: windowStart,
    window_end: null,
    sek_per_kwh: null,
    kwh_milli: "0",
    amount: entry.amount.toString(),
    nonce: entry.nonce.toString(),
    decision: entry.decision,
    reason: reasonText(entry.reason),
    reason_code: entry.reason,
    signature: RECOVERED_SIGNATURE,
    suggested_override: entry.suggestedOverride === 0n ? null : entry.suggestedOverride.toString(),
  };
}

/** Fill missing paid and refused rows from the on-chain ring so processWindow
 * can reuse hasNonce and the overtaken-window skip. Returns how many rows
 * were appended. */
export function repairJournalFromChain(journal: JsonlJournal, entries: ChainDecision[]): number {
  let n = 0;
  for (const entry of entries) {
    if (journal.hasNonce(entry.nonce)) continue;
    journal.append(chainDecisionToRow(entry));
    n += 1;
  }
  return n;
}
