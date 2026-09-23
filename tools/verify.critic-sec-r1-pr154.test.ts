// Security critic, PR 154 round 1.
// S1: open_mandate and close_mandate reached by CPI from a relay are invisible
//     to mandateLifecycle (top-level instructions only), so a charge executed
//     under the hidden second tenure is bound to the first tenure's limits.
// S2: a mandate history cut by the RPC at any boundary fails closed.
// S3: no refused charge of a two-charge transaction confirms as paid, with
//     or without the transaction's own log, and with a same-second twin row.
// S4: a top-level charge behind a relay flood cannot hide from a no-mandate
//     date_range.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog, encodeRefusedLog } from "../indexer/src/events.js";
import { makeBundle } from "./bulk.js";
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

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const SYSTEM = new PublicKey("11111111111111111111111111111111");
const OUTER = new PublicKey("ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const PER_TX = 500_000n;
const EXPIRES = 1_797_713_870n;
const T1 = 1_790_200_100;
const T2 = 1_790_200_500;

type Limits = { cap: bigint; purpose: string };
const FIRST: Limits = { cap: 1_000_000n, purpose: "first-tenure" };
const SECOND: Limits = { cap: 2_000_000n, purpose: "second-tenure" };

type Row = { kind: "paid" | "refused"; amount: number; nonce: number; timestamp: number; signature: string };

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
    data.writeBigUInt64LE(BigInt(row.kind === "refused" ? row.amount : 0), off + 56);
    data[off + 64] = row.kind === "paid" ? KIND_PAID : KIND_REFUSED;
    data[off + 65] = row.kind === "paid" ? 0 : 5;
  });
  return data;
}

type Step =
  | { kind: "open"; signature: string; slot: number; limits: Limits; viaRelay?: boolean }
  | { kind: "close"; signature: string; slot: number; viaRelay?: boolean }
  | { kind: "charge"; signature: string; slot: number; amount: number; nonce: number; timestamp: number };

type ChargeStep = Extract<Step, { kind: "charge" }>;

const P = PROGRAM.toBase58();
const O = OUTER.toBase58();

// Top-level when the owner signs the instruction directly. Behind a relay the
// owner still signs the transaction, the relay CPIs Veto with the owner passed
// through as signer, and the runtime records Veto's instruction under
// meta.innerInstructions with Veto's frame at depth 2.
function openTx(mandate: PublicKey, ledger: PublicKey, mandateId: bigint, step: Extract<Step, { kind: "open" }>): unknown {
  const keys = [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM, OUTER];
  const veto = { programIdIndex: 7, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], data: encodeOpen(mandateId, step.limits) };
  const vetoLines = (depth: number) => [`Program ${P} invoke [${depth}]`, "Program log: Instruction: OpenMandate", `Program ${P} success`];
  if (!step.viaRelay) {
    return {
      slot: step.slot,
      blockTime: step.slot,
      transaction: { message: { staticAccountKeys: keys, compiledInstructions: [veto] } },
      meta: { err: null, logMessages: vetoLines(1) },
    };
  }
  return {
    slot: step.slot,
    blockTime: step.slot,
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [{ programIdIndex: 8, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6, 7], data: Buffer.from([2]) }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 7, accounts: [0, 1, 2, 3, 4, 5, 6], data: "" }] }],
      logMessages: [`Program ${O} invoke [1]`, ...vetoLines(2), `Program ${O} success`],
    },
  };
}

function closeTx(mandate: PublicKey, ledger: PublicKey, step: Extract<Step, { kind: "close" }>): unknown {
  const keys = [OWNER, mandate, ledger, PROGRAM, OUTER];
  const veto = { programIdIndex: 3, accountKeyIndexes: [0, 1, 2], data: disc("close_mandate") };
  const vetoLines = (depth: number) => [`Program ${P} invoke [${depth}]`, "Program log: VETO CLOSED", `Program ${P} success`];
  if (!step.viaRelay) {
    return {
      slot: step.slot,
      blockTime: step.slot,
      transaction: { message: { staticAccountKeys: keys, compiledInstructions: [veto] } },
      meta: { err: null, logMessages: vetoLines(1) },
    };
  }
  return {
    slot: step.slot,
    blockTime: step.slot,
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [{ programIdIndex: 4, accountKeyIndexes: [0, 1, 2, 3], data: Buffer.from([3]) }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 3, accounts: [0, 1, 2], data: "" }] }],
      logMessages: [`Program ${O} invoke [1]`, ...vetoLines(2), `Program ${O} success`],
    },
  };
}

