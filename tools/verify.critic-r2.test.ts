// Backend critic, PR 121 round 2. A genuine bulk export of a mandate that
// holds two refusals of one nonce is REJECTED by verify.ts.
//
// export.ts builds a bulk row (rule or date_range) from the indexer and then
// overlays the ring row that matches amount, nonce and kind
// (tools/export.ts:196-207, overlayRing -> matchingRingEntry, tools/lib.ts:799-809,
// which returns the NEWEST hit). So the first of two same-nonce refusals is
// written with the second one's timestamp. verify.ts ringEntryForSignature
// (tools/verify.ts:131-164) binds the same signature to the ring row nearest
// its own blockTime and rejects the row: "timestamp (ledger): record has T+3,
// chain has T". The single-record path (export.ts --signature) binds to the
// transaction and confirms, so the two export paths disagree with each other.
// Reproduced on a local validator on 2026-09-23 (mandate BHP4xef4..., rows
// 2MwPSk8t at 1790117952 and 3s8chAwK at 1790117955, both exported at ...955).
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { buildRecordFromIndexed, makeBundle, overlayRing, type IndexedDecision } from "./bulk.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  KIND_REFUSED,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  fetchLedger,
  fetchMandate,
  ledgerPda,
  mandatePda,
  reasonText,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const T0 = 1_790_117_952;
const LIMITS = { cap: 1_000_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, purpose: "critic r2" };

type Row = { kind: "paid" | "refused"; amount: number; nonce: number; timestamp: number; signature: string };

function encodeMandate(mandateId: bigint, spendCount: number, refusalCount: number, spent: bigint): Buffer {
  const purpose = Buffer.from(LIMITS.purpose, "utf8");
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const key of [OWNER, AGENT, MINT, SOURCE, MERCHANT]) {
    key.toBuffer().copy(buf, o);
    o += 32;
  }
  for (const value of [mandateId, BigInt(LIMITS.cap), spent, BigInt(LIMITS.per_tx_max)]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeBigInt64LE(BigInt(LIMITS.expires_at), o);
  o += 8;
  for (const value of [0n, 0n, 0n]) {
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
  buf.writeUInt32LE(refusalCount, o);
  o += 4;
  buf[o] = 255;
  return buf;
}

function encodeLedger(mandate: PublicKey, rows: Row[]): Buffer {
  const data = Buffer.alloc(48 + LEDGER_CAPACITY * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  mandate.toBuffer().copy(data, 8);
  data.writeUInt32LE(rows.length, 40);
  data.writeUInt16LE(rows.length % LEDGER_CAPACITY, 44);
  rows.forEach((row, seq) => {
    const off = 48 + (seq % LEDGER_CAPACITY) * 72;
    data.writeBigInt64LE(BigInt(row.timestamp), off);
    data.writeBigUInt64LE(BigInt(row.amount), off + 8);
    DEST.toBuffer().copy(data, off + 16);
    data.writeBigUInt64LE(BigInt(row.nonce), off + 48);
    data.writeBigUInt64LE(BigInt(row.kind === "refused" ? row.amount : 0), off + 56);
    data[off + 64] = row.kind === "paid" ? KIND_PAID : KIND_REFUSED;
    data[off + 65] = row.kind === "paid" ? 0 : 5;
  });
  return data;
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, row: Row): unknown {
  const logs =
    row.kind === "paid"
      ? [`Program log: VETO PAID amount=${row.amount}`]
      : [
          `Program log: VETO REFUSED reason=5 (${reasonText(5)}) amount=${row.amount} per_tx_max=${LIMITS.per_tx_max} remaining=1 override_to_clear=${row.amount}`,
        ];
  return {
    slot: 1,
    blockTime: row.timestamp,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, REAL_PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [
          {
            programIdIndex: 6,
            accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
            data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(row.amount)), u64Le(BigInt(row.nonce))]),
          },
        ],
      },
    },
    meta: { err: null, logMessages: logs },
  };
}

function tokenAccount(): Buffer {
  const data = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(data, 32);
  return data;
}

