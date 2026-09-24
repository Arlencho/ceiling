// Security critic, PR 207 round 2 (issue 204). Head 1c8e811 binds export to
// verify's own tenure walk (tenureReader) and leaves the ring unread when the
// limits come from an opening tenure. These shapes sit in that fix diff.
// S6: reopened live PDA, population in indexer order (newest first). The
//     shared reader is primed by the live-tenure decision, then the older one
//     must still take the walk. Each record verifies against the same chain.
// S7: a charge in the same transaction as the close of tenure 1, with tenure 2
//     live and its ring holding the twin row. Export binds tenure 1, takes no
//     ring row, and the record confirms on both paths.
// S8 (control): a read that straddles a reopen the other way round. Mandate
//     and listing still show tenure 1, the ledger already holds the tenure-2
//     ring. Whatever export writes, verify against the settled chain must not
//     confirm a timestamp the transaction does not carry.
// S9 (control): a live mandate whose listing does not contain the signature
//     exports nothing on either path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
import type { IndexedDecision } from "./bulk.js";
import { recordFromSignature, recordsFromIndexedDecisions } from "./export.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  ledgerPda,
  mandatePda,
  parseRecord,
  recordToJson,
  u64Le,
} from "./lib.js";
import { assessRecord, type AssessOpts } from "./verify.js";

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const SYSTEM = new PublicKey("11111111111111111111111111111111");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const PER_TX = 500_000n;
const EXPIRES = 1_797_713_870n;
const NOTE = "mandate account is closed and the limits came from the opening transaction";

type Limits = { cap: bigint; purpose: string };
type Charge = { signature: string; slot: number; amount: number; nonce: number; timestamp: number };
type Step =
  | { kind: "open"; signature: string; slot: number; limits: Limits }
  | { kind: "close"; signature: string; slot: number }
  | ({ kind: "charge" } & Charge)
  | ({ kind: "charge+close" } & Charge);
type Live = { limits: Limits; ring: Charge[] };

function disc(name: string): Buffer {
  const path = join(dirname(fileURLToPath(import.meta.url)), "idl", "veto.json");
  const idl = JSON.parse(readFileSync(path, "utf8")) as { instructions: { name: string; discriminator: number[] }[] };
  const ix = idl.instructions.find((item) => item.name === name);
  if (!ix) throw new Error(`missing ${name}`);
  return Buffer.from(ix.discriminator);
}

function encodeOpen(mandateId: bigint, limits: Limits): Buffer {
  const purpose = Buffer.from(limits.purpose, "utf8");
  const buf = Buffer.alloc(8 + 8 + 32 + 32 + 8 + 8 + 8 + 4 + purpose.length);
  let o = 0;
  disc("open_mandate").copy(buf, o);
  o += 8;
  buf.writeBigUInt64LE(mandateId, o);
  o += 8;
  AGENT.toBuffer().copy(buf, o);
  o += 32;
  MERCHANT.toBuffer().copy(buf, o);
  o += 32;
  buf.writeBigUInt64LE(limits.cap, o);
  o += 8;
  buf.writeBigUInt64LE(PER_TX, o);
  o += 8;
  buf.writeBigInt64LE(EXPIRES, o);
  o += 8;
  buf.writeUInt32LE(purpose.length, o);
  o += 4;
  purpose.copy(buf, o);
  return buf;
}