function chargeIx(amount: number, nonce: number) {
  return {
    programIdIndex: 6,
    accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
    data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(amount)), u64Le(BigInt(nonce))]),
  };
}

function chargeLines(mandate: PublicKey, row: Row): string[] {
  const body =
    row.kind === "paid"
      ? [
          `Program log: VETO PAID amount=${row.amount} spent=${row.amount} of cap=1 remaining=1`,
          encodePaidLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), spent: BigInt(row.amount) }),
        ]
      : [
          `Program log: VETO REFUSED reason=5 (${reasonText(5)}) amount=${row.amount} per_tx_max=${PER_TX} remaining=1 override_to_clear=${row.amount}`,
          encodeRefusedLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), reason: 5, suggestedOverride: BigInt(row.amount) }),
        ];
  return [`Program ${P} invoke [1]`, "Program log: Instruction: Charge", ...body, `Program ${P} success`];
}

const CHARGE_KEYS = (mandate: PublicKey, ledger: PublicKey) => [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID, OUTER];

function chargeTx(mandate: PublicKey, ledger: PublicKey, step: ChargeStep): unknown {
  const row: Row = { kind: "paid", amount: step.amount, nonce: step.nonce, timestamp: step.timestamp, signature: step.signature };
  return {
    slot: step.slot,
    blockTime: step.timestamp,
    transaction: { message: { staticAccountKeys: CHARGE_KEYS(mandate, ledger), compiledInstructions: [chargeIx(step.amount, step.nonce)] } },
    meta: { err: null, logMessages: chargeLines(mandate, row) },
  };
}

// Instruction 0 is a relay that msg!s past the 10 KB budget; instruction 1 is
// a top-level Veto charge. The log collector is per transaction, so Veto's
// frame is gone and the runtime's bare line closes the list.
const FLOOD_LINES = [`Program ${O} invoke [1]`, `Program log: ${"x".repeat(80)}`, "Log truncated"];

function floodedTopLevelChargesTx(mandate: PublicKey, ledger: PublicKey, slot: number, blockTime: number, charges: { amount: number; nonce: number }[]): unknown {
  return {
    slot,
    blockTime,
    transaction: {
      message: {
        staticAccountKeys: CHARGE_KEYS(mandate, ledger),
        compiledInstructions: [{ programIdIndex: 8, accountKeyIndexes: [], data: Buffer.from([1]) }, ...charges.map((c) => chargeIx(c.amount, c.nonce))],
      },
    },
    meta: { err: null, logMessages: FLOOD_LINES },
  };
}

function record(mandate: PublicKey, row: { amount: number; nonce: number; timestamp: number; signature: string }, limits: Limits, kind: "paid" | "refused" = "paid"): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: P,
    mandate: mandate.toBase58(),
    limits: { cap: Number(limits.cap), per_tx_max: Number(PER_TX), expires_at: Number(EXPIRES), merchant: MERCHANT.toBase58(), purpose: limits.purpose },
    kind,
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: kind === "paid" ? 0 : 5,
    reason_text: reasonText(kind === "paid" ? 0 : 5),
    suggested_override: kind === "paid" ? 0 : row.amount,
    signature: row.signature,
  });
}

type Listed = { signature: string; slot: number; err: unknown; blockTime: number };

function pageOf(item: Listed) {
  return { signature: item.signature, slot: item.slot, err: item.err, memo: null, blockTime: item.blockTime, confirmationStatus: "confirmed" as const };
}

