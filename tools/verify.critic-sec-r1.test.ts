// Security critic, PR 121 round 1. Three inputs on the trust boundary and the
// secret path, on the same mock chain shape the PR's verify.issues.test.ts
// and the round 1 backend fixtures use.
//
//   1. A key carried in the RPC URL path reaches the CONFIRMED block and the
//      "not found on" line. verify.ts shownRpc via lib.ts redactRpcUrls.
//   2. A bulk verdict never states which population it checked. A rule export
//      relabelled date_range, with `to` moved in front of a paid row and that
//      row deleted, prints CONFIRMED with no scope, bounds, or chain counts.
//      verify.ts assessBundle / bundleFailures.
//   3. When getTransaction returns blockTime null, ringEntryForSignature binds
//      to the newest same-nonce row again, so the first refusal's record with
//      the second refusal's timestamp confirms. verify.ts ringEntryForSignature.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { makeBundle, type DecisionBundle } from "./bulk.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  KIND_REFUSED,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  ledgerPda,
  mandatePda,
  parseRecord,
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
const PATH_KEYED_RPC = "https://solana-devnet.g.alchemy.com/v2/SECRET123";
const OPTS: AssessOpts = { env: {} };
const T0 = 1_789_937_883;

const LIMITS = {
  cap: 100_000_000,
  per_tx_max: 500_000,
  expires_at: 1_797_713_870,
  merchant: MERCHANT.toBase58(),
  purpose: "SE3 home charging",
};

type Row = {
  kind: "paid" | "refused";
  amount: number;
  nonce: number;
  timestamp: number;
  signature: string;
  blockTime?: number | null;
};

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
    blockTime: row.blockTime === undefined ? row.timestamp : row.blockTime,
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

function record(mandate: PublicKey, row: Row, timestamp = row.timestamp): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: REAL_PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: LIMITS,
    kind: row.kind,
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp,
    nonce: row.nonce,
    reason_code: row.kind === "paid" ? 0 : 5,
    reason_text: reasonText(row.kind === "paid" ? 0 : 5),
    suggested_override: row.kind === "refused" ? row.amount : 0,
    signature: row.signature,
  });
}

function tokenAccount(): Buffer {
  const data = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(data, 32);
  return data;
}

function chain(mandateId: bigint, rows: Row[]): { conn: Connection; mandate: PublicKey; records: DecisionRecord[] } {
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
  } as unknown as Connection;
  return { conn, mandate, records: rows.map((row) => record(mandate, row)) };
}

function bundle(scope: DecisionBundle["scope"], decisions: DecisionRecord[]): DecisionBundle {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope,
    decisions,
  });
}

const THREE: Row[] = [
  { kind: "paid", amount: 446_000, nonce: 1, timestamp: T0, signature: "s-paid-1" },
  { kind: "refused", amount: 6_232_500, nonce: 2, timestamp: T0 + 9, signature: "s-refused-2" },
  { kind: "paid", amount: 214_500, nonce: 3, timestamp: T0 + 167, signature: "s-paid-3" },
];

test("critic sec r1: a key in the RPC URL path does not reach the verify output", async () => {
  const { conn, records } = chain(21n, THREE);
  const confirmed = await assessRecord(records[0]!, PATH_KEYED_RPC, conn, OPTS);
  assert.equal(confirmed.ok, true, confirmed.text);
  const missing = await assessRecord(
    record(mandatePda(REAL_PROGRAM, OWNER, 21n), { ...THREE[0]!, signature: "not-on-chain" }),
    PATH_KEYED_RPC,
    conn,
    OPTS,
  );
  assert.equal(missing.ok, false, missing.text);
  const leaked = [confirmed.text, missing.text].filter((text) => text.includes("SECRET123"));
  assert.deepEqual(leaked, [], leaked.join("\n---\n"));
});

test("critic sec r1: a bulk verdict states the population it checked", async () => {
  const { conn, mandate, records } = chain(22n, THREE);
  const narrowed = { type: "date_range" as const, mandate: mandate.toBase58(), from: T0 - 1, to: T0 + 100 };
  const pruned = await assessBundle(bundle(narrowed, records.slice(0, 2)), RPC, conn, OPTS);
  assert.equal(pruned.ok, true, `a narrowed date_range is a legitimate export shape:\n${pruned.text}`);
  const text = pruned.text;
  const missing: string[] = [];
  if (!text.includes("date_range")) missing.push("scope type");
  if (!text.includes(String(narrowed.from)) || !text.includes(String(narrowed.to))) missing.push("scope bounds");
  if (!/spend_count|paid on chain|paid rows on the ledger/i.test(text)) missing.push("chain paid count");
  if (!/refusal_count|refused on chain|refused rows on the ledger/i.test(text)) missing.push("chain refused count");
  assert.deepEqual(missing, [], `verdict block names nothing about the population it checked (${missing.join(", ")}):\n${text}`);
});

test("critic sec r1: with blockTime null, a first refusal carrying the second refusal's timestamp is rejected", async () => {
  const rows: Row[] = [
    { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0, signature: "nb-first", blockTime: null },
    { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0 + 3, signature: "nb-second" },
  ];
  const { conn, mandate } = chain(23n, rows);
  const forged = record(mandate, rows[0]!, T0 + 3);
  const result = await assessRecord(forged, RPC, conn, OPTS);
  assert.equal(result.ok, false, `first refusal with the second refusal's timestamp confirms:\n${result.text}`);
});