// Live account of the tenure that is open now (pr154 layout, as the backend r1 fixture).
function encodeMandate(mandateId: bigint, limits: Limits, spendCount: number): Buffer {
  const purpose = Buffer.from(limits.purpose, "utf8");
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const key of [OWNER, AGENT, MINT, SOURCE, MERCHANT]) {
    key.toBuffer().copy(buf, o);
    o += 32;
  }
  for (const value of [mandateId, limits.cap, 100_000n, PER_TX]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeBigInt64LE(EXPIRES, o);
  o += 8;
  for (const value of [0n, 0n, 1n]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeUInt32LE(purpose.length, o);
  o += 4;
  purpose.copy(buf, o);
  o += purpose.length;
  buf[o] = 0;
  o += 1;
  buf.writeUInt32LE(spendCount, o);
  o += 4;
  buf.writeUInt32LE(0, o);
  o += 4;
  buf[o] = 255;
  return buf;
}

function encodeLedger(mandate: PublicKey, rows: Charge[]): Buffer {
  const data = Buffer.alloc(48 + LEDGER_CAPACITY * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  mandate.toBuffer().copy(data, 8);
  data.writeUInt32LE(rows.length, 40);
  data.writeUInt16LE(rows.length % LEDGER_CAPACITY, 44);
  rows.forEach((row, seq) => {
    const off = 48 + seq * 72;
    data.writeBigInt64LE(BigInt(row.timestamp), off);
    data.writeBigUInt64LE(BigInt(row.amount), off + 8);
    DEST.toBuffer().copy(data, off + 16);
    data.writeBigUInt64LE(BigInt(row.nonce), off + 48);
    data.writeBigUInt64LE(0n, off + 56);
    data[off + 64] = KIND_PAID;
    data[off + 65] = 0;
  });
  return data;
}

function chargeData(step: Charge): Buffer {
  return Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(step.amount)), u64Le(BigInt(step.nonce))]);
}

