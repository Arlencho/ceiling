// Security critic, PR 154 round 2.
// R1: open and close reached by CPI, with real base58 inner data at depths 2
//     and 3, bind a charge to the tenure that was open when it ran.
// R2: an inner instruction shaped like open_mandate or close_mandate from a
//     program that is not Veto, and a failed CPI'd reopen, change nothing.
// R3: a charge followed by a CPI'd close and reopen in the same transaction.
// R4: a close and reopen landing in the same slot as the charge.
// R5: a listing that omits the record's own signature on a live mandate.
// R6: a refused charge claimed paid across a superseded ring, and with a
//     same-rule reopen holding a same-second paid twin.
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

type Row = { kind: "paid" | "refused"; amount: number; nonce: number; timestamp: number };

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
    data.writeBigUInt64LE(BigInt(row.kind === "refused" ? row.amount : 0), off + 56);
    data[off + 64] = row.kind === "paid" ? KIND_PAID : KIND_REFUSED;
    data[off + 65] = row.kind === "paid" ? 0 : 5;
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
  | { what: "charge"; amount: number; nonce: number; kind: "paid" | "refused"; flooded?: boolean };

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

function chain(mandateId: bigint, steps: Step[], live: { limits: Limits; rows: Row[] } | null, keep?: number) {
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
  return { conn: node({ txs, listings, accounts, keep }), mandate, ledger };
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
const NOT_SECOND = /chain has 2000000|chain has "second-tenure"/;

test("critic sec r2 base58: the fixture encoder round-trips through the verifier's decoder", () => {
  for (const buf of [Buffer.alloc(0), Buffer.from([0, 0, 7]), disc("close_mandate"), encodeOpen(1n, SECOND)]) {
    assert.ok(decodeBase58(encodeBase58(buf)).equals(buf));
  }
});

// R1. S1 again, with instruction data the runtime would actually record.
test("critic sec r2 R1: close and open reached by CPI at depths 2 and 3 bind the charge to the tenure that was open", async () => {
  let id = 1600n;
  for (const depth of [2, 3]) {
    for (const allRelay of [false, true]) {
      const outer: Via = allRelay ? "relay" : "top";
      const { conn, mandate } = chain(
        id++,
        [open("open-1", 1, FIRST, outer, depth), close("relay-close", 2, "relay", depth), open("relay-open", 3, SECOND, "relay", depth), charge(CH1.signature, 4, T1, 1, CH1.amount), close("close-2", 5, outer, depth)],
        null,
      );
      const label = `depth=${depth} allRelay=${allRelay}`;
      const genuine = await assessRecord(record(mandate, CH1, SECOND), RPC, conn, OPTS);
      assert.equal(genuine.ok, true, `${label} genuine:\n${genuine.text}`);
      assert.match(genuine.text, /second-tenure/, label);
      const forged = await assessRecord(record(mandate, CH1, FIRST), RPC, conn, OPTS);
      assert.equal(forged.ok, false, `${label} forged:\n${forged.text}`);
      assert.match(forged.text, /limits\.cap/, label);
    }
  }
});

// R2. A relay's own inner instruction shaped like Veto's, and a failed CPI'd
// reopen, are not lifecycle events. The live tenure is still FIRST.
test("critic sec r2 R2: a Veto-shaped inner instruction from another program id, or a failed CPI'd reopen, does not move the tenure", async () => {
  const shapes: { name: string; step: Step }[] = [
    { name: "fake", step: { signature: "fake-reopen", slot: 3, parts: [{ what: "close", via: "fake" }, { what: "open", limits: SECOND, via: "fake" }] } },
    { name: "failed", step: { signature: "failed-reopen", slot: 3, err: { InstructionError: [0, "Custom"] }, parts: [{ what: "close", via: "relay" }, { what: "open", limits: SECOND, via: "relay" }] } },
  ];
  let id = 1610n;
  for (const shape of shapes) {
    const { conn, mandate } = chain(id++, [open("open-1", 1, FIRST), charge(CH1.signature, 2, T1, 1, CH1.amount), shape.step], {
      limits: FIRST,
      rows: [{ kind: "paid", amount: CH1.amount, nonce: 1, timestamp: T1 }],
    });
    const genuine = await assessRecord(record(mandate, CH1, FIRST), RPC, conn, OPTS);
    assert.equal(genuine.ok, true, `${shape.name} genuine:\n${genuine.text}`);
    const forged = await assessRecord(record(mandate, CH1, SECOND), RPC, conn, OPTS);
    assert.equal(forged.ok, false, `${shape.name} forged:\n${forged.text}`);
    assert.match(forged.text, /limits\.cap/, shape.name);
  }
});

// R3. One transaction: a top-level charge under FIRST, then a relay CPIs
// close and open(SECOND). The PDA is live with SECOND's limits and an empty
// ring. The record for that signature is the mandate's newest.
test("critic sec r2 R3: a charge followed by a CPI'd close and reopen in the same transaction is not confirmed against the reopened tenure's limits", async () => {
  const sig = "charge-then-reopen";
  const { conn, mandate } = chain(
    1620n,
    [open("open-1", 1, FIRST), { signature: sig, slot: 4, blockTime: T1, parts: [{ what: "charge", amount: CH1.amount, nonce: 1, kind: "paid" }, { what: "close", via: "relay" }, { what: "open", limits: SECOND, via: "relay" }] }],
    { limits: SECOND, rows: [] },
  );
  const row = { ...CH1, signature: sig };
  const forged = await assessRecord(record(mandate, row, SECOND), RPC, conn, OPTS);
  assert.equal(forged.ok, false, `forged:\n${forged.text}`);
  assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/);
  const genuine = await assessRecord(record(mandate, row, FIRST), RPC, conn, OPTS);
  assert.doesNotMatch(genuine.text, NOT_SECOND, `genuine:\n${genuine.text}`);
});

