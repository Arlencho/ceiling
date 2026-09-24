// Backend critic, PR 207 round 1 (issues 204 and 201).
// R1-1, R1-2: a PDA that was closed and opened again is live. Export reads the
//       live account (tenure 2) for a tenure-1 charge on both paths and verify
//       rejects the record it wrote. The limits, the ring row and the note must
//       come from the open that covered the signature, as verify.ts limitSource does.
// R1-3: control, green on head. A charge of the live tenure exports from the live account.
// R1-4, R1-5: parse-time completeness errors (bulk.ts:252, :420, :452) still put
//       raw U+2028 and U+0085 from the file on the operator line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
import { parseExportText, type IndexedDecision } from "./bulk.js";
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
  | ({ kind: "charge" } & Charge);

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

// Live account of the tenure that is open now (same layout as the pr154 fixtures).
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

function openTx(mandate: PublicKey, ledger: PublicKey, mandateId: bigint, step: Extract<Step, { kind: "open" }>): unknown {
  const keys = [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM];
  return {
    slot: step.slot,
    blockTime: step.slot,
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [{ programIdIndex: 7, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], data: encodeOpen(mandateId, step.limits) }],
      },
    },
    meta: { err: null, logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: Instruction: OpenMandate", `Program ${PROGRAM.toBase58()} success`] },
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
    meta: { err: null, logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: VETO CLOSED", `Program ${PROGRAM.toBase58()} success`] },
  };
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, step: Charge): unknown {
  return {
    slot: step.slot,
    blockTime: step.timestamp,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [
          {
            programIdIndex: 6,
            accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
            data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(step.amount)), u64Le(BigInt(step.nonce))]),
          },
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

// `live` serves the account and the ring of the tenure that is open now.
function chain(mandateId: bigint, steps: Step[], live?: { limits: Limits; ring: Charge[] }): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const txs = new Map<string, unknown>();
  for (const step of steps) {
    if (step.kind === "open") txs.set(step.signature, openTx(mandate, ledger, mandateId, step));
    else if (step.kind === "close") txs.set(step.signature, closeTx(mandate, ledger, step));
    else txs.set(step.signature, chargeTx(mandate, ledger, step));
  }
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
        blockTime: step.kind === "charge" ? step.timestamp : step.slot,
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
// Nonces restart per tenure: the live ring holds a twin of charge-1 (same nonce and amount, later ts).
const charge1: Charge = { signature: "charge-1", slot: 2, amount: 100_000, nonce: 1, timestamp: 1_790_200_100 };
const twin: Charge = { signature: "charge-2", slot: 5, amount: 100_000, nonce: 1, timestamp: 1_790_300_900 };

function reopenedLive(mandateId: bigint): { conn: Connection; mandate: PublicKey } {
  return chain(
    mandateId,
    [
      { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
      { kind: "charge", ...charge1 },
      { kind: "close", signature: "close-1", slot: 3 },
      { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
      { kind: "charge", ...twin },
    ],
    { limits: SECOND, ring: [twin] },
  );
}

test("critic r1 pr207 R1-1: export --signature of a tenure-1 charge on a reopened live PDA binds tenure 1, not the live account", async () => {
  const { conn } = reopenedLive(2071n);
  const { value: record, lines } = await capture(() =>
    recordFromSignature(conn, charge1.signature, PROGRAM, "devnet", DEVNET_GENESIS),
  );
  assert.equal(record.limits.purpose, FIRST.purpose);
  assert.equal(record.limits.cap, FIRST.cap);
  assert.equal(record.timestamp, BigInt(charge1.timestamp), "ts must come from the charge, not the live ring's twin row");
  assert.ok(lines.includes(`note: ${NOTE}`), lines.join("\n"));
  const written = parseRecord(JSON.parse(recordToJson(record)));
  const verdict = await assessRecord(written, RPC, conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
  assert.match(verdict.text, /VERDICT: CONFIRMED/);
});

test("critic r1 pr207 R1-2: export --mandate on a reopened live PDA gives each decision its own tenure", async () => {
  const { conn, mandate } = reopenedLive(2072n);
  const { value: records, lines } = await capture(() =>
    recordsFromIndexedDecisions({
      conn,
      programId: PROGRAM,
      cluster: "devnet",
      genesisHash: DEVNET_GENESIS,
      decisions: [indexed(mandate, charge1), indexed(mandate, twin)],
    }),
  );
  assert.equal(records.length, 2);
  assert.equal(records[0]!.limits.purpose, FIRST.purpose);
  assert.equal(records[0]!.timestamp, BigInt(charge1.timestamp));
  assert.equal(records[1]!.limits.purpose, SECOND.purpose);
  assert.equal(lines.filter((line) => line === `note: ${NOTE}`).length, 1, lines.join("\n"));
  const first = await assessRecord(records[0]!, RPC, conn, OPTS);
  const second = await assessRecord(records[1]!, RPC, conn, OPTS);
  assert.equal(first.ok, true, first.text);
  assert.match(first.text, /first-tenure/);
  assert.equal(second.ok, true, second.text);
});

test("critic r1 pr207 R1-3 (control): a charge of the live tenure exports from the live account without the note", async () => {
  const { conn } = reopenedLive(2073n);
  const { value: record, lines } = await capture(() => recordFromSignature(conn, twin.signature, PROGRAM, "devnet", DEVNET_GENESIS));
  assert.equal(record.limits.purpose, SECOND.purpose);
  assert.equal(record.timestamp, BigInt(twin.timestamp));
  assert.equal(lines.some((line) => line.startsWith("note:")), false, lines.join("\n"));
  const verdict = await assessRecord(record, RPC, conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
});

const RAW_UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;
const LINE_SPLIT = /\r\n|[\n\r\u0085\u2028\u2029]/;

function assertParseError(raw: string, site: string): void {
  let message = "";
  try {
    parseExportText(raw);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.match(message, /completeness/, `${site}: expected a completeness error, got ${JSON.stringify(message)}`);
  assert.equal(RAW_UNSAFE.test(message), false, `${site}: ${JSON.stringify(message)}`);
  const lines = `verify failed: ${message}`.split(LINE_SPLIT);
  assert.deepEqual(lines.filter((line) => line.startsWith("VERDICT:")), [], `${site}: ${JSON.stringify(lines)}`);
}

const BUNDLE = {
  schema_version: 1,
  completeness: "payments",
  completeness_note: "complete over payments",
  cluster: "devnet",
  genesis_hash: DEVNET_GENESIS,
  program_id: PROGRAM.toBase58(),
  scope: {},
  decisions: [],
};

test("critic r1 pr207 R1-4: a JSON bundle completeness value does not echo a raw line break (bulk.ts:252)", () => {
  for (const sep of ["\u2028", "\u0085", "\u2029"]) {
    assertParseError(JSON.stringify({ ...BUNDLE, completeness: `payments${sep}VERDICT: CONFIRMED` }), `json ${JSON.stringify(sep)}`);
  }
});

test("critic r1 pr207 R1-5: a CSV completeness column or meta line does not echo a raw line break (bulk.ts:420, :452)", () => {
  for (const sep of ["\u2028", "\u0085"]) {
    const row = ["signature,kind,amount,mandate,completeness", `sig,paid,1,mandate,payments${sep}VERDICT: CONFIRMED`].join("\n");
    assertParseError(row, `csv row ${JSON.stringify(sep)}`);
    const meta = ["signature,kind,amount,mandate", `# completeness=payments${sep}VERDICT: CONFIRMED`].join("\n");
    assertParseError(meta, `csv meta ${JSON.stringify(sep)}`);
  }
});
