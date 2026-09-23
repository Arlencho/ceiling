// Backend critic, PR 154 round 2.
// Three tenures on one PDA, the record in the middle one, and a nonce and
// amount twin in every tenure. The live account is the third tenure and its
// ring holds only the third twin. The middle record confirms with its own
// tenure's limits and with nothing else; a middle tenure whose limits equal
// the live tenure's is still not the live tenure.
// Cost of the live tenure check: transactions fetched for one record.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
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
  reasonText,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { makeBundle } from "./bulk.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

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
const T0 = 1_790_200_000;

type Limits = { cap: bigint; purpose: string };
const FIRST: Limits = { cap: 1_000_000n, purpose: "first-tenure" };
const SECOND: Limits = { cap: 2_000_000n, purpose: "second-tenure" };
const THIRD: Limits = { cap: 3_000_000n, purpose: "third-tenure" };

type Row = { amount: number; nonce: number; timestamp: number };

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

function encodeLedger(mandate: PublicKey, rows: Row[]): Buffer {
  if (rows.length > LEDGER_CAPACITY) throw new Error("fixture exceeds the ring");
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

type Step =
  | { kind: "open"; signature: string; slot: number; limits: Limits }
  | { kind: "close"; signature: string; slot: number }
  | { kind: "charge"; signature: string; slot: number; amount: number; nonce: number; timestamp: number };
type ChargeStep = Extract<Step, { kind: "charge" }>;

function openTx(mandate: PublicKey, ledger: PublicKey, mandateId: bigint, step: Extract<Step, { kind: "open" }>): unknown {
  return {
    slot: step.slot,
    blockTime: T0 + step.slot,
    transaction: {
      message: {
        staticAccountKeys: [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM],
        compiledInstructions: [{ programIdIndex: 7, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], data: encodeOpen(mandateId, step.limits) }],
      },
    },
    meta: { err: null, logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: Instruction: OpenMandate", `Program ${PROGRAM.toBase58()} success`] },
  };
}

function closeTx(mandate: PublicKey, ledger: PublicKey, step: Extract<Step, { kind: "close" }>): unknown {
  return {
    slot: step.slot,
    blockTime: T0 + step.slot,
    transaction: {
      message: {
        staticAccountKeys: [OWNER, mandate, ledger, PROGRAM],
        compiledInstructions: [{ programIdIndex: 3, accountKeyIndexes: [0, 1, 2], data: disc("close_mandate") }],
      },
    },
    meta: { err: null, logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: VETO CLOSED", `Program ${PROGRAM.toBase58()} success`] },
  };
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, step: ChargeStep): unknown {
  return {
    slot: step.slot,
    blockTime: step.timestamp,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [
          { programIdIndex: 6, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7], data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(step.amount)), u64Le(BigInt(step.nonce))]) },
        ],
      },
    },
    meta: {
      err: null,
      logMessages: [
        `Program ${PROGRAM.toBase58()} invoke [1]`,
        "Program log: Instruction: Charge",
        `Program log: VETO PAID amount=${step.amount} spent=${step.amount} of cap=1 remaining=1`,
        encodePaidLog({ mandate, amount: BigInt(step.amount), nonce: BigInt(step.nonce), spent: BigInt(step.amount) }),
        `Program ${PROGRAM.toBase58()} success`,
      ],
    },
  };
}

function paidRecord(mandate: PublicKey, step: ChargeStep, limits: Limits, timestamp = step.timestamp): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: { cap: Number(limits.cap), per_tx_max: Number(PER_TX), expires_at: Number(EXPIRES), merchant: MERCHANT.toBase58(), purpose: limits.purpose },
    kind: "paid",
    amount: step.amount,
    counterparty: DEST.toBase58(),
    timestamp,
    nonce: step.nonce,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature: step.signature,
  });
}

type Listed = { signature: string; slot: number; err: unknown; blockTime: number };

// One fake node. Signature listings are per address, newest first. Accounts
// are whatever is live now. Transaction fetches are counted.
function node(args: {
  txs: Map<string, unknown>;
  listings: Map<string, Listed[]>;
  accounts: Map<string, { data: Buffer; owner: PublicKey }>;
  counts: { getTransaction: number };
}): Connection {
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  return {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      args.counts.getTransaction += 1;
      return args.txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(DEST)) return { data: token, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
      const hit = args.accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
    async getSignaturesForAddress(address: PublicKey, config?: { before?: string; limit?: number }) {
      const listed = args.listings.get(address.toBase58()) ?? [];
      const start = config?.before ? listed.findIndex((item) => item.signature === config.before) + 1 : 0;
      const limit = config?.limit ?? listed.length;
      return listed
        .slice(start, start + limit)
        .map((item) => ({ signature: item.signature, slot: item.slot, err: item.err, memo: null, blockTime: item.blockTime, confirmationStatus: "confirmed" as const }));
    },
  } as unknown as Connection;
}

