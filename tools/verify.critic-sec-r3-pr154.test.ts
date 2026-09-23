// Security critic, PR 154 round 3.
// R7: a refused charge claimed paid, when the mandate listing is empty and
//     the reopened live ring holds a same-second paid twin (the empty-listing
//     fallback added in the round 3 fix, verify.ts limitSource).
// R8: a refused charge claimed paid inside one tenure, no reopen: the
//     designed refuse, override, retry flow leaves a paid twin row in the
//     ring, and once the ring has rolled past the refused row the twin is the
//     only row the triple binds. Pre-existing on main; the PR's 2 s skew
//     check narrows the window, it does not close it.
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
  decodeBase58,
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
const T2 = 1_790_200_500;

type Limits = { cap: bigint; purpose: string };
const FIRST: Limits = { cap: 1_000_000n, purpose: "first-tenure" };
const SECOND: Limits = { cap: 2_000_000n, purpose: "second-tenure" };

type Row = { kind: "paid" | "refused" | "override"; amount: number; nonce: number; timestamp: number };
const KIND_OVERRIDE = 3;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(buf: Buffer): string {
  let n = buf.length === 0 ? 0n : BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

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

// One key list serves every transaction shape in this file.
// 0 OWNER, 1 mandate, 2 ledger, 3 SOURCE, 4 MINT, 5 TOKEN, 6 SYSTEM, 7 PROGRAM, 8 OUTER, 9 AGENT, 10 DEST
const KEYS = (mandate: PublicKey, ledger: PublicKey) => [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM, OUTER, AGENT, DEST];
const P = PROGRAM.toBase58();
const O = OUTER.toBase58();

// "top": the owner signs the Veto instruction directly.
// "relay": a relay program CPIs Veto, the runtime records Veto's instruction
//          under meta.innerInstructions with base58 data, Veto's frame at `depth`.
// "fake":  a relay program emits its own inner instruction whose data is shaped
//          like Veto's, under the relay's program id. Veto never ran.
type Via = "top" | "relay" | "fake";
type Part =
  | { what: "open"; limits: Limits; via: Via; depth?: number }
  | { what: "close"; via: Via; depth?: number }
  | { what: "charge"; amount: number; nonce: number; kind: "paid" | "refused"; flooded?: boolean }
  | { what: "override"; amount: number; nonce: number };

type Step = { signature: string; slot: number; blockTime?: number; parts: Part[]; err?: unknown };

const FLOOD_LINES = [`Program ${O} invoke [1]`, `Program log: ${"x".repeat(80)}`, "Log truncated"];

function chargeLines(mandate: PublicKey, part: Extract<Part, { what: "charge" }>): string[] {
  const body =
    part.kind === "paid"
      ? [
          `Program log: VETO PAID amount=${part.amount} spent=${part.amount} of cap=1 remaining=1`,
          encodePaidLog({ mandate, amount: BigInt(part.amount), nonce: BigInt(part.nonce), spent: BigInt(part.amount) }),
        ]
      : [
          `Program log: VETO REFUSED reason=5 (${reasonText(5)}) amount=${part.amount} per_tx_max=${PER_TX} remaining=1 override_to_clear=${part.amount}`,
          encodeRefusedLog({ mandate, amount: BigInt(part.amount), nonce: BigInt(part.nonce), reason: 5, suggestedOverride: BigInt(part.amount) }),
        ];
  return [`Program ${P} invoke [1]`, "Program log: Instruction: Charge", ...body, `Program ${P} success`];
}

function nested(depth: number, inner: string[]): string[] {
  let lines = inner;
  for (let d = depth - 1; d >= 1; d -= 1) lines = [`Program ${O} invoke [${d}]`, ...lines, `Program ${O} success`];
  return lines;
}

function buildTx(mandate: PublicKey, ledger: PublicKey, mandateId: bigint, step: Step): unknown {
  const compiled: { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer }[] = [];
  const innerGroups: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] = [];
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
    const data = part.what === "open" ? encodeOpen(mandateId, part.limits) : disc("close_mandate");
    const accounts = part.what === "open" ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2];
    const name = part.what === "open" ? "Program log: Instruction: OpenMandate" : "Program log: VETO CLOSED";
    if (part.via === "top") {
      compiled.push({ programIdIndex: 7, accountKeyIndexes: accounts, data });
      logs.push(`Program ${P} invoke [1]`, name, `Program ${P} success`);
      continue;
    }
    const depth = part.depth ?? 2;
    const index = compiled.length;
    compiled.push({ programIdIndex: 8, accountKeyIndexes: [...accounts, 7], data: Buffer.from([depth]) });
    if (part.via === "relay") {
      innerGroups.push({ index, instructions: [{ programIdIndex: 7, accounts, data: encodeBase58(data) }] });
      logs.push(...nested(depth, [`Program ${P} invoke [${depth}]`, name, `Program ${P} success`]));
    } else {
      innerGroups.push({ index, instructions: [{ programIdIndex: 8, accounts, data: encodeBase58(data) }] });
      logs.push(`Program ${O} invoke [1]`, name, `Program ${O} success`);
    }
  }
  return {
    slot: step.slot,
    blockTime: step.blockTime ?? step.slot,
    transaction: { message: { staticAccountKeys: KEYS(mandate, ledger), compiledInstructions: compiled } },
    meta: { err: step.err ?? null, innerInstructions: innerGroups, logMessages: flooded ? FLOOD_LINES : logs },
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

function node(args: { txs: Map<string, unknown>; listings: Map<string, Listed[]>; accounts: Map<string, { data: Buffer; owner: PublicKey }>; keep?: number }): Connection {
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
      return listed
        .slice(start, start + limit)
        .map((item) => ({ signature: item.signature, slot: item.slot, err: item.err, memo: null, blockTime: item.blockTime, confirmationStatus: "confirmed" as const }));
    },
  } as unknown as Connection;
}