function openLogs(): string[] {
  return [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: Instruction: OpenMandate", `Program ${PROGRAM.toBase58()} success`];
}

function closeLogs(): string[] {
  return [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: VETO CLOSED", `Program ${PROGRAM.toBase58()} success`];
}

function chargeLogs(mandate: PublicKey, step: Charge): string[] {
  return [
    `Program ${PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    `Program log: VETO PAID amount=${step.amount} spent=${step.amount} of cap=1 remaining=1`,
    encodePaidLog({ mandate, amount: BigInt(step.amount), nonce: BigInt(step.nonce), spent: BigInt(step.amount) }),
    `Program ${PROGRAM.toBase58()} success`,
  ];
}

function tx(slot: number, blockTime: number, keys: PublicKey[], ixs: { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer }[], logMessages: string[]): unknown {
  return {
    slot,
    blockTime,
    transaction: { message: { staticAccountKeys: keys, compiledInstructions: ixs } },
    meta: { err: null, logMessages },
  };
}

function stepTx(mandate: PublicKey, ledger: PublicKey, mandateId: bigint, step: Step): unknown {
  if (step.kind === "open") {
    const keys = [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM];
    return tx(step.slot, step.slot, keys, [{ programIdIndex: 7, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], data: encodeOpen(mandateId, step.limits) }], openLogs());
  }
  if (step.kind === "close") {
    const keys = [OWNER, mandate, ledger, PROGRAM];
    return tx(step.slot, step.slot, keys, [{ programIdIndex: 3, accountKeyIndexes: [0, 1, 2], data: disc("close_mandate") }], closeLogs());
  }
  if (step.kind === "charge") {
    const keys = [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID];
    return tx(step.slot, step.timestamp, keys, [{ programIdIndex: 6, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7], data: chargeData(step) }], chargeLogs(mandate, step));
  }
  const keys = [OWNER, mandate, ledger, PROGRAM, AGENT, DEST, SOURCE, MINT, TOKEN_PROGRAM_ID];
  return tx(
    step.slot,
    step.timestamp,
    keys,
    [
      { programIdIndex: 3, accountKeyIndexes: [4, 1, 2, 6, 5, 7, 8], data: chargeData(step) },
      { programIdIndex: 3, accountKeyIndexes: [0, 1, 2], data: disc("close_mandate") },
    ],
    [...chargeLogs(mandate, step), ...closeLogs()],
  );
}

function stepBlockTime(step: Step): number {
  return step.kind === "open" || step.kind === "close" ? step.slot : step.timestamp;
}

// `live` serves the account and the ring of the tenure that is open now.
// `listed` is what getSignaturesForAddress returns (defaults to every step);
// every step's transaction stays readable either way.
function chain(mandateId: bigint, steps: Step[], opts?: { live?: Live; listed?: Step[] }): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const live = opts?.live;
  const txs = new Map<string, unknown>();
  for (const step of steps) txs.set(step.signature, stepTx(mandate, ledger, mandateId, step));
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const newestFirst = [...(opts?.listed ?? steps)].reverse();
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(DEST)) return { data: token, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
      if (live && address.equals(mandate)) {
        return { data: encodeMandate(mandateId, live.limits, live.ring.length), owner: PROGRAM, executable: false, lamports: 1 };
      }
      if (live && address.equals(ledger)) return { data: encodeLedger(mandate, live.ring), owner: PROGRAM, executable: false, lamports: 1 };
      return null;
    },
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string; limit?: number }) {
      const start = config?.before ? newestFirst.findIndex((step) => step.signature === config.before) + 1 : 0;
      const limit = config?.limit ?? newestFirst.length;
      return newestFirst.slice(start, start + limit).map((step) => ({
        signature: step.signature,
        slot: step.slot,
        err: null,
        memo: null,
        blockTime: stepBlockTime(step),
        confirmationStatus: "confirmed" as const,
      }));
    },
  } as unknown as Connection;
  return { conn, mandate };
}

async function capture<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((part) => String(part)).join(" "));
  };
  try {
    return { value: await run(), lines };
  } finally {
    console.error = orig;
  }
}

function indexed(mandate: PublicKey, step: Charge): IndexedDecision {
  return {
    signature: step.signature,
    timestamp: step.timestamp,
    mandate: mandate.toBase58(),
    amount: BigInt(step.amount),
    nonce: BigInt(step.nonce),
    counterparty: DEST.toBase58(),
    kind: "paid",
    reason: 0,
    suggestedOverride: 0n,
  };
}

function population(conn: Connection, mandate: PublicKey, charges: Charge[]) {
  return recordsFromIndexedDecisions({
    conn,
    programId: PROGRAM,
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    decisions: charges.map((step) => indexed(mandate, step)),
  });
}

const FIRST: Limits = { cap: 1_000_000n, purpose: "first-tenure" };
const SECOND: Limits = { cap: 2_000_000n, purpose: "second-tenure" };
// Nonces restart per tenure: the twin shares nonce and amount, lands a day later.
const charge1: Charge = { signature: "charge-1", slot: 2, amount: 100_000, nonce: 1, timestamp: 1_790_200_100 };
const twin: Charge = { signature: "charge-2", slot: 5, amount: 100_000, nonce: 1, timestamp: 1_790_300_900 };

const reopened: Step[] = [
  { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
  { kind: "charge", ...charge1 },
  { kind: "close", signature: "close-1", slot: 3 },
  { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
  { kind: "charge", ...twin },
];
const secondLive: Live = { limits: SECOND, ring: [twin] };

test("critic sec r2 pr207 S6: a newest-first population on a reopened live PDA gives the older decision its own tenure after the reader served the live one", async () => {
  const { conn, mandate } = chain(2206n, reopened, { live: secondLive });
  const { value: records, lines } = await capture(() => population(conn, mandate, [twin, charge1]));
  assert.equal(records.length, 2);
  const [newer, older] = records as [typeof records[0], typeof records[0]];
  assert.equal(newer.signature, twin.signature);
  assert.equal(newer.limits.purpose, SECOND.purpose);
  assert.equal(newer.limits.cap, SECOND.cap);
  assert.equal(newer.timestamp, BigInt(twin.timestamp));
  assert.equal(older.signature, charge1.signature);
  assert.equal(older.limits.purpose, FIRST.purpose);
  assert.equal(older.limits.cap, FIRST.cap);
  assert.equal(older.timestamp, BigInt(charge1.timestamp), "ts must come from the indexed charge, not the live ring's twin row");
  assert.equal(lines.filter((line) => line === `note: ${NOTE}`).length, 1, lines.join("\n"));
  for (const record of records) {
    const verdict = await assessRecord(parseRecord(JSON.parse(recordToJson(record))), RPC, conn, OPTS);
    assert.equal(verdict.ok, true, verdict.text);
    assert.match(verdict.text, /VERDICT: CONFIRMED/);
  }
  // The live twin on the signature path takes the live account and its ring, no note.
  const { value: liveRecord, lines: liveLines } = await capture(() =>
    recordFromSignature(conn, twin.signature, PROGRAM, "devnet", DEVNET_GENESIS),
  );
  assert.equal(liveRecord.limits.purpose, SECOND.purpose);
  assert.equal(liveRecord.timestamp, BigInt(twin.timestamp));
  assert.ok(!liveLines.includes(`note: ${NOTE}`), liveLines.join("\n"));
  const liveVerdict = await assessRecord(parseRecord(JSON.parse(recordToJson(liveRecord))), RPC, conn, OPTS);
  assert.equal(liveVerdict.ok, true, liveVerdict.text);
});

test("critic sec r2 pr207 S7: a charge in the same transaction as the close binds tenure 1 while tenure 2 is live with the twin in its ring", async () => {
  const composite: Charge = { signature: "charge-and-close-1", slot: 2, amount: 100_000, nonce: 1, timestamp: 1_790_200_100 };
  const { conn, mandate } = chain(
    2207n,
    [
      { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
      { kind: "charge+close", ...composite },
      { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
      { kind: "charge", ...twin },
    ],
    { live: secondLive },
  );
  const { value: record, lines } = await capture(() => recordFromSignature(conn, composite.signature, PROGRAM, "devnet", DEVNET_GENESIS));
  assert.equal(record.limits.purpose, FIRST.purpose);
  assert.equal(record.limits.cap, FIRST.cap);
  assert.equal(record.timestamp, BigInt(composite.timestamp), "ts must come from the transaction, not the live ring's twin row");
  assert.ok(lines.includes(`note: ${NOTE}`), lines.join("\n"));
  const verdict = await assessRecord(parseRecord(JSON.parse(recordToJson(record))), RPC, conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
  assert.match(verdict.text, /VERDICT: CONFIRMED/);
  const { value: records } = await capture(() => population(conn, mandate, [composite]));
  assert.equal(records.length, 1);
  assert.equal(records[0]!.limits.purpose, FIRST.purpose);
  assert.equal(records[0]!.timestamp, BigInt(composite.timestamp));
  const bulkVerdict = await assessRecord(records[0]!, RPC, conn, OPTS);
  assert.equal(bulkVerdict.ok, true, bulkVerdict.text);
});

test("critic sec r2 pr207 S8 (control): a read that straddles a reopen cannot produce a record verify confirms with a timestamp the transaction does not carry", async () => {
  // The reopen landed after the listing was read and before the ledger was:
  // mandate and listing say tenure 1, the ledger holds the tenure-2 ring.
  const straddled = chain(2208n, reopened, {
    live: { limits: FIRST, ring: [twin] },
    listed: reopened.slice(0, 2),
  });
  const settled = chain(2208n, reopened, { live: secondLive });
  const { value: record } = await capture(() => recordFromSignature(straddled.conn, charge1.signature, PROGRAM, "devnet", DEVNET_GENESIS));
  assert.equal(record.limits.purpose, FIRST.purpose);
  const verdict = await assessRecord(parseRecord(JSON.parse(recordToJson(record))), RPC, settled.conn, OPTS);
  if (record.timestamp === BigInt(charge1.timestamp)) {
    assert.equal(verdict.ok, true, verdict.text);
  } else {
    assert.equal(verdict.ok, false, `a twin-row timestamp must not confirm: ${verdict.text}`);
    assert.match(verdict.text, /timestamp \(transaction\)/);
  }
  const { value: records } = await capture(() => population(straddled.conn, straddled.mandate, [charge1]));
  const bulkVerdict = await assessRecord(records[0]!, RPC, settled.conn, OPTS);
  if (records[0]!.timestamp === BigInt(charge1.timestamp)) {
    assert.equal(bulkVerdict.ok, true, bulkVerdict.text);
  } else {
    assert.equal(bulkVerdict.ok, false, `a twin-row timestamp must not confirm: ${bulkVerdict.text}`);
    assert.match(bulkVerdict.text, /timestamp \(transaction\)/);
  }
});

test("critic sec r2 pr207 S9 (control): a live mandate whose listing does not contain the signature exports nothing on either path", async () => {
  const { conn, mandate } = chain(2209n, reopened, { live: secondLive, listed: reopened.filter((step) => step.signature !== charge1.signature) });
  await assert.rejects(
    capture(() => recordFromSignature(conn, charge1.signature, PROGRAM, "devnet", DEVNET_GENESIS)),
    /mandate history does not list signature/,
  );
  await assert.rejects(capture(() => population(conn, mandate, [charge1])), /mandate history does not list signature/);
});