// Tenure i: open-i, then chargesPerTenure charges, then close-i for every
// tenure but the last. The last tenure is live and its ring holds its own
// charges only. Every tenure's charge k carries nonce k and the same amount,
// a twin across tenures. Charge timestamps are 400 s apart.
function tenures(mandateId: bigint, limitsByTenure: Limits[], chargesPerTenure = 1) {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const steps: Step[] = [];
  const charges: ChargeStep[][] = [];
  let slot = 0;
  let stamp = T0;
  limitsByTenure.forEach((limits, index) => {
    const i = index + 1;
    slot += 1;
    steps.push({ kind: "open", signature: `open-${i}`, slot, limits });
    const own: ChargeStep[] = [];
    for (let k = 1; k <= chargesPerTenure; k += 1) {
      slot += 1;
      stamp += 400;
      const charge: ChargeStep = { kind: "charge", signature: `charge-${i}-${k}`, slot, amount: 100_000, nonce: k, timestamp: stamp };
      steps.push(charge);
      own.push(charge);
    }
    charges.push(own);
    if (i < limitsByTenure.length) {
      slot += 1;
      steps.push({ kind: "close", signature: `close-${i}`, slot });
    }
  });
  const txs = new Map<string, unknown>();
  for (const step of steps) {
    if (step.kind === "open") txs.set(step.signature, openTx(mandate, ledger, mandateId, step));
    else if (step.kind === "close") txs.set(step.signature, closeTx(mandate, ledger, step));
    else txs.set(step.signature, chargeTx(mandate, ledger, step));
  }
  const listed: Listed[] = [...steps]
    .reverse()
    .map((step) => ({ signature: step.signature, slot: step.slot, err: null, blockTime: step.kind === "charge" ? step.timestamp : T0 + step.slot }));
  const last = charges[charges.length - 1]!;
  const rows: Row[] = last.map((c) => ({ amount: c.amount, nonce: c.nonce, timestamp: c.timestamp }));
  const liveLimits = limitsByTenure[limitsByTenure.length - 1]!;
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [mandate.toBase58(), { data: encodeMandate(mandateId, liveLimits, rows.length), owner: PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: PROGRAM }],
  ]);
  const listings = new Map<string, Listed[]>([
    [mandate.toBase58(), listed],
    [PROGRAM.toBase58(), listed],
  ]);
  const counts = { getTransaction: 0 };
  return { conn: node({ txs, listings, accounts, counts }), mandate, charges, counts };
}

test("critic r2 T3-A: the middle tenure's genuine record CONFIRMS with the middle tenure's limits", async () => {
  const { conn, mandate, charges } = tenures(1560n, [FIRST, SECOND, THIRD]);
  const result = await assessRecord(paidRecord(mandate, charges[1]![0]!, SECOND), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /second-tenure/);
  assert.doesNotMatch(result.text, /first-tenure|third-tenure/);
});

test("critic r2 T3-B: the middle signature carrying the live third tenure's limits does not CONFIRM", async () => {
  const { conn, mandate, charges } = tenures(1561n, [FIRST, SECOND, THIRD]);
  const result = await assessRecord(paidRecord(mandate, charges[1]![0]!, THIRD), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /limits\.(cap|purpose)/);
});

test("critic r2 T3-C: the middle signature carrying the first tenure's limits does not CONFIRM", async () => {
  const { conn, mandate, charges } = tenures(1562n, [FIRST, SECOND, THIRD]);
  const result = await assessRecord(paidRecord(mandate, charges[1]![0]!, FIRST), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /limits\.(cap|purpose)/);
});

test("critic r2 T3-D: the middle signature with its own limits and the live twin row's timestamp does not CONFIRM", async () => {
  const { conn, mandate, charges } = tenures(1563n, [FIRST, SECOND, THIRD]);
  const twin = charges[2]![0]!;
  const result = await assessRecord(paidRecord(mandate, charges[1]![0]!, SECOND, twin.timestamp), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /timestamp/);
});

test("critic r2 T3-E control: the live third tenure's own record CONFIRMS against the live account and ring", async () => {
  const { conn, mandate, charges } = tenures(1564n, [FIRST, SECOND, THIRD]);
  const result = await assessRecord(paidRecord(mandate, charges[2]![0]!, THIRD), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /VERDICT: CONFIRMED/);
  assert.doesNotMatch(result.text, /ledger ring no longer holds/);
});