// One fake node. `keep` models an RPC whose listing ends early: only the
// newest `keep` signatures of every address exist, and the page comes back
// short so the caller believes it has read the whole history.
function node(args: {
  txs: Map<string, unknown>;
  listings: Map<string, Listed[]>;
  accounts: Map<string, { data: Buffer; owner: PublicKey }>;
  keep?: number;
}): Connection {
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  return {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return args.txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(DEST)) return { data: token, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
      const hit = args.accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
    async getSignaturesForAddress(address: PublicKey, config?: { before?: string; limit?: number }) {
      const all = args.listings.get(address.toBase58()) ?? [];
      const listed = args.keep === undefined ? all : all.slice(0, args.keep);
      const start = config?.before ? listed.findIndex((item) => item.signature === config.before) + 1 : 0;
      const limit = config?.limit ?? listed.length;
      return listed.slice(start, start + limit).map(pageOf);
    },
  } as unknown as Connection;
}

function chain(mandateId: bigint, steps: Step[], live: { limits: Limits; rows: Row[] } | null, keep?: number) {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const txs = new Map<string, unknown>();
  for (const step of steps) {
    if (step.kind === "open") txs.set(step.signature, openTx(mandate, ledger, mandateId, step));
    else if (step.kind === "close") txs.set(step.signature, closeTx(mandate, ledger, step));
    else txs.set(step.signature, chargeTx(mandate, ledger, step));
  }
  const listed: Listed[] = [...steps]
    .reverse()
    .map((step) => ({ signature: step.signature, slot: step.slot, err: null, blockTime: step.kind === "charge" ? step.timestamp : step.slot }));
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>();
  if (live) {
    accounts.set(mandate.toBase58(), { data: encodeMandate(mandateId, live.limits, live.rows.length), owner: PROGRAM });
    accounts.set(ledger.toBase58(), { data: encodeLedger(mandate, live.rows), owner: PROGRAM });
  }
  const listings = new Map<string, Listed[]>([
    [mandate.toBase58(), listed],
    [P, listed],
  ]);
  return { conn: node({ txs, listings, accounts, keep }), mandate, ledger };
}

const charge1: ChargeStep = { kind: "charge", signature: "charge-1", slot: 4, amount: 100_000, nonce: 1, timestamp: T1 };

