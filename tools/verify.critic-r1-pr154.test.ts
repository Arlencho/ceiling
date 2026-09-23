// Backend critic, PR 154 round 1.
// F1: a PDA closed and opened again that is live now. The tenure that holds
//     the record's signature supplies the limits, not the live account.
// F3: a truncated transaction of another mandate does not reject a date_range
//     that names a mandate; the ring already covers that window.
// Regression checks for issues 146, 135 (CPI shape) and 136 (both records).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog, encodeRefusedLog } from "../indexer/src/events.js";
import { makeBundle } from "./bulk.js";
import { recordFromSignature } from "./export.js";
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
  const idl = JSON.parse(readFileSync(path, "utf8")) as {
    instructions: { name: string; discriminator: number[] }[];
  };
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
  | { kind: "open"; signature: string; slot: number; limits: Limits }
  | { kind: "close"; signature: string; slot: number }
  | { kind: "charge"; signature: string; slot: number; amount: number; nonce: number; timestamp: number };

type ChargeStep = Extract<Step, { kind: "charge" }>;

function openTx(mandate: PublicKey, ledger: PublicKey, mandateId: bigint, step: Extract<Step, { kind: "open" }>): unknown {
  const keys = [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM];
  return {
    slot: step.slot,
    blockTime: step.slot,
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [
          { programIdIndex: 7, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], data: encodeOpen(mandateId, step.limits) },
        ],
      },
    },
    meta: {
      err: null,
      logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: Instruction: OpenMandate", `Program ${PROGRAM.toBase58()} success`],
    },
  };
}

function closeTx(mandate: PublicKey, ledger: PublicKey, step: Extract<Step, { kind: "close" }>): unknown {
  const keys = [OWNER, mandate, ledger, PROGRAM];
  return {
    slot: step.slot,
    blockTime: step.slot,
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [{ programIdIndex: 3, accountKeyIndexes: [0, 1, 2], data: disc("close_mandate") }],
      },
    },
    meta: {
      err: null,
      logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: VETO CLOSED", `Program ${PROGRAM.toBase58()} success`],
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
  return [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: Instruction: Charge", ...body, `Program ${PROGRAM.toBase58()} success`];
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, step: ChargeStep): unknown {
  const row: Row = { kind: "paid", amount: step.amount, nonce: step.nonce, timestamp: step.timestamp, signature: step.signature };
  return {
    slot: step.slot,
    blockTime: step.timestamp,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [chargeIx(step.amount, step.nonce)],
      },
    },
    meta: { err: null, logMessages: chargeLines(mandate, row) },
  };
}

// A relay program at the top level, Veto reached by CPI, and the runtime cut
// before Veto's frame. The account keys still name the mandate.
function cpiFloodTx(mandate: PublicKey, ledger: PublicKey, slot: number, blockTime: number): unknown {
  return {
    slot,
    blockTime,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID, OUTER],
        compiledInstructions: [{ programIdIndex: 8, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7, 6], data: Buffer.from([1]) }],
      },
    },
    meta: {
      err: null,
      logMessages: [`Program ${OUTER.toBase58()} invoke [1]`, `Program log: ${"x".repeat(80)}`, "Log truncated"],
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
    limits: {
      cap: Number(limits.cap),
      per_tx_max: Number(PER_TX),
      expires_at: Number(EXPIRES),
      merchant: MERCHANT.toBase58(),
      purpose: limits.purpose,
    },
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

function pageOf(item: Listed) {
  return { signature: item.signature, slot: item.slot, err: item.err, memo: null, blockTime: item.blockTime, confirmationStatus: "confirmed" as const };
}

// One fake node. Signature listings are per address, newest first. Accounts
// are whatever is live now.
function node(args: {
  txs: Map<string, unknown>;
  listings: Map<string, Listed[]>;
  accounts: Map<string, { data: Buffer; owner: PublicKey }>;
  nullSigs?: ReadonlySet<string>;
}): Connection {
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  return {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      if (args.nullSigs?.has(signature)) return null;
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
      return listed.slice(start, start + limit).map(pageOf);
    },
  } as unknown as Connection;
}

const charge1: ChargeStep = { kind: "charge", signature: "charge-1", slot: 2, amount: 100_000, nonce: 1, timestamp: T1 };
const charge2: ChargeStep = { kind: "charge", signature: "charge-2", slot: 5, amount: 100_000, nonce: 1, timestamp: T2 };