function chain(mandateId: bigint, steps: Step[], live: { limits: Limits; rows: Row[] } | null, opts: { keep?: number; listMandate?: boolean } = {}) {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const txs = new Map<string, unknown>();
  for (const step of steps) txs.set(step.signature, buildTx(mandate, ledger, mandateId, step));
  const listed: Listed[] = [...steps].reverse().map((step) => ({ signature: step.signature, slot: step.slot, err: step.err ?? null, blockTime: step.blockTime ?? step.slot }));
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>();
  if (live) {
    accounts.set(mandate.toBase58(), { data: encodeMandate(mandateId, live.limits, live.rows.length), owner: PROGRAM });
    accounts.set(ledger.toBase58(), { data: encodeLedger(mandate, live.rows), owner: PROGRAM });
  }
  const listings = new Map<string, Listed[]>([
    [mandate.toBase58(), listed],
    [P, listed],
  ]);
  if (opts.listMandate === false) listings.set(mandate.toBase58(), []);
  return { conn: node({ txs, listings, accounts, keep: opts.keep }), mandate, ledger };
}

const open = (signature: string, slot: number, limits: Limits, via: Via = "top", depth?: number): Step => ({ signature, slot, parts: [{ what: "open", limits, via, depth }] });
const close = (signature: string, slot: number, via: Via = "top", depth?: number): Step => ({ signature, slot, parts: [{ what: "close", via, depth }] });
const charge = (signature: string, slot: number, timestamp: number, nonce: number, amount: number, kind: "paid" | "refused" = "paid", flooded = false): Step => ({
  signature,
  slot,
  blockTime: timestamp,
  parts: [{ what: "charge", amount, nonce, kind, flooded }],
});
const CH1 = { signature: "charge-1", amount: 100_000, nonce: 1, timestamp: T1 };
const REFUSED = { signature: "refused-1", amount: 400_000, nonce: 1, timestamp: T1 };
const TWIN: Row = { kind: "paid", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 };

// R7. Round 2 R6-B again, with the mandate listing empty. The round 3 fix
// requires the listing to contain the record's signature, except when the
// listing is empty and the live ring holds the triple. The live ring belongs
// to the reopened tenure and holds the paid twin, so the exception is met by
// exactly the record it was meant to refuse.
test("critic sec r3 R7: a refused charge claimed paid does not CONFIRM through an empty mandate listing and a reopened ring holding a same-second paid twin", async () => {
  let id = 1700n;
  const confirmed: string[] = [];
  for (const rule of [FIRST, SECOND]) {
    const { conn, mandate } = chain(
      id++,
      [open("open-1", 1, FIRST), charge(REFUSED.signature, 2, T1, REFUSED.nonce, REFUSED.amount, "refused", true), close("close-1", 3), open("open-2", 4, rule), charge("twin", 5, T1, TWIN.nonce, TWIN.amount)],
      { limits: rule, rows: [TWIN] },
      { listMandate: false },
    );
    const label = rule === FIRST ? "same rule" : "distinct rule";
    const forged = await assessRecord(record(mandate, REFUSED, rule, "paid"), RPC, conn, OPTS);
    if (forged.ok || /VERDICT: CONFIRMED/.test(forged.text)) confirmed.push(label);
  }
  assert.deepEqual(confirmed, [], `refused-1 CONFIRMED as paid for: ${confirmed.join(", ")}`);
});