// S1. open(FIRST) at the top level, then a relay CPIs close and open(SECOND),
// charge-1 runs under SECOND, and the owner closes at the top level. The PDA
// is closed now, so limitSource walks the history. Only the top-level open
// and close are visible to mandateLifecycle, so the walk reads one tenure,
// FIRST, and hands FIRST's limits to a signature that executed under SECOND.
function relayHiddenTenure(mandateId: bigint) {
  return chain(
    mandateId,
    [
      { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
      { kind: "close", signature: "relay-close", slot: 2, viaRelay: true },
      { kind: "open", signature: "relay-open", slot: 3, limits: SECOND, viaRelay: true },
      charge1,
      { kind: "close", signature: "close-2", slot: 5 },
    ],
    null,
  );
}

test("critic sec r1 S1-A: a charge executed under a tenure opened by CPI does not CONFIRM with the earlier top-level tenure's limits", async () => {
  const { conn, mandate } = relayHiddenTenure(1560n);
  const result = await assessRecord(record(mandate, charge1, FIRST), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
});

test("critic sec r1 S1-B: the verifier never attributes the hidden earlier tenure's limits to that charge, confirming or rejecting", async () => {
  const { conn, mandate } = relayHiddenTenure(1561n);
  const result = await assessRecord(record(mandate, charge1, SECOND), RPC, conn, OPTS);
  // A fix that walks inner instructions CONFIRMS this genuine record; a fix
  // that fails closed on a CPI'd lifecycle instruction REJECTS it. Either is
  // acceptable. Naming FIRST's cap as "chain has" is not.
  assert.doesNotMatch(result.text, /chain has 1000000|"first-tenure"/, result.text);
});

test("critic sec r1 S1-C control: the same lifecycle at the top level binds the charge to SECOND", async () => {
  const { conn, mandate } = chain(
    1562n,
    [
      { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
      { kind: "close", signature: "close-1", slot: 2 },
      { kind: "open", signature: "open-2", slot: 3, limits: SECOND },
      charge1,
      { kind: "close", signature: "close-2", slot: 5 },
    ],
    null,
  );
  const forged = await assessRecord(record(mandate, charge1, FIRST), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /limits\.cap/);
  const genuine = await assessRecord(record(mandate, charge1, SECOND), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
  assert.match(genuine.text, /second-tenure/);
});

// S2. Two full tenures, both closed. The RPC ends the listing after the
// newest `keep` signatures. No cut may turn a wrong-tenure record into a
// CONFIRMED one.
const charge2: ChargeStep = { kind: "charge", signature: "charge-2", slot: 5, amount: 100_000, nonce: 1, timestamp: T2 };
const TWO_TENURES: Step[] = [
  { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
  charge1,
  { kind: "close", signature: "close-1", slot: 3 },
  { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
  charge2,
  { kind: "close", signature: "close-2", slot: 6 },
];

test("critic sec r1 S2: a mandate history cut by the RPC at any boundary never confirms a wrong-tenure record", async () => {
  for (let keep = 1; keep <= TWO_TENURES.length; keep += 1) {
    const { conn, mandate } = chain(1570n + BigInt(keep), TWO_TENURES, null, keep);
    const forged = [
      ["charge-1 with SECOND", record(mandate, charge1, SECOND)],
      ["charge-2 with FIRST", record(mandate, charge2, FIRST)],
    ] as const;
    for (const [name, rec] of forged) {
      const result = await assessRecord(rec, RPC, conn, OPTS);
      assert.equal(result.ok, false, `keep=${keep} ${name}:\n${result.text}`);
      assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/, `keep=${keep} ${name}`);
    }
    // A cut that removes the first tenure's open leaves charge-1 unverifiable
    // and must say so rather than confirm it.
    if (keep < TWO_TENURES.length) {
      const genuine1 = await assessRecord(record(mandate, charge1, FIRST), RPC, conn, OPTS);
      assert.equal(genuine1.ok, false, `keep=${keep} genuine charge-1 on a cut history:\n${genuine1.text}`);
    }
  }
  const { conn, mandate } = chain(1580n, TWO_TENURES, null);
  const full = await assessRecord(record(mandate, charge1, FIRST), RPC, conn, OPTS);
  assert.equal(full.ok, true, full.text);
  const full2 = await assessRecord(record(mandate, charge2, SECOND), RPC, conn, OPTS);
  assert.equal(full2.ok, true, full2.text);
});

// S3. One transaction, two top-level charges on one mandate: nonce 7 refused
// at 600000 (per_tx_max), nonce 7 paid at 100000. The refused one, claimed
// paid, must not confirm.
function twoChargeChain(mandateId: bigint, flooded: boolean) {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const SIG = "two-charges-sec";
  const refused: Row = { kind: "refused", amount: 600_000, nonce: 7, timestamp: T1, signature: SIG };
  const paid: Row = { kind: "paid", amount: 100_000, nonce: 7, timestamp: T1, signature: SIG };
  const tx = flooded
    ? floodedTopLevelChargesTx(mandate, ledger, 1, T1, [refused, paid])
    : {
        slot: 1,
        blockTime: T1,
        transaction: {
          message: { staticAccountKeys: CHARGE_KEYS(mandate, ledger), compiledInstructions: [chargeIx(refused.amount, refused.nonce), chargeIx(paid.amount, paid.nonce)] },
        },
        meta: { err: null, logMessages: [...chargeLines(mandate, refused), ...chargeLines(mandate, paid)] },
      };
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [mandate.toBase58(), { data: encodeMandate(mandateId, FIRST, 1), owner: PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, [refused, paid]), owner: PROGRAM }],
  ]);
  const conn = node({
    txs: new Map([[SIG, tx]]),
    listings: new Map([[mandate.toBase58(), [{ signature: SIG, slot: 1, err: null, blockTime: T1 }]]]),
    accounts,
  });
  return { conn, mandate, refused, paid };
}

test("critic sec r1 S3-A: the refused charge of a two-charge transaction claimed paid does not CONFIRM", async () => {
  const { conn, mandate, refused, paid } = twoChargeChain(1590n, false);
  const forged = await assessRecord(record(mandate, refused, FIRST, "paid"), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/);
  const genuine = await assessRecord(record(mandate, paid, FIRST, "paid"), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
});

test("critic sec r1 S3-B: the same claim with the transaction's own log flooded away still does not CONFIRM", async () => {
  const { conn, mandate, refused } = twoChargeChain(1591n, true);
  const forged = await assessRecord(record(mandate, refused, FIRST, "paid"), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/);
  assert.match(forged.text, /kind \(ledger\)/);
});

test("critic sec r1 S3-C: a stale refused charge with a same-second paid twin row and a flooded log does not CONFIRM as paid", async () => {
  const mandateId = 1592n;
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const paidStep: ChargeStep = { kind: "charge", signature: "paid-6", slot: 10, amount: 100_000, nonce: 6, timestamp: T1 };
  const paidRow: Row = { kind: "paid", amount: 100_000, nonce: 6, timestamp: T1, signature: "paid-6" };
  const staleRow: Row = { kind: "refused", amount: 100_000, nonce: 6, timestamp: T1, signature: "stale-6" };
  const txs = new Map<string, unknown>([
    ["paid-6", chargeTx(mandate, ledger, paidStep)],
    ["stale-6", floodedTopLevelChargesTx(mandate, ledger, 11, T1, [staleRow])],
  ]);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [mandate.toBase58(), { data: encodeMandate(mandateId, FIRST, 1), owner: PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, [paidRow, staleRow]), owner: PROGRAM }],
  ]);
  const conn = node({
    txs,
    listings: new Map([
      [
        mandate.toBase58(),
        [
          { signature: "stale-6", slot: 11, err: null, blockTime: T1 },
          { signature: "paid-6", slot: 10, err: null, blockTime: T1 },
        ],
      ],
    ]),
    accounts,
  });
  const forged = await assessRecord(record(mandate, staleRow, FIRST, "paid"), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/);
});

