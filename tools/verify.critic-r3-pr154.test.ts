// Backend critic, PR 154 round 3.
// The fix decides the live tenure by identity when the mandate listing holds
// the record. When the listing is EMPTY it falls back to the live ring
// (verify.ts limitSource, `ringHolds = pages.length === 0 && ...`): a ring row
// with the record's mandate, nonce, and amount is taken as proof that the
// live account is the record's tenure. A live mandate's listing always holds
// at least its own open, so an empty listing proves the index is incomplete,
// and the ring triple is a value match that a reopened tenure's twin row
// satisfies. Same PDA, two tenures, a nonce and amount twin in each, the
// second twin one second after the first.
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
const T0 = 1_790_300_000;

type Limits = { cap: bigint; purpose: string };
const FIRST: Limits = { cap: 1_000_000n, purpose: "first-tenure" };
const SECOND: Limits = { cap: 2_000_000n, purpose: "second-tenure" };

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

// One fake node. Signature listings are per address, newest first; an address
// with no listing entry returns an empty page, which is what a provider whose
// address index lags or has shorter retention than its transaction store does.
function node(args: {
  txs: Map<string, unknown>;
  listings: Map<string, Listed[]>;
  accounts: Map<string, { data: Buffer; owner: PublicKey }>;
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
      const listed = args.listings.get(address.toBase58()) ?? [];
      const start = config?.before ? listed.findIndex((item) => item.signature === config.before) + 1 : 0;
      const limit = config?.limit ?? listed.length;
      return listed
        .slice(start, start + limit)
        .map((item) => ({ signature: item.signature, slot: item.slot, err: item.err, memo: null, blockTime: item.blockTime, confirmationStatus: "confirmed" as const }));
    },
  } as unknown as Connection;
}

// Tenure i: open-i, one charge, close-i for every tenure but the last. The
// last tenure is live and its ring holds its own charge only. Every tenure's
// charge carries nonce 1 and the same amount, a twin across tenures, and the
// charges land `stampStep` seconds apart. `listMandate: false` serves an
// empty listing for the mandate address; the program listing stays complete.
function tenures(mandateId: bigint, limitsByTenure: Limits[], opts: { stampStep: number; listMandate: boolean }) {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const steps: Step[] = [];
  const charges: ChargeStep[] = [];
  let slot = 0;
  let stamp = T0;
  limitsByTenure.forEach((limits, index) => {
    const i = index + 1;
    slot += 1;
    steps.push({ kind: "open", signature: `open-${i}`, slot, limits });
    slot += 1;
    stamp += opts.stampStep;
    const charge: ChargeStep = { kind: "charge", signature: `charge-${i}-1`, slot, amount: 100_000, nonce: 1, timestamp: stamp };
    steps.push(charge);
    charges.push(charge);
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
  const rows: Row[] = [{ amount: last.amount, nonce: last.nonce, timestamp: last.timestamp }];
  const liveLimits = limitsByTenure[limitsByTenure.length - 1]!;
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [mandate.toBase58(), { data: encodeMandate(mandateId, liveLimits, rows.length), owner: PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: PROGRAM }],
  ]);
  const listings = new Map<string, Listed[]>([[PROGRAM.toBase58(), listed]]);
  if (opts.listMandate) listings.set(mandate.toBase58(), listed);
  return { conn: node({ txs, listings, accounts }), mandate, charges };
}

// Chain: open(FIRST) charge-1-1 close open(SECOND) charge-2-1, live under
// SECOND, ring holds charge-2-1 only. The mandate listing is empty.

test("critic r3 T3-J: an empty mandate listing does not describe the live tenure's limits as the chain's for an earlier tenure's charge", async () => {
  const { conn, mandate, charges } = tenures(1580n, [FIRST, SECOND], { stampStep: 400, listMandate: false });
  const genuine = await assessRecord(paidRecord(mandate, charges[0]!, FIRST), RPC, conn, OPTS);
  // Fail closed (the listing does not hold the signature) or confirm on
  // FIRST are both acceptable. Naming SECOND as what the chain has is not.
  assert.doesNotMatch(genuine.text, /chain has 2000000|second-tenure/);
});

test("critic r3 T3-K: an empty mandate listing with a same-second twin in the live ring does not CONFIRM the earlier tenure's charge under the live limits", async () => {
  const { conn, mandate, charges } = tenures(1581n, [FIRST, SECOND], { stampStep: 1, listMandate: false });
  const twin = charges[1]!;
  const forged = await assessRecord(paidRecord(mandate, charges[0]!, SECOND, twin.timestamp), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/);
});

test("critic r3 T3-K control: with the mandate listing intact the same forged record REJECTS and the genuine record CONFIRMS on FIRST", async () => {
  const { conn, mandate, charges } = tenures(1582n, [FIRST, SECOND], { stampStep: 1, listMandate: true });
  const twin = charges[1]!;
  const forged = await assessRecord(paidRecord(mandate, charges[0]!, SECOND, twin.timestamp), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/);
  const genuine = await assessRecord(paidRecord(mandate, charges[0]!, FIRST), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
  assert.match(genuine.text, /VERDICT: CONFIRMED/);
  assert.match(genuine.text, /first-tenure/);
  assert.doesNotMatch(genuine.text, /second-tenure/);
});