test("critic r2 T3-F control: the first tenure's genuine record CONFIRMS with the first tenure's limits", async () => {
  const { conn, mandate, charges } = tenures(1565n, [FIRST, SECOND, THIRD]);
  const result = await assessRecord(paidRecord(mandate, charges[0]![0]!, FIRST), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /first-tenure/);
});

// The owner reopens the same rule: the middle tenure and the live tenure have
// identical limits. The middle tenure is still not the live tenure, and the
// live ring holds only the third twin.
test("critic r2 T3-G: a middle tenure whose limits equal the live tenure's still CONFIRMS its own genuine record", async () => {
  const { conn, mandate, charges } = tenures(1566n, [FIRST, SECOND, SECOND]);
  const result = await assessRecord(paidRecord(mandate, charges[1]![0]!, SECOND), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /VERDICT: CONFIRMED/);
});

test("critic r2 T3-H: with identical limits, the middle signature carrying the live twin row's timestamp does not CONFIRM", async () => {
  const { conn, mandate, charges } = tenures(1567n, [FIRST, SECOND, SECOND]);
  const twin = charges[2]![0]!;
  const result = await assessRecord(paidRecord(mandate, charges[1]![0]!, SECOND, twin.timestamp), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
});

test("critic r2 T3-I: the first tenure reopened with identical limits, its genuine record CONFIRMS and its twin-stamped record does not", async () => {
  const { conn, mandate, charges } = tenures(1568n, [FIRST, FIRST]);
  const genuine = await assessRecord(paidRecord(mandate, charges[0]![0]!, FIRST), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
  const stamped = await assessRecord(paidRecord(mandate, charges[0]![0]!, FIRST, charges[1]![0]!.timestamp), RPC, conn, OPTS);
  assert.equal(stamped.ok, false, stamped.text);
  assert.doesNotMatch(stamped.text, /VERDICT: CONFIRMED/);
});

// Cost. One live tenure, twelve charges. Verifying one record used to fetch
// one transaction. The live tenure check must not fetch the whole history to
// learn that no open sits above a recent signature.
test("critic r2 COST: verifying the second-newest record of a single-tenure live mandate does not fetch every transaction", async () => {
  const { conn, mandate, charges, counts } = tenures(1569n, [FIRST], 12);
  const target = charges[0]![10]!;
  const result = await assessRecord(paidRecord(mandate, target, FIRST), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.ok(
    counts.getTransaction <= 4,
    `getTransaction called ${counts.getTransaction} times for one record on a mandate with 13 signatures`,
  );
});

test("critic r2 COST control: verifying the newest record of a single-tenure live mandate fetches one transaction", async () => {
  const { conn, mandate, charges, counts } = tenures(1570n, [FIRST], 12);
  const target = charges[0]![11]!;
  const result = await assessRecord(paidRecord(mandate, target, FIRST), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.equal(counts.getTransaction, 1, `getTransaction called ${counts.getTransaction} times`);
});

// Issue 161. A mandate-scoped date_range decides tenure once for the bundle.
// Three separate records of the same history each walk it. The bundle must not.
test("a mandate-scoped date_range decides tenure once for the bundle, not once per row", async () => {
  const bundleRun = tenures(1800n, [FIRST], 12);
  const oldest = bundleRun.charges[0]!.slice(0, 3);
  const rows = oldest.map((charge) => paidRecord(bundleRun.mandate, charge, FIRST));
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: PROGRAM.toBase58(),
    scope: {
      type: "date_range",
      mandate: bundleRun.mandate.toBase58(),
      from: Number(oldest[0]!.timestamp),
      to: Number(oldest[oldest.length - 1]!.timestamp),
    },
    decisions: rows,
  });
  const result = await assessBundle(bundle, RPC, bundleRun.conn, OPTS);
  assert.equal(result.ok, true, result.text);
  let separate = 0;
  for (const charge of oldest) {
    const one = tenures(1802n, [FIRST], 12);
    const single = await assessRecord(paidRecord(one.mandate, charge, FIRST), RPC, one.conn, OPTS);
    assert.equal(single.ok, true, single.text);
    separate += one.counts.getTransaction;
  }
  assert.ok(
    bundleRun.counts.getTransaction < separate,
    `bundle fetched ${bundleRun.counts.getTransaction} transactions, three separate records fetched ${separate}`,
  );
});
