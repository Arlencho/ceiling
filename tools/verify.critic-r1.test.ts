// Backend critic, PR 121 round 1. Three inputs the fix on tools/verify.ts
// gets wrong. Each one is a genuine export shape export.ts produces today, or
// a pruned copy of one, checked with the same mock chain shape the PR's own
// verify.issues.test.ts uses.
//
//   1. A date_range export of a mandate whose ledger ring has wrapped
//      (LEDGER_CAPACITY is 32). The genuine complete file is REJECTED because
//      the evicted row is "0 times on the ledger", and the same file with the
//      evicted paid row deleted is CONFIRMED. verify.ts bundleFailures.
//   2. A date_range export with no --mandate (export.ts usage line three).
//      The genuine file is always REJECTED. verify.ts bundleFailures.
//   3. Two refusals of one nonce that landed in the same second. Both genuine
//      records are REJECTED as "matches 2 ledger rows equally".
//      verify.ts ringEntryForSignature.
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
};

type MandateSpec = { mandateId: bigint; rows: Row[] };

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

// Rows in sequence order. Placement is sequence % LEDGER_CAPACITY, head is
// total % LEDGER_CAPACITY, the layout lib.ts indexedEntries reads back.
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

function record(mandate: PublicKey, row: Row): DecisionRecord {
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
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: row.kind === "paid" ? 0 : 5,
    reason_text: reasonText(row.kind === "paid" ? 0 : 5),
    suggested_override: row.kind === "refused" ? row.amount : 0,
    signature: row.signature,
  });
}

function chain(specs: MandateSpec[]): { conn: Connection; records: Map<string, DecisionRecord[]>; mandates: PublicKey[] } {
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>();
  const txs = new Map<string, unknown>();
  const records = new Map<string, DecisionRecord[]>();
  const mandates: PublicKey[] = [];
  accounts.set(DEST.toBase58(), { data: tokenAccount(), owner: TOKEN_PROGRAM_ID });
  for (const spec of specs) {
    const mandate = mandatePda(REAL_PROGRAM, OWNER, spec.mandateId);
    const ledger = ledgerPda(REAL_PROGRAM, mandate);
    const paid = spec.rows.filter((row) => row.kind === "paid");
    const refused = spec.rows.filter((row) => row.kind === "refused");
    const spent = paid.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    accounts.set(mandate.toBase58(), {
      data: encodeMandate(spec.mandateId, paid.length, refused.length, spent),
      owner: REAL_PROGRAM,
    });
    accounts.set(ledger.toBase58(), { data: encodeLedger(mandate, spec.rows), owner: REAL_PROGRAM });
    for (const row of spec.rows) txs.set(row.signature, chargeTx(mandate, ledger, row));
    records.set(mandate.toBase58(), spec.rows.map((row) => record(mandate, row)));
    mandates.push(mandate);
  }
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
  return { conn, records, mandates };
}

