// Security critic, PR 207 round 1 (issue 204).
// Question under test: export after close must not bind a record to another
// tenure's limits or ring, and must not write a record that verifies
// CONFIRMED for a decision the chain does not hold.
// S1, S2: the mandate account is gone but a ledger is still readable (an RPC
//       read that straddles a reopen, or two nodes behind one endpoint). That
//       ring belongs to another tenure. verify refuses it (ringSuperseded);
//       export on the head binds its twin row and takes that row's timestamp,
//       on the signature path (export.ts:151-173, :213-221) and on the indexer
//       path (:280-286, :296).
// S3 (control): a charge in the same transaction as its open is not covered
//       by the walk. Export must throw on both paths, not write a record.
// S4 (control): a charge in the same transaction as the close is covered by
//       the tenure it closes. Export binds that tenure and verify confirms.
// S5 (control): the tenure-1 record with the tenure-2 twin's signature does
//       not verify. Same nonce, amount, counterparty; other limits and time.
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
  | ({ kind: "open+charge"; limits: Limits } & Charge)
  | ({ kind: "charge+close" } & Charge);

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
  if (step.kind === "open+charge") {
    const keys = [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM, AGENT, DEST];
    return tx(
      step.slot,
      step.timestamp,
      keys,
      [
        { programIdIndex: 7, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], data: encodeOpen(mandateId, step.limits) },
        { programIdIndex: 7, accountKeyIndexes: [8, 1, 2, 3, 9, 4, 5], data: chargeData(step) },
      ],
      [...openLogs(), ...chargeLogs(mandate, step)],
    );
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

// No mandate account is ever served: every tenure is closed. `staleRing`
// serves a ledger anyway, the shape of a read that straddles a reopen.
function chain(mandateId: bigint, steps: Step[], staleRing?: Charge[]): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const txs = new Map<string, unknown>();
  for (const step of steps) txs.set(step.signature, stepTx(mandate, ledger, mandateId, step));
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const newestFirst = [...steps].reverse();
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(DEST)) return { data: token, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
      if (staleRing && address.equals(ledger)) return { data: encodeLedger(mandate, staleRing), owner: PROGRAM, executable: false, lamports: 1 };
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

const FIRST: Limits = { cap: 1_000_000n, purpose: "first-tenure" };
const SECOND: Limits = { cap: 2_000_000n, purpose: "second-tenure" };
// Nonces restart per tenure: the twin shares nonce and amount, lands a day later.
const charge1: Charge = { signature: "charge-1", slot: 2, amount: 100_000, nonce: 1, timestamp: 1_790_200_100 };
const twin: Charge = { signature: "charge-2", slot: 5, amount: 100_000, nonce: 1, timestamp: 1_790_300_900 };

const doublyClosed: Step[] = [
  { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
  { kind: "charge", ...charge1 },
  { kind: "close", signature: "close-1", slot: 3 },
  { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
  { kind: "charge", ...twin },
  { kind: "close", signature: "close-2", slot: 6 },
];

test("critic sec r1 pr207 S1: export --signature with the mandate gone takes no ring row from another tenure", async () => {
  const stale = chain(2201n, doublyClosed, [twin]);
  const { value: record, lines } = await capture(() =>
    recordFromSignature(stale.conn, charge1.signature, PROGRAM, "devnet", DEVNET_GENESIS),
  );
  assert.equal(record.limits.purpose, FIRST.purpose);
  assert.ok(lines.includes(`note: ${NOTE}`), lines.join("\n"));
  assert.equal(record.timestamp, BigInt(charge1.timestamp), "ts must come from the charge transaction, not the stale ring's twin row");
  // The settled chain: both tenures closed, no ledger.
  const settled = chain(2201n, doublyClosed);
  const written = parseRecord(JSON.parse(recordToJson(record)));
  const verdict = await assessRecord(written, RPC, settled.conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
});

test("critic sec r1 pr207 S2: export --mandate with the mandate gone takes no ring row from another tenure", async () => {
  const stale = chain(2202n, doublyClosed, [twin]);
  const { value: records } = await capture(() =>
    recordsFromIndexedDecisions({
      conn: stale.conn,
      programId: PROGRAM,
      cluster: "devnet",
      genesisHash: DEVNET_GENESIS,
      decisions: [indexed(stale.mandate, charge1)],
    }),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]!.limits.purpose, FIRST.purpose);
  assert.equal(records[0]!.timestamp, BigInt(charge1.timestamp), "ts must come from the indexed charge, not the stale ring's twin row");
  const settled = chain(2202n, doublyClosed);
  const verdict = await assessRecord(records[0]!, RPC, settled.conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
});

test("critic sec r1 pr207 S3 (control): a charge in the same transaction as its open exports nothing on either path", async () => {
  const composite: Charge = { signature: "open-2-and-charge", slot: 4, amount: 100_000, nonce: 1, timestamp: 1_790_300_900 };
  const { conn, mandate } = chain(2203n, [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    { kind: "charge", ...charge1 },
    { kind: "close", signature: "close-1", slot: 3 },
    { kind: "open+charge", limits: SECOND, ...composite },
    { kind: "close", signature: "close-2", slot: 6 },
  ]);
  await assert.rejects(
    capture(() => recordFromSignature(conn, composite.signature, PROGRAM, "devnet", DEVNET_GENESIS)),
    /mandate history does not cover signature/,
  );
  await assert.rejects(
    capture(() =>
      recordsFromIndexedDecisions({
        conn,
        programId: PROGRAM,
        cluster: "devnet",
        genesisHash: DEVNET_GENESIS,
        decisions: [indexed(mandate, composite)],
      }),
    ),
    /mandate history does not cover signature/,
  );
});

test("critic sec r1 pr207 S4 (control): a charge in the same transaction as the close binds the tenure it closes", async () => {
  const composite: Charge = { signature: "charge-and-close-1", slot: 2, amount: 100_000, nonce: 1, timestamp: 1_790_200_100 };
  const { conn } = chain(2204n, [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    { kind: "charge+close", ...composite },
    { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
    { kind: "charge", ...twin },
    { kind: "close", signature: "close-2", slot: 6 },
  ]);
  const { value: record } = await capture(() => recordFromSignature(conn, composite.signature, PROGRAM, "devnet", DEVNET_GENESIS));
  assert.equal(record.limits.purpose, FIRST.purpose);
  assert.equal(record.timestamp, BigInt(composite.timestamp));
  const verdict = await assessRecord(parseRecord(JSON.parse(recordToJson(record))), RPC, conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
  assert.match(verdict.text, /VERDICT: CONFIRMED/);
});

test("critic sec r1 pr207 S5 (control): the tenure-1 record under the tenure-2 twin's signature does not verify", async () => {
  const { conn } = chain(2205n, doublyClosed);
  const { value: record } = await capture(() => recordFromSignature(conn, charge1.signature, PROGRAM, "devnet", DEVNET_GENESIS));
  const plain = JSON.parse(recordToJson(record)) as { signature: string };
  plain.signature = twin.signature;
  const verdict = await assessRecord(parseRecord(plain), RPC, conn, OPTS);
  assert.equal(verdict.ok, false, verdict.text);
  assert.match(verdict.text, /VERDICT: REJECTED/);
  assert.match(verdict.text, /limits\.cap: record has 1000000, chain has 2000000/);
  assert.match(verdict.text, /timestamp \(transaction\)/);
});