// R4. Separate transactions, one slot: charge under FIRST, then close and
// open(SECOND) land in the same slot. The listing orders them correctly.
test("critic sec r2 R4: a close and reopen in the same slot as the charge is not confirmed against the reopened tenure's limits", async () => {
  let id = 1630n;
  for (const via of ["top", "relay"] as const) {
    const { conn, mandate } = chain(id++, [open("open-1", 1, FIRST), charge(CH1.signature, 4, T1, 1, CH1.amount), close("close-1", 4, via), open("open-2", 4, SECOND, via)], { limits: SECOND, rows: [] });
    const forged = await assessRecord(record(mandate, CH1, SECOND), RPC, conn, OPTS);
    assert.equal(forged.ok, false, `via=${via} forged:\n${forged.text}`);
    assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/, `via=${via}`);
    const genuine = await assessRecord(record(mandate, CH1, FIRST), RPC, conn, OPTS);
    assert.doesNotMatch(genuine.text, NOT_SECOND, `via=${via} genuine:\n${genuine.text}`);
  }
});

test("critic sec r2 R4 control: the same reopen one slot later binds the charge to FIRST", async () => {
  const { conn, mandate } = chain(1640n, [open("open-1", 1, FIRST), charge(CH1.signature, 4, T1, 1, CH1.amount), close("close-1", 5, "relay"), open("open-2", 5, SECOND, "relay")], { limits: SECOND, rows: [] });
  const forged = await assessRecord(record(mandate, CH1, SECOND), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /limits\.cap/);
  const genuine = await assessRecord(record(mandate, CH1, FIRST), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
});

// R5. Two tenures, the second live. The RPC's listing for the mandate stops
// before the record's own signature: only the newest charge, or nothing.
// The record's transaction is still served, so the listing is provably short.
test("critic sec r2 R5: a listing that omits the record's own signature does not hand a live reopened tenure's limits to an earlier charge", async () => {
  const steps = [open("open-1", 1, FIRST), charge(CH1.signature, 2, T1, 1, CH1.amount), close("close-1", 3), open("open-2", 4, SECOND), charge("charge-2", 5, T2, 2, 100_000)];
  let id = 1650n;
  for (const keep of [1, 0]) {
    const { conn, mandate } = chain(id++, steps, { limits: SECOND, rows: [{ kind: "paid", amount: 100_000, nonce: 2, timestamp: T2 }] }, keep);
    const forged = await assessRecord(record(mandate, CH1, SECOND), RPC, conn, OPTS);
    assert.equal(forged.ok, false, `keep=${keep} forged:\n${forged.text}`);
    assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/, `keep=${keep}`);
    const genuine = await assessRecord(record(mandate, CH1, FIRST), RPC, conn, OPTS);
    assert.doesNotMatch(genuine.text, NOT_SECOND, `keep=${keep} genuine:\n${genuine.text}`);
  }
  const { conn, mandate } = chain(1660n, steps, { limits: SECOND, rows: [{ kind: "paid", amount: 100_000, nonce: 2, timestamp: T2 }] });
  const full = await assessRecord(record(mandate, CH1, FIRST), RPC, conn, OPTS);
  assert.equal(full.ok, true, full.text);
});

// R6. A refused charge in a closed tenure, claimed paid. The live ring belongs
// to a later tenure and holds a same-second paid twin (same nonce and amount).
const REFUSED = { signature: "refused-1", amount: 400_000, nonce: 1, timestamp: T1 };
const TWIN: Row = { kind: "paid", amount: REFUSED.amount, nonce: REFUSED.nonce, timestamp: T1 };

test("critic sec r2 R6-A: a refused charge claimed paid does not CONFIRM across a superseded ring, with or without its own log", async () => {
  let id = 1670n;
  for (const flooded of [false, true]) {
    const { conn, mandate } = chain(
      id++,
      [open("open-1", 1, FIRST), charge(REFUSED.signature, 2, T1, REFUSED.nonce, REFUSED.amount, "refused", flooded), close("close-1", 3), open("open-2", 4, SECOND), charge("twin", 5, T1, TWIN.nonce, TWIN.amount)],
      { limits: SECOND, rows: [TWIN] },
    );
    const forged = await assessRecord(record(mandate, REFUSED, FIRST, "paid"), RPC, conn, OPTS);
    assert.equal(forged.ok, false, `flooded=${flooded}:\n${forged.text}`);
    assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/, `flooded=${flooded}`);
  }
});

test("critic sec r2 R6-B: the same claim when the mandate was reopened with the same rule does not CONFIRM", async () => {
  let id = 1680n;
  for (const flooded of [false, true]) {
    const { conn, mandate } = chain(
      id++,
      [open("open-1", 1, FIRST), charge(REFUSED.signature, 2, T1, REFUSED.nonce, REFUSED.amount, "refused", flooded), close("close-1", 3), open("open-2", 4, FIRST), charge("twin", 5, T1, TWIN.nonce, TWIN.amount)],
      { limits: FIRST, rows: [TWIN] },
    );
    const forged = await assessRecord(record(mandate, REFUSED, FIRST, "paid"), RPC, conn, OPTS);
    assert.equal(forged.ok, false, `flooded=${flooded}:\n${forged.text}`);
    assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/, `flooded=${flooded}`);
  }
});