// S4. No mandate in scope. A paid top-level charge sits behind a relay flood
// and is left out of the file.
test("critic sec r1 S4: a top-level paid charge behind a relay flood cannot be left out of a no-mandate date_range", async () => {
  const mandateId = 1593n;
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const shown: ChargeStep = { kind: "charge", signature: "shown-1", slot: 2, amount: 100_000, nonce: 1, timestamp: T1 };
  const hiddenRow: Row = { kind: "paid", amount: 100_000, nonce: 2, timestamp: T1 + 1, signature: "hidden-2" };
  const txs = new Map<string, unknown>([
    ["shown-1", chargeTx(mandate, ledger, shown)],
    ["hidden-2", floodedTopLevelChargesTx(mandate, ledger, 3, T1 + 1, [hiddenRow])],
  ]);
  const listed: Listed[] = [
    { signature: "hidden-2", slot: 3, err: null, blockTime: T1 + 1 },
    { signature: "shown-1", slot: 2, err: null, blockTime: T1 },
  ];
  const rows: Row[] = [{ kind: "paid", amount: shown.amount, nonce: shown.nonce, timestamp: shown.timestamp, signature: shown.signature }, hiddenRow];
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [mandate.toBase58(), { data: encodeMandate(mandateId, FIRST, 2), owner: PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: PROGRAM }],
  ]);
  const conn = node({ txs, listings: new Map([[P, listed], [mandate.toBase58(), listed]]), accounts });
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: P,
    scope: { type: "date_range", mandate: null, from: T1 - 10, to: T1 + 10 },
    decisions: [record(mandate, shown, FIRST)],
  });
  const result = await assessBundle(bundle, RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /hidden-2/);
});
