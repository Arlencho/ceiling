import { PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { chargeFromTx, ledgerPda, mandatePda } from "./chain.js";
import type { JournalRow } from "./journal.js";
import { JsonlJournal } from "./journal.js";
import { logError } from "./log.js";
import { parseChargeLogs } from "./parse.js";
import { reasonText } from "./reasons.js";

/** Marker so maxSettledNonce counts a paid row rebuilt from the ring. */
export const RECOVERED_SIGNATURE = "recovered-from-chain";

const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
const LEDGER_CAPACITY = 32;
const ENTRY_SIZE = 72;
const LEDGER_HEADER_SIZE = 40;
const KIND_PAID = 1;
const KIND_REFUSED = 2;

/** The account bytes are not a ledger. Retrying the read will not change that. */
export class LedgerDecodeError extends Error {
  readonly account: string;

  constructor(account: string, reason?: string) {
    const tail = reason === undefined || reason.length === 0 ? "" : `: ${reason}`;
    super(`journal repair: account ${account} is not a Ledger${tail}`);
    this.name = "LedgerDecodeError";
    this.account = account;
  }
}

export type ChainDecision = {
  nonce: bigint;
  decision: "paid" | "refused";
  amount: bigint;
  ts: Date;
  reason: number;
  suggestedOverride: bigint;
  /** Set when the history walk read this decision from its transaction. */
  signature?: string;
};

type SignaturePage = {
  signature: string;
  err: unknown;
  blockTime?: number | null;
};

type HistoryConnection = AccountReader & {
  getSignaturesForAddress(
    address: PublicKey,
    config?: { limit?: number; before?: string },
  ): Promise<readonly SignaturePage[]>;
  getTransaction(
    signature: string,
    config?: { commitment?: "confirmed"; maxSupportedTransactionVersion?: number },
  ): Promise<VersionedTransactionResponse | null>;
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

export function decodeLedgerDecisions(data: Uint8Array, account = "ledger"): ChainDecision[] {
  if (data.length < 8 + LEDGER_HEADER_SIZE) {
    throw new LedgerDecodeError(account, "ledger account is too small");
  }
  if (!buffersEqual(data.subarray(0, 8), LEDGER_DISCRIMINATOR)) {
    throw new LedgerDecodeError(account);
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

function canWalk(connection: AccountReader): connection is HistoryConnection {
  const candidate = connection as HistoryConnection;
  return (
    typeof candidate.getSignaturesForAddress === "function" &&
    typeof candidate.getTransaction === "function"
  );
}

function walkError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Decisions whose transaction the mandate walk could read. A signature here
 * is the transaction's own. If listing signatures fails, the walk stops and
 * returns what it already read. One transaction that cannot be fetched is
 * skipped. The caller fills every gap from the ring.
 *
 * `missing` is the set of ring nonces the journal does not hold. When it is
 * set, the walk stops once every one of them is in `found` (newest first, so
 * the first hit for a nonce is the row that is kept). When it is omitted, the
 * walk reads the whole history. */
async function decisionsFromMandateHistory(
  connection: HistoryConnection,
  programId: PublicKey,
  mandate: PublicKey,
  missing?: ReadonlySet<string>,
): Promise<ChainDecision[]> {
  const found = new Map<string, ChainDecision>();
  const outstanding = missing === undefined ? null : new Set(missing);
  let before: string | undefined;
  const pageSize = 200;
  for (let page = 0; page < 50; page += 1) {
    if (outstanding !== null && outstanding.size === 0) break;
    let sigs: readonly SignaturePage[];
    try {
      sigs = await connection.getSignaturesForAddress(mandate, { limit: pageSize, before });
    } catch (err) {
      logError(`journal repair: history walk stopped, remaining rows keep the ring: ${walkError(err)}`);
      break;
    }
    if (sigs.length === 0) break;
    for (const info of sigs) {
      if (outstanding !== null && outstanding.size === 0) break;
      if (info.err) continue;
      let tx: VersionedTransactionResponse | null;
      try {
        tx = await connection.getTransaction(info.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch (err) {
        logError(
          `journal repair: could not read transaction ${info.signature}, that row keeps the ring: ${walkError(err)}`,
        );
        continue;
      }
      if (!tx) continue;
      const charge = chargeFromTx(tx, programId);
      if (charge === null) continue;
      const key = charge.nonce.toString();
      if (found.has(key)) continue;
      let outcome;
      try {
        outcome = parseChargeLogs(tx.meta?.logMessages ?? []);
      } catch {
        continue;
      }
      const blockTime = tx.blockTime ?? info.blockTime ?? null;
      const ts =
        blockTime !== null ? new Date(blockTime * 1000) : new Date(Number(charge.nonce) * 1000);
      found.set(key, {
        nonce: charge.nonce,
        decision: outcome.decision,
        amount: charge.amount,
        ts,
        reason: outcome.reasonCode,
        suggestedOverride: outcome.suggestedOverride ?? 0n,
        signature: info.signature,
      });
      outstanding?.delete(key);
    }
    if (outstanding !== null && outstanding.size === 0) break;
    if (sigs.length < pageSize) break;
    const last = sigs[sigs.length - 1];
    if (last === undefined) break;
    before = last.signature;
  }
  return [...found.values()];
}

function mergeChainDecisions(ring: ChainDecision[], walked: ChainDecision[]): ChainDecision[] {
  const byNonce = new Map<string, ChainDecision>();
  for (const row of ring) byNonce.set(row.nonce.toString(), row);
  for (const row of walked) byNonce.set(row.nonce.toString(), row);
  return [...byNonce.values()].sort((a, b) => (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0));
}

export async function fetchChainDecisions(args: {
  connection: AccountReader;
  programId: PublicKey;
  owner: PublicKey;
  mandateId: bigint;
  /**
   * Nonces the journal already holds. When set, the history walk runs only
   * if the ring still has a nonce the journal does not, and a repair that
   * already holds some of the ring stops once every missing ring nonce has
   * been read. When omitted, or when the journal holds none of the ring,
   * the walk reads the whole history.
   */
  hasNonce?: (nonce: bigint) => boolean;
}): Promise<ChainDecision[]> {
  const mandate = mandatePda(args.programId, args.owner, args.mandateId);
  const ledger = ledgerPda(args.programId, mandate);
  const info = await args.connection.getAccountInfo(ledger, "confirmed");
  const ring = info === null ? [] : decodeLedgerDecisions(info.data, ledger.toBase58());
  if (!canWalk(args.connection)) return mergeChainDecisions(ring, []);
  const held = args.hasNonce;
  // Nothing on the ring is missing, so there is nothing to name.
  if (held !== undefined && ring.every((row) => held(row.nonce))) {
    return mergeChainDecisions(ring, []);
  }
  // A rebuild from nothing still reads every transaction, including a charge
  // the ring itself has lost. A repair that already holds part of the ring
  // stops once the nonces it is missing are in hand.
  let missing: ReadonlySet<string> | undefined;
  if (held === undefined || ring.every((row) => !held(row.nonce))) {
    missing = undefined;
  } else {
    missing = new Set(ring.filter((row) => !held(row.nonce)).map((row) => row.nonce.toString()));
  }
  const walked = await decisionsFromMandateHistory(args.connection, args.programId, mandate, missing);
  return mergeChainDecisions(ring, walked);
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
    signature:
      entry.signature !== undefined && entry.signature.length > 0
        ? entry.signature
        : RECOVERED_SIGNATURE,
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