function tokenAccount(): Buffer {
  const data = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(data, 32);
  return data;
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

// One paid charge, then LEDGER_CAPACITY refusals, so the paid row is the one
// the ring has overwritten. The mandate still counts it in spend_count.
function wrappedRows(): Row[] {
  const rows: Row[] = [{ kind: "paid", amount: 446_000, nonce: 1, timestamp: T0, signature: "wrapped-paid-1" }];
  for (let i = 1; i <= LEDGER_CAPACITY; i += 1) {
    rows.push({
      kind: "refused",
      amount: 6_232_500,
      nonce: 1 + i,
      timestamp: T0 + i * 3600,
      signature: `wrapped-refused-${i}`,
    });
  }
  return rows;
}

test("critic r1: a date_range export of a wrapped ring keeps its evicted rows, and loses them when pruned", async () => {
  const rows = wrappedRows();
  const { conn, records, mandates } = chain([{ mandateId: 7n, rows }]);
  const mandate = mandates[0]!.toBase58();
  const all = records.get(mandate)!;
  const scope = { type: "date_range" as const, mandate, from: T0 - 1, to: T0 + (LEDGER_CAPACITY + 1) * 3600 };
  const ruleControl = await assessBundle(bundle({ type: "rule", mandate, from: null, to: null }, all), RPC, conn, OPTS);
  assert.equal(ruleControl.ok, true, `rule scope, same rows, is the control:\n${ruleControl.text}`);

  const genuine = await assessBundle(bundle(scope, all), RPC, conn, OPTS);
  const pruned = await assessBundle(
    bundle(scope, all.filter((row) => row.signature !== "wrapped-paid-1")),
    RPC,
    conn,
    OPTS,
  );
  const wrong: string[] = [];
  if (!genuine.ok) wrong.push(`genuine date_range export of ${all.length} rows is rejected:\n${genuine.text}`);
  if (pruned.ok) wrong.push(`date_range export with the evicted paid row deleted confirms:\n${pruned.text}`);
  assert.deepEqual(wrong, [], wrong.join("\n---\n"));
});

test("critic r1: a date_range export across mandates (no --mandate) still verifies", async () => {
  const a: Row[] = [
    { kind: "paid", amount: 446_000, nonce: 1, timestamp: T0, signature: "a-paid-1" },
    { kind: "refused", amount: 6_232_500, nonce: 2, timestamp: T0 + 9, signature: "a-refused-2" },
  ];
  const b: Row[] = [{ kind: "paid", amount: 10_000_000, nonce: 1, timestamp: T0 + 100, signature: "b-paid-1" }];
  const { conn, records } = chain([
    { mandateId: 1n, rows: a },
    { mandateId: 2n, rows: b },
  ]);
  const decisions = [...records.values()].flat();
  const scope = { type: "date_range" as const, mandate: null, from: T0 - 1, to: T0 + 200 };
  const genuine = await assessBundle(bundle(scope, decisions), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, `genuine cross-mandate date_range export is rejected:\n${genuine.text}`);
});

test("critic r1: two refusals of one nonce in the same second both verify", async () => {
  const rows: Row[] = [
    { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0, signature: "same-second-1" },
    { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0, signature: "same-second-2" },
  ];
  const { conn, records, mandates } = chain([{ mandateId: 5n, rows }]);
  const [first, second] = records.get(mandates[0]!.toBase58())!;
  const one = await assessRecord(first!, RPC, conn, OPTS);
  const two = await assessRecord(second!, RPC, conn, OPTS);
  assert.equal(one.ok, true, `genuine first refusal is rejected:\n${one.text}`);
  assert.equal(two.ok, true, `genuine second refusal is rejected:\n${two.text}`);
});

// Regression check named for this round: the attacks the fix does close, on
// an unwrapped ring. Reordering rows is not a forgery and still confirms; a
// row added from another mandate, or a copied row under an invented
// signature, is rejected; a rule export relabelled as a date_range that
// still spans every row is rejected when a paid row is missing.
test("critic r1 regression: reordered rows confirm, an added row rejects, a full-span date_range with a row missing rejects", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 446_000, nonce: 1, timestamp: T0, signature: "r-paid-1" },
    { kind: "refused", amount: 6_232_500, nonce: 2, timestamp: T0 + 9, signature: "r-refused-2" },
    { kind: "paid", amount: 214_500, nonce: 3, timestamp: T0 + 167, signature: "r-paid-3" },
  ];
  const other: Row[] = [{ kind: "paid", amount: 10_000_000, nonce: 1, timestamp: T0 + 100, signature: "o-paid-1" }];
  const { conn, records, mandates } = chain([
    { mandateId: 11n, rows },
    { mandateId: 12n, rows: other },
  ]);
  const mandate = mandates[0]!.toBase58();
  const all = records.get(mandate)!;
  const foreign = records.get(mandates[1]!.toBase58())![0]!;
  const rule = { type: "rule" as const, mandate, from: null, to: null };
  const span = { type: "date_range" as const, mandate, from: T0 - 1, to: T0 + 1000 };
  const copied = parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: REAL_PROGRAM.toBase58(),
    mandate,
    limits: LIMITS,
    kind: "paid",
    amount: 446_000,
    counterparty: DEST.toBase58(),
    timestamp: T0,
    nonce: 1,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature: "r-paid-1-invented",
  });
  const cases: Array<{ name: string; bundle: DecisionBundle; expectOk: boolean }> = [
    { name: "rule, rows reversed", bundle: bundle(rule, [...all].reverse()), expectOk: true },
    { name: "rule, row added from another mandate", bundle: bundle(rule, [...all, foreign]), expectOk: false },
    { name: "rule, row copied under an invented signature", bundle: bundle(rule, [...all, copied]), expectOk: false },
    { name: "date_range spanning every row, one paid row deleted", bundle: bundle(span, all.slice(1)), expectOk: false },
    { name: "date_range spanning every row, rows reversed", bundle: bundle(span, [...all].reverse()), expectOk: true },
  ];
  const wrong: string[] = [];
  for (const item of cases) {
    const result = await assessBundle(item.bundle, RPC, conn, OPTS);
    if (result.ok !== item.expectOk) wrong.push(`${item.name}: expected ok=${item.expectOk}\n${result.text}`);
  }
  assert.deepEqual(wrong, [], wrong.join("\n---\n"));
});
