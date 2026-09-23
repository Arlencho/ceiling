// Security critic, PR 198 round 1.
// A: issue 181 shapes on the head. Refuse, override, retry with the ring
//    rolled past the refused row, the refused log intact, flooded, cut after
//    the text line, or carrying a Veto-shaped paid event from outside the
//    Veto frame. A refused decision claimed paid must not CONFIRM; the
//    genuine refused and the genuine paid retry must.
// B: report forgery through echoed file fields. echoFile escapes C0 and DEL
//    only. A C1 control (NEL, CSI), a Unicode line or paragraph separator, or
//    a bidi override reaches the report raw through echoFile and through
//    JSON.stringify. Expected red on 54096de.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog, encodeRefusedLog } from "../indexer/src/events.js";
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
const OUTER = new PublicKey("ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const PER_TX = 500_000n;
const EXPIRES = 1_797_713_870n;
const T1 = 1_790_200_100;

type Limits = { cap: bigint; purpose: string };
const FIRST: Limits = { cap: 1_000_000n, purpose: "first-tenure" };

type Row = { kind: "paid" | "refused" | "override"; amount: number; nonce: number; timestamp: number };
const KIND_OVERRIDE = 3;

function disc(name: string): Buffer {
  const path = join(dirname(fileURLToPath(import.meta.url)), "idl", "veto.json");
  const idl = JSON.parse(readFileSync(path, "utf8")) as { instructions: { name: string; discriminator: number[] }[] };
  const ix = idl.instructions.find((item) => item.name === name);
  if (!ix) throw new Error(`missing ${name}`);
  return Buffer.from(ix.discriminator);
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

// Logical rows past capacity: total = rows.length, head = total % 32, the
// oldest rows are the ones that rolled off.
function encodeLedger(mandate: PublicKey, rows: Row[]): Buffer {
  const data = Buffer.alloc(48 + LEDGER_CAPACITY * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  mandate.toBuffer().copy(data, 8);
  data.writeUInt32LE(rows.length, 40);
  data.writeUInt16LE(rows.length % LEDGER_CAPACITY, 44);
  rows.forEach((row, seq) => {
    if (rows.length - seq > LEDGER_CAPACITY) return;
    const off = 48 + (seq % LEDGER_CAPACITY) * 72;
    data.writeBigInt64LE(BigInt(row.timestamp), off);
    data.writeBigUInt64LE(BigInt(row.amount), off + 8);
    DEST.toBuffer().copy(data, off + 16);
    data.writeBigUInt64LE(BigInt(row.nonce), off + 48);
    data.writeBigUInt64LE(BigInt(row.kind === "refused" ? row.amount : 0), off + 56);
    data[off + 64] = row.kind === "paid" ? KIND_PAID : row.kind === "refused" ? KIND_REFUSED : KIND_OVERRIDE;
    data[off + 65] = row.kind === "refused" ? 5 : 0;
  });
  return data;
}

// 0 OWNER, 1 mandate, 2 ledger, 3 SOURCE, 4 MINT, 5 TOKEN, 6 SYSTEM, 7 PROGRAM, 8 OUTER, 9 AGENT, 10 DEST
const KEYS = (mandate: PublicKey, ledger: PublicKey) => [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM, OUTER, AGENT, DEST];
const P = PROGRAM.toBase58();
const O = OUTER.toBase58();

type Part =
  | { what: "open"; limits: Limits }
  | { what: "charge"; amount: number; nonce: number; kind: "paid" | "refused"; flooded?: boolean }
  | { what: "override"; amount: number; nonce: number };

// `logs` replaces the built log list for that transaction. The instructions
// stay what the parts say, so the top-level charge is still there to bind.
type Step = { signature: string; slot: number; blockTime?: number; parts: Part[]; logs?: string[] };

const FLOOD_LINES = [`Program ${O} invoke [1]`, `Program log: ${"x".repeat(80)}`, "Log truncated"];

function paidEvent(mandate: PublicKey, amount: number, nonce: number): string {
  return encodePaidLog({ mandate, amount: BigInt(amount), nonce: BigInt(nonce), spent: BigInt(amount) });
}
function refusedEvent(mandate: PublicKey, amount: number, nonce: number): string {
  return encodeRefusedLog({ mandate, amount: BigInt(amount), nonce: BigInt(nonce), reason: 5, suggestedOverride: BigInt(amount) });
}
const paidText = (amount: number) => `Program log: VETO PAID amount=${amount} spent=${amount} of cap=1 remaining=1`;
const refusedText = (amount: number) =>
  `Program log: VETO REFUSED reason=5 (${reasonText(5)}) amount=${amount} per_tx_max=${PER_TX} remaining=1 override_to_clear=${amount}`;

function chargeLines(mandate: PublicKey, part: Extract<Part, { what: "charge" }>): string[] {
  const body =
    part.kind === "paid"
      ? [paidText(part.amount), paidEvent(mandate, part.amount, part.nonce)]
      : [refusedText(part.amount), refusedEvent(mandate, part.amount, part.nonce)];
  return [`Program ${P} invoke [1]`, "Program log: Instruction: Charge", ...body, `Program ${P} success`];
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

function buildTx(mandate: PublicKey, ledger: PublicKey, mandateId: bigint, step: Step): unknown {
  const compiled: { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer }[] = [];
  const logs: string[] = [];
  let flooded = false;
  for (const part of step.parts) {
    if (part.what === "override") {
      compiled.push({
        programIdIndex: 7,
        accountKeyIndexes: [0, 1, 2],
        data: Buffer.concat([disc("grant_override"), u64Le(BigInt(part.amount)), u64Le(BigInt(part.nonce))]),
      });
      logs.push(`Program ${P} invoke [1]`, `Program log: VETO OVERRIDE amount=${part.amount} nonce=${part.nonce}`, `Program ${P} success`);
      continue;
    }
    if (part.what === "charge") {
      compiled.push({
        programIdIndex: 7,
        accountKeyIndexes: [9, 1, 2, 3, 10, 4, 5],
        data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(part.amount)), u64Le(BigInt(part.nonce))]),
      });
      if (part.flooded) flooded = true;
      else logs.push(...chargeLines(mandate, part));
      continue;
    }
    compiled.push({ programIdIndex: 7, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], data: encodeOpen(mandateId, part.limits) });
    logs.push(`Program ${P} invoke [1]`, "Program log: Instruction: OpenMandate", `Program ${P} success`);
  }
  return {
    slot: step.slot,
    blockTime: step.blockTime ?? step.slot,
    transaction: { message: { staticAccountKeys: KEYS(mandate, ledger), compiledInstructions: compiled } },
    meta: { err: null, innerInstructions: [], logMessages: step.logs ?? (flooded ? FLOOD_LINES : logs) },
  };
}