test("critic sec r3 R7 control: the same claim with the mandate listing intact REJECTS", async () => {
  const { conn, mandate } = chain(
    1710n,
    [open("open-1", 1, FIRST), charge(REFUSED.signature, 2, T1, REFUSED.nonce, REFUSED.amount, "refused", true), close("close-1", 3), open("open-2", 4, FIRST), charge("twin", 5, T1, TWIN.nonce, TWIN.amount)],
    { limits: FIRST, rows: [TWIN] },
  );
  const forged = await assessRecord(record(mandate, REFUSED, FIRST, "paid"), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/);
});

// R8. One tenure, live, never reopened, listing intact. The agent's charge of
// 400000 (nonce 1) is refused over per_tx_max with its log flooded; the owner
// grants an override for that nonce and amount; the agent fires `fillers`
// over-limit charges (each a refused ring row) and then retries nonce 1 for
// 400000, paid, `twinAt` seconds after the refusal. With 31 fillers the ring
// (capacity 32) has rolled past the refused row and the override row, so the
// only row the triple binds is the paid retry.
function oneTenure(mandateId: bigint, fillers: number, twinAt: number, refusedFlooded = true) {
  const steps: Step[] = [open("open-1", 1, FIRST), charge(REFUSED.signature, 2, T1, REFUSED.nonce, REFUSED.amount, "refused", refusedFlooded)];
  const rows: Row[] = [{ kind: "refused", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 }];
  steps.push({ signature: "override-1", slot: 3, blockTime: T1 + 1, parts: [{ what: "override", amount: REFUSED.amount, nonce: REFUSED.nonce }] });
  rows.push({ kind: "override", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 + 1 });
  for (let i = 1; i <= fillers; i += 1) {
    steps.push(charge(`filler-${i}`, 4, T1 + 1, 1000 + i, 600_000, "refused"));
    rows.push({ kind: "refused", amount: 600_000, nonce: 1000 + i, timestamp: T1 + 1 });
  }
  steps.push(charge("retry-1", 5, T1 + twinAt, REFUSED.nonce, REFUSED.amount));
  rows.push({ kind: "paid", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 + twinAt });
  return chain(mandateId, steps, { limits: FIRST, rows });
}

test("critic sec r3 R8: a refused charge claimed paid does not CONFIRM once the ring has rolled past its row and holds the paid retry within the skew window", { todo: "issue 181: pre-existing on main, ring row is evidence only with the transaction decision frame" }, async () => {
  const { conn, mandate } = oneTenure(1720n, 31, 2);
  const forged = await assessRecord(record(mandate, { ...REFUSED, timestamp: T1 + 2 }, FIRST, "paid"), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/);
});

test("critic sec r3 R8 control: the retry one second outside the skew window, or the refused row still in the ring, REJECTS", async () => {
  const outside = oneTenure(1721n, 31, 3);
  const late = await assessRecord(record(outside.mandate, { ...REFUSED, timestamp: T1 + 3 }, FIRST, "paid"), RPC, outside.conn, OPTS);
  assert.equal(late.ok, false, late.text);
  assert.match(late.text, /timestamp \(transaction\)/);
  const held = oneTenure(1722n, 29, 2);
  const still = await assessRecord(record(held.mandate, { ...REFUSED, timestamp: T1 + 2 }, FIRST, "paid"), RPC, held.conn, OPTS);
  assert.equal(still.ok, false, still.text);
  assert.match(still.text, /kind \(ledger\)/);
});

test("critic sec r3 R8-G: the genuine refused record with its log intact is not REJECTED because the ring now holds only the paid retry", { todo: "issue 181: pre-existing on main, ring row is evidence only with the transaction decision frame" }, async () => {
  const { conn, mandate } = oneTenure(1723n, 31, 2, false);
  const genuine = await assessRecord(record(mandate, REFUSED, FIRST, "refused"), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
});