// open(FIRST), charge-1, close, open(SECOND) [, charge-2]. The PDA is live
// under SECOND. Nonces restart with the second tenure, so charge-2 carries
// the same nonce and amount as charge-1.
function reopenedLive(mandateId: bigint, withSecondCharge: boolean): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const steps: Step[] = [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    charge1,
    { kind: "close", signature: "close-1", slot: 3 },
    { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
  ];
  if (withSecondCharge) steps.push(charge2);
  const txs = new Map<string, unknown>();
  for (const step of steps) {
    if (step.kind === "open") txs.set(step.signature, openTx(mandate, ledger, mandateId, step));
    else if (step.kind === "close") txs.set(step.signature, closeTx(mandate, ledger, step));
    else txs.set(step.signature, chargeTx(mandate, ledger, step));
  }
  const listed: Listed[] = [...steps]
    .reverse()
    .map((step) => ({ signature: step.signature, slot: step.slot, err: null, blockTime: step.kind === "charge" ? step.timestamp : step.slot }));
  const rows: Row[] = withSecondCharge
    ? [{ kind: "paid", amount: charge2.amount, nonce: charge2.nonce, timestamp: charge2.timestamp, signature: charge2.signature }]
    : [];
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [mandate.toBase58(), { data: encodeMandate(mandateId, SECOND, rows.length), owner: PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: PROGRAM }],
  ]);
  const listings = new Map<string, Listed[]>([
    [mandate.toBase58(), listed],
    [PROGRAM.toBase58(), listed],
  ]);
  return { conn: node({ txs, listings, accounts }), mandate };
}

test("critic r1 F1-A: a genuine first-tenure record of a reopened, live PDA CONFIRMS with its own tenure's limits", async () => {
  const { conn, mandate } = reopenedLive(1540n, false);
  const result = await assessRecord(paidRecord(mandate, charge1, FIRST), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /first-tenure/);
});

test("critic r1 F1-B: a first-tenure signature carrying the live second tenure's limits does not CONFIRM (ring idle)", async () => {
  const { conn, mandate } = reopenedLive(1541n, false);
  const result = await assessRecord(paidRecord(mandate, charge1, SECOND), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /limits\.(cap|purpose)/);
});

test("critic r1 F1-C: a first-tenure signature carrying the second tenure's limits and its twin row's timestamp does not CONFIRM", async () => {
  const { conn, mandate } = reopenedLive(1542n, true);
  const result = await assessRecord(paidRecord(mandate, charge1, SECOND, T2), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
});

test("critic r1 F1-D control: the second tenure's own record still CONFIRMS against the live account", async () => {
  const { conn, mandate } = reopenedLive(1543n, true);
  const result = await assessRecord(paidRecord(mandate, charge2, SECOND), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /VERDICT: CONFIRMED/);
  assert.doesNotMatch(result.text, /first-tenure/);
});

// One live mandate M with one paid charge, and a program listing that also
// carries another mandate N's transactions.
function programWithNeighbour(
  mandateId: bigint,
  neighbour: (ledgerN: PublicKey, mandateN: PublicKey, ledgerM: PublicKey, mandateM: PublicKey) => unknown | null,
  neighbourErr: unknown = null,
) {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const mandateN = mandatePda(PROGRAM, OWNER, mandateId + 1000n);
  const ledgerN = ledgerPda(PROGRAM, mandateN);
  const mine: ChargeStep = { kind: "charge", signature: `charge-${mandateId}`, slot: 2, amount: 100_000, nonce: 1, timestamp: T1 };
  const txs = new Map<string, unknown>([[mine.signature, chargeTx(mandate, ledger, mine)]]);
  const other = neighbour(ledgerN, mandateN, ledger, mandate);
  const nullSigs = new Set<string>();
  const listed: Listed[] = [{ signature: `flood-${mandateId}`, slot: 3, err: neighbourErr, blockTime: T1 + 1 }, { signature: mine.signature, slot: 2, err: null, blockTime: T1 }];
  if (other) txs.set(`flood-${mandateId}`, other);
  else nullSigs.add(`flood-${mandateId}`);
  const rows: Row[] = [{ kind: "paid", amount: mine.amount, nonce: mine.nonce, timestamp: mine.timestamp, signature: mine.signature }];
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [mandate.toBase58(), { data: encodeMandate(mandateId, FIRST, 1), owner: PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: PROGRAM }],
  ]);
  const listings = new Map<string, Listed[]>([
    [PROGRAM.toBase58(), listed],
    [mandate.toBase58(), listed],
  ]);
  const conn = node({ txs, listings, accounts, nullSigs });
  const bundleFor = (scopeMandate: string | null) =>
    makeBundle({
      cluster: "devnet",
      genesisHash: DEVNET_GENESIS,
      programId: PROGRAM.toBase58(),
      scope: { type: "date_range", mandate: scopeMandate, from: T1 - 10, to: T1 + 10 },
      decisions: [paidRecord(mandate, mine, FIRST)],
    });
  return { conn, mandate, bundleFor };
}