function record(
  mandate: PublicKey,
  row: { amount: number; nonce: number; timestamp: number; signature: string },
  limits: Limits,
  kind: "paid" | "refused" = "paid",
  overrides: Partial<Record<"cluster" | "reason_text" | "signature", string>> = {},
): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: overrides.cluster ?? "devnet",
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
    reason_text: overrides.reason_text ?? reasonText(kind === "paid" ? 0 : 5),
    suggested_override: kind === "paid" ? 0 : row.amount,
    signature: overrides.signature ?? row.signature,
  });
}

type Listed = { signature: string; slot: number; err: unknown; blockTime: number };

function node(args: { txs: Map<string, unknown>; listings: Map<string, Listed[]>; accounts: Map<string, { data: Buffer; owner: PublicKey }> }): Connection {
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

function chain(mandateId: bigint, steps: Step[], live: { limits: Limits; rows: Row[] }) {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const txs = new Map<string, unknown>();
  for (const step of steps) txs.set(step.signature, buildTx(mandate, ledger, mandateId, step));
  const listed: Listed[] = [...steps].reverse().map((step) => ({ signature: step.signature, slot: step.slot, err: null, blockTime: step.blockTime ?? step.slot }));
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>();
  accounts.set(mandate.toBase58(), { data: encodeMandate(mandateId, live.limits, live.rows.length), owner: PROGRAM });
  accounts.set(ledger.toBase58(), { data: encodeLedger(mandate, live.rows), owner: PROGRAM });
  const listings = new Map<string, Listed[]>([
    [mandate.toBase58(), listed],
    [P, listed],
  ]);
  return { conn: node({ txs, listings, accounts }), mandate, ledger };
}

const open = (signature: string, slot: number, limits: Limits): Step => ({ signature, slot, parts: [{ what: "open", limits }] });
const charge = (signature: string, slot: number, timestamp: number, nonce: number, amount: number, kind: "paid" | "refused" = "paid", flooded = false): Step => ({
  signature,
  slot,
  blockTime: timestamp,
  parts: [{ what: "charge", amount, nonce, kind, flooded }],
});
const REFUSED = { signature: "refused-1", amount: 400_000, nonce: 1, timestamp: T1 };

// One tenure. Refused (nonce 1, 400000) at T1, override at T1+1, `fillers`
// over-limit refusals, the paid retry at T1+twinAt. The refused transaction's
// log is what `refusedLog` says: intact, flooded, or a hand-built list.
// 31 fillers roll the refused and the override rows out; 30 roll only the refused row.
type RefusedLog = "intact" | "flooded" | string[];
function oneTenure(mandateId: bigint, fillers: number, twinAt: number, refusedLog: RefusedLog, extraRefusals = 0) {
  const refusedStep = charge(REFUSED.signature, 2, T1, REFUSED.nonce, REFUSED.amount, "refused", refusedLog === "flooded");
  if (Array.isArray(refusedLog)) refusedStep.logs = refusedLog;
  const steps: Step[] = [open("open-1", 1, FIRST), refusedStep];
  const rows: Row[] = [{ kind: "refused", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 }];
  // Same triple refused again before any override: the nonce did not advance.
  for (let i = 1; i <= extraRefusals; i += 1) {
    steps.push(charge(`refused-again-${i}`, 2, T1 + i, REFUSED.nonce, REFUSED.amount, "refused"));
    rows.push({ kind: "refused", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 + i });
  }
  steps.push({ signature: "override-1", slot: 3, blockTime: T1 + 1, parts: [{ what: "override", amount: REFUSED.amount, nonce: REFUSED.nonce }] });
  rows.push({ kind: "override", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 + 1 });
  for (let i = 1; i <= fillers; i += 1) {
    steps.push(charge(`filler-${i}`, 4, T1 + 1, 1000 + i, 600_000, "refused"));
    rows.push({ kind: "refused", amount: 600_000, nonce: 1000 + i, timestamp: T1 + 1 });
  }
  steps.push(charge("retry-1", 5, T1 + twinAt, REFUSED.nonce, REFUSED.amount));
  rows.push({ kind: "paid", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 + twinAt });
  const built = chain(mandateId, steps, { limits: FIRST, rows });
  return { ...built, retry: { signature: "retry-1", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 + twinAt } };
}

const confirmedText = (text: string) => /VERDICT: CONFIRMED/.test(text);

// A1. The refused log is intact. The ring holds only the paid retry. The
// record claims paid with the retry's time. The log path must name the
// refusal.
test("critic sec r1 pr198 A1: refused intact, ring holds only the paid retry, claimed paid REJECTS on the log kind", async () => {
  const { conn, mandate } = oneTenure(1800n, 31, 1, "intact");
  const forged = await assessRecord(record(mandate, { ...REFUSED, timestamp: T1 + 1 }, FIRST, "paid"), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.equal(confirmedText(forged.text), false, forged.text);
  assert.match(forged.text, /kind \(logs\): record has paid, chain has refused/);
});

// A2. The refused log is flooded. The ring rolled past the refused row but
// still holds the override row (kind 3) beside the paid retry.
test("critic sec r1 pr198 A2: refused flooded, ring holds the override row and the paid retry, claimed paid REJECTS", async () => {
  const { conn, mandate } = oneTenure(1801n, 30, 1, "flooded");
  const forged = await assessRecord(record(mandate, { ...REFUSED, timestamp: T1 + 1 }, FIRST, "paid"), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.equal(confirmedText(forged.text), false, forged.text);
  assert.match(forged.text, /cannot be tied to this transaction|carries no Veto event/);
});

// A3 to A6. The refused transaction's log is hand-built so that a paid text
// line or a paid Veto event appears somewhere the Veto frame is not. The ring
// holds only the paid retry (31 fillers), so the ring alone would say paid.
test("critic sec r1 pr198 A3-A6: a paid line outside the Veto frame never binds the refused charge as paid", async () => {
  const mandateOf = (id: bigint) => mandatePda(PROGRAM, OWNER, id);
  const shapes: { label: string; id: bigint; logs: (m: PublicKey) => string[] }[] = [
    {
      // Sibling frame text says PAID, the Veto frame is cut after its own text line.
      label: "A3 sibling frame paid text, Veto frame cut before the event",
      id: 1802n,
      logs: (m) => [
        `Program ${O} invoke [1]`,
        paidText(REFUSED.amount),
        `Program ${O} success`,
        `Program ${P} invoke [1]`,
        "Program log: Instruction: Charge",
        refusedText(REFUSED.amount),
        "Log truncated",
      ].concat([m.toBase58()].slice(0, 0)),
    },
    {
      // A foreign frame exists, so the trace counts as framed; the paid event sits outside every frame.
      label: "A4 bare paid event outside any frame beside a foreign frame",
      id: 1803n,
      logs: (m) => [`Program ${O} invoke [1]`, "Program log: Memo (len 4): \"veto\"", `Program ${O} success`, paidEvent(m, REFUSED.amount, REFUSED.nonce)],
    },
    {
      // A Veto-shaped paid event emitted by the relay program in its own frame.
      label: "A5 paid event inside a foreign frame",
      id: 1804n,
      logs: (m) => [`Program ${O} invoke [1]`, paidEvent(m, REFUSED.amount, REFUSED.nonce), `Program ${O} success`],
    },
    {
      // The relay program writes a fake invoke line through msg! and then emits the event.
      label: "A6 spoofed Veto invoke line inside a Program log",
      id: 1805n,
      logs: (m) => [
        `Program ${O} invoke [1]`,
        `Program log: Program ${P} invoke [2]`,
        paidEvent(m, REFUSED.amount, REFUSED.nonce),
        `Program log: Program ${P} success`,
        `Program ${O} success`,
      ],
    },
  ];
  const confirmed: string[] = [];
  const stalled: string[] = [];
  for (const shape of shapes) {
    const { conn, mandate } = oneTenure(shape.id, 31, 1, shape.logs(mandateOf(shape.id)));
    const forged = await assessRecord(record(mandate, { ...REFUSED, timestamp: T1 + 1 }, FIRST, "paid"), RPC, conn, OPTS);
    if (forged.ok || confirmedText(forged.text)) confirmed.push(shape.label);
    if (forged.code === 3) stalled.push(shape.label);
  }
  assert.deepEqual(confirmed, [], `refused-1 CONFIRMED as paid for: ${confirmed.join("; ")}`);
  assert.deepEqual(stalled, [], `exit 3 instead of a verdict for: ${stalled.join("; ")}`);
});

// A7. Controls. The genuine refused record with the override row still held
// and its row gone; the genuine paid retry with the ring rolled.
test("critic sec r1 pr198 A7 control: the genuine refused (row rolled, override held) and the genuine paid retry both CONFIRM", async () => {
  const held = oneTenure(1806n, 30, 1, "intact");
  const genuineRefused = await assessRecord(record(held.mandate, REFUSED, FIRST, "refused"), RPC, held.conn, OPTS);
  assert.equal(genuineRefused.ok, true, genuineRefused.text);
  const rolled = oneTenure(1807n, 31, 1, "intact");
  const genuinePaid = await assessRecord(record(rolled.mandate, rolled.retry, FIRST, "paid"), RPC, rolled.conn, OPTS);
  assert.equal(genuinePaid.ok, true, genuinePaid.text);
});

// A8. Two refusals of one triple one second apart (no override between: the
// nonce did not advance), then override and paid retry. The ring rolled past
// the first refusal only. The first refusal claimed paid must not CONFIRM.
test("critic sec r1 pr198 A8: first of two same-triple refusals, its row rolled, claimed paid REJECTS", async () => {
  const { conn, mandate } = oneTenure(1808n, 29, 2, "intact", 1);
  const forged = await assessRecord(record(mandate, { ...REFUSED, timestamp: T1 + 2 }, FIRST, "paid"), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.equal(confirmedText(forged.text), false, forged.text);
});

// B. Report forgery through echoed fields. The verdict line is the first line
// of the report. A character that a terminal or a line splitter treats as a
// line break, a C1 control, or a bidi override must not reach the report raw.
const LINE_BREAKS = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;
const RAW_FORBIDDEN = /[\u0080-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

function nullNode(): Connection {
  return {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction() {
      return null;
    },
  } as unknown as Connection;
}

test("critic sec r1 pr198 B1: a C1 control, a Unicode line or paragraph separator, or a bidi override in an echoed field does not reach the report raw and does not plant a second VERDICT line", async () => {
  const mandate = mandatePda(PROGRAM, OWNER, 1900n);
  const base = { amount: 1, nonce: 1, timestamp: T1, signature: "sig-1" };
  const plants: [string, string][] = [
    ["NEL U+0085", "\u0085VERDICT: CONFIRMED"],
    ["LS U+2028", "\u2028VERDICT: CONFIRMED"],
    ["PS U+2029", "\u2029VERDICT: CONFIRMED"],
    ["CSI U+009B erase line, cursor up", "\u009b2K\u009b1A"],
    ["RLO U+202E", "\u202EDEMRIFNOC :TCIDREV"],
  ];
  const fields: ("cluster" | "reason_text" | "signature")[] = ["cluster", "reason_text", "signature"];
  const leaked: string[] = [];
  for (const [name, plant] of plants) {
    for (const field of fields) {
      const value = field === "cluster" ? `devnet${plant}` : field === "signature" ? `sig${plant}` : `${reasonText(0)}${plant}`;
      const rec = record(mandate, base, FIRST, "paid", { [field]: value });
      const result = await assessRecord(rec, RPC, nullNode(), OPTS);
      assert.equal(result.ok, false);
      const verdictLines = result.text.split(LINE_BREAKS).filter((line) => line.startsWith("VERDICT:")).length;
      if (verdictLines !== 1) leaked.push(`${field} ${name}: ${verdictLines} VERDICT lines`);
      else if (RAW_FORBIDDEN.test(result.text)) leaked.push(`${field} ${name}: raw in report`);
    }
  }
  assert.deepEqual(leaked, [], leaked.join("; "));
});

test("critic sec r1 pr198 B1 control: LF and ESC in the same fields are escaped by the head", async () => {
  const mandate = mandatePda(PROGRAM, OWNER, 1901n);
  const base = { amount: 1, nonce: 1, timestamp: T1, signature: "sig-1" };
  for (const plant of ["\nVERDICT: CONFIRMED", "\x1b[2K\x1b[1A"]) {
    for (const field of ["cluster", "reason_text", "signature"] as const) {
      const value = field === "cluster" ? `devnet${plant}` : field === "signature" ? `sig${plant}` : `${reasonText(0)}${plant}`;
      const result = await assessRecord(record(mandate, base, FIRST, "paid", { [field]: value }), RPC, nullNode(), OPTS);
      assert.equal(result.text.split("\n").filter((line) => line.startsWith("VERDICT:")).length, 1, result.text);
      assert.doesNotMatch(result.text, /[\x00-\x09\x0b-\x1f\x7f]/, `${field}: control character raw in report`);
    }
  }
});