function chain(mandateId: bigint, rows: Row[]): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const paid = rows.filter((row) => row.kind === "paid");
  const refused = rows.filter((row) => row.kind === "refused");
  const spent = paid.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: tokenAccount(), owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(mandateId, paid.length, refused.length, spent), owner: REAL_PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: REAL_PROGRAM }],
  ]);
  const txs = new Map<string, unknown>(rows.map((row) => [row.signature, chargeTx(mandate, ledger, row)]));
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      const hit = accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string }) {
      if (config?.before) return [];
      return rows.map((row) => ({
        signature: row.signature,
        slot: 1,
        err: null,
        memo: null,
        blockTime: row.timestamp,
        confirmationStatus: "confirmed" as const,
      }));
    },
  } as unknown as Connection;
  return { conn, mandate };
}

// The indexer row for a charge: what fetchDecisionHistory hands export.ts.
function indexed(mandate: PublicKey, row: Row): IndexedDecision {
  return {
    signature: row.signature,
    timestamp: row.timestamp,
    mandate: mandate.toBase58(),
    amount: BigInt(row.amount),
    nonce: BigInt(row.nonce),
    counterparty: DEST.toBase58(),
    kind: row.kind,
    reason: row.kind === "paid" ? 0 : 5,
    suggestedOverride: BigInt(row.kind === "refused" ? row.amount : 0),
  };
}

// Bulk rows the way export.ts recordsFromIndexer builds them (export.ts:196-207).
async function exportBulkRows(conn: Connection, mandate: PublicKey, rows: Row[]): Promise<DecisionRecord[]> {
  const mandateAccount = await fetchMandate(conn, mandate);
  const ledger = await fetchLedger(conn, ledgerPda(REAL_PROGRAM, mandate));
  return rows.map((row) => {
    const decision = indexed(mandate, row);
    return buildRecordFromIndexed({
      cluster: "devnet",
      genesisHash: DEVNET_GENESIS,
      programId: REAL_PROGRAM,
      mandateAccount,
      decision,
      ringEntry: overlayRing(ledger, decision),
    });
  });
}

const TWO_REFUSALS: Row[] = [
  { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0, signature: "r2-refused-first" },
  { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0 + 3, signature: "r2-refused-second" },
  { kind: "paid", amount: 100_000, nonce: 6, timestamp: T0 + 5, signature: "r2-paid" },
];

test("critic r2: a bulk export row carries its own transaction's time when two refusals share a nonce", async () => {
  const { conn, mandate } = chain(31n, TWO_REFUSALS);
  const [first, second] = await exportBulkRows(conn, mandate, TWO_REFUSALS);
  assert.equal(
    first!.timestamp,
    BigInt(T0),
    `export wrote the first refusal (${first!.signature}) with timestamp ${first!.timestamp}, its transaction landed at ${T0}`,
  );
  assert.equal(second!.timestamp, BigInt(T0 + 3));
});

test("critic r2: the genuine rule export of a mandate with two same-nonce refusals confirms", async () => {
  const { conn, mandate } = chain(32n, TWO_REFUSALS);
  const decisions = await exportBulkRows(conn, mandate, TWO_REFUSALS);
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "rule", mandate: mandate.toBase58(), from: null, to: null },
    decisions,
  });
  const verdict = await assessBundle(bundle, RPC, conn, OPTS);
  assert.equal(verdict.ok, true, `genuine rule export written by export.ts is rejected:\n${verdict.text}`);
});

test("critic r2: the genuine date_range export of the same mandate confirms", async () => {
  const { conn, mandate } = chain(33n, TWO_REFUSALS);
  const decisions = await exportBulkRows(conn, mandate, TWO_REFUSALS);
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "date_range", mandate: null, from: T0 - 1, to: T0 + 10 },
    decisions,
  });
  const verdict = await assessBundle(bundle, RPC, conn, OPTS);
  assert.equal(verdict.ok, true, `genuine date_range export written by export.ts is rejected:\n${verdict.text}`);
});

// Control: a single record that carries its own transaction time (the
// --signature path) confirms for both refusals. This passes on the head.
test("critic r2 control: single records with their own transaction time both confirm", async () => {
  const { conn, mandate } = chain(34n, TWO_REFUSALS);
  const mandateAccount = await fetchMandate(conn, mandate);
  for (const row of TWO_REFUSALS.slice(0, 2)) {
    const record = buildRecordFromIndexed({
      cluster: "devnet",
      genesisHash: DEVNET_GENESIS,
      programId: REAL_PROGRAM,
      mandateAccount,
      decision: indexed(mandate, row),
      ringEntry: null,
    });
    const verdict = await assessRecord(record, RPC, conn, OPTS);
    assert.equal(verdict.ok, true, `${row.signature}:\n${verdict.text}`);
  }
});