test("critic r1 F3: a truncated transaction of another mandate does not reject a date_range that names this mandate", async () => {
  const { conn, mandate, bundleFor } = programWithNeighbour(1544n, (ledgerN, mandateN) => cpiFloodTx(mandateN, ledgerN, 3, T1 + 1));
  const result = await assessBundle(bundleFor(mandate.toBase58()), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /VERDICT: CONFIRMED/);
});

test("critic r1 F3 control: a truncated transaction whose keys name this mandate rejects the mandate-scoped date_range", async () => {
  const { conn, mandate, bundleFor } = programWithNeighbour(1545n, (_ledgerN, _mandateN, ledgerM, mandateM) => cpiFloodTx(mandateM, ledgerM, 3, T1 + 1));
  const result = await assessBundle(bundleFor(mandate.toBase58()), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /Log truncated/);
});

test("critic r1 135 regression: a CPI'd charge under a relay whose log is cut fails a no-mandate date_range closed", async () => {
  const { conn, bundleFor } = programWithNeighbour(1546n, (ledgerN, mandateN) => cpiFloodTx(mandateN, ledgerN, 3, T1 + 1));
  const result = await assessBundle(bundleFor(null), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.equal(result.code, 1, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /flood-1546/);
  assert.match(result.text, /Log truncated/);
});

test("critic r1 146 regression: a listed signature with a null body is not checked through assessBundle, never CONFIRMED", async () => {
  const { conn, bundleFor } = programWithNeighbour(1547n, () => null);
  const result = await assessBundle(bundleFor(null), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.equal(result.code, 3, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /flood-1547/);
  assert.match(result.text, /not checked/);
});

test("critic r1 146 control: a listed signature the node marks failed stays out and the file CONFIRMS", async () => {
  const { conn, bundleFor } = programWithNeighbour(1548n, () => null, { InstructionError: [0, "Custom"] });
  const result = await assessBundle(bundleFor(null), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.equal(result.code, 0, result.text);
});

test("critic r1 136: both records of a two-charge transaction export by triple and CONFIRM", async () => {
  const mandateId = 1549n;
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const SIG = "two-charges-r1";
  const refused: Row = { kind: "refused", amount: 600_000, nonce: 7, timestamp: T1, signature: SIG };
  const paid: Row = { kind: "paid", amount: 100_000, nonce: 7, timestamp: T1, signature: SIG };
  const tx = {
    slot: 1,
    blockTime: T1,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [chargeIx(refused.amount, refused.nonce), chargeIx(paid.amount, paid.nonce)],
      },
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
  for (const row of [refused, paid]) {
    const exported = await recordFromSignature(conn, SIG, PROGRAM, "devnet", DEVNET_GENESIS, {
      mandate: mandate.toBase58(),
      nonce: BigInt(row.nonce),
      amount: BigInt(row.amount),
    });
    assert.equal(exported.kind, row.kind);
    assert.equal(exported.amount, BigInt(row.amount));
    const verdict = await assessRecord(exported, RPC, conn, OPTS);
    assert.equal(verdict.ok, true, `${row.kind}:\n${verdict.text}`);
  }
  await assert.rejects(
    () => recordFromSignature(conn, SIG, PROGRAM, "devnet", DEVNET_GENESIS, { mandate: mandate.toBase58(), nonce: 7n, amount: 1n }),
    /0 charges/,
  );
});
