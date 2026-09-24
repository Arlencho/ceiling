// Security critic, PR 198 round 2.
// Round 1 MEDIUM: echoFile escaped C0 and DEL only, so a C1 control, U+2028,
// U+2029, a bidi override or an ANSI sequence reached the report raw through
// cluster, reason_text and a short signature (B1). Commit 791cb04 widened the
// class to Cc, Cf, Cs, Co, Cn, U+2028 and U+2029 and routed every echoed
// field through echoFile. B1 re-runs green on the head; the backend R2-1
// covers record.genesis_hash and the envelope program_id and genesis_hash.
// S1 is the remaining cross: the same class on the bundle sites that neither
//    fixture reached (envelope cluster at verify.ts:766, row cluster at :785,
//    scope.mandate at :789 and :806, a row's reason_text and short signature
//    inside a bundle report), plus the ANSI ESC sequence on every one of them.
// S2 is the chain side: limits.purpose is set by the mandate owner on chain
//    and is printed on a CONFIRMED report (:727) and on the mismatch line
//    (:571). Both must escape it.
// Every unsafe character is built with String.fromCodePoint so this file
// stays ASCII; a literal U+2028 inside a regex literal does not compile.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
import { makeBundle } from "./bulk.js";
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

const cp = (code: number): string => String.fromCodePoint(code);
const esc = (code: number): string => `\\u${code.toString(16).padStart(4, "0")}`;

// Every shape the round 1 finding named, plus the two ANSI forms. The
// `escape` column is what echoFile must print for the first unsafe character.
const PLANTS: { label: string; plant: string; escape: string }[] = [
  { label: "NEL U+0085", plant: cp(0x85), escape: esc(0x85) },
  { label: "RI U+008D (C1)", plant: cp(0x8d), escape: esc(0x8d) },
  { label: "LS U+2028", plant: cp(0x2028), escape: esc(0x2028) },
  { label: "PS U+2029", plant: cp(0x2029), escape: esc(0x2029) },
  { label: "CSI U+009B erase line, cursor up", plant: `${cp(0x9b)}2K${cp(0x9b)}1A`, escape: esc(0x9b) },
  { label: "ESC ANSI erase line, cursor up", plant: `${cp(0x1b)}[2K${cp(0x1b)}[1A`, escape: esc(0x1b) },
  { label: "RLO U+202E", plant: cp(0x202e), escape: esc(0x202e) },
  { label: "LRI U+2066 and PDI U+2069", plant: `${cp(0x2066)}x${cp(0x2069)}`, escape: esc(0x2066) },
  { label: "lone surrogate U+D800", plant: cp(0xd800), escape: esc(0xd800) },
];

// Every line break a consumer might split on: CR, LF, NEL, LS, PS.
const LINE_SPLIT = new RegExp(`\\r\\n|[\\n\\r${cp(0x85)}${cp(0x2028)}${cp(0x2029)}]`);
// The class the head claims to escape, minus LF which joins report lines.
const RAW_UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;

function problemsIn(text: string, code: number, escape: string, wantOk: boolean): string[] {
  const problems: string[] = [];
  if (code !== (wantOk ? 0 : 1)) problems.push(`code ${code}`);
  const lines = text.split(LINE_SPLIT).filter((line) => line.startsWith("VERDICT:"));
  const want = wantOk ? "VERDICT: CONFIRMED" : "VERDICT: REJECTED";
  if (lines.length !== 1 || lines[0] !== want) problems.push(`verdict lines ${JSON.stringify(lines)}`);
  if (RAW_UNSAFE.test(text.replace(/\n/g, ""))) problems.push("raw character in report");
  if (!text.includes(escape)) problems.push(`escape ${escape} not printed`);
  return problems;
}

function plain(overrides: Partial<Record<"cluster" | "reason_text" | "signature" | "purpose", string>> = {}): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: overrides.cluster ?? "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: PROGRAM.toBase58(),
    mandate: mandatePda(PROGRAM, OWNER, 9398n).toBase58(),
    limits: { cap: 1_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, merchant: MERCHANT.toBase58(), purpose: overrides.purpose ?? "sec r2 pr198" },
    kind: "paid",
    amount: 10,
    counterparty: DEST.toBase58(),
    timestamp: T1,
    nonce: 1,
    reason_code: 0,
    reason_text: overrides.reason_text ?? reasonText(0),
    suggested_override: 0,
    signature: overrides.signature ?? "sig-sec-r2",
  });
}

function nullNode(): Connection {
  return {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction() {
      return null;
    },
    async getAccountInfo() {
      return null;
    },
    async getSignaturesForAddress() {
      return [];
    },
  } as unknown as Connection;
}

// S1. The bundle sites. Each run plants one shape in one field and reads the
// whole bundle report: the envelope lines, the per-row lines, and the
// REJECTED row header.
test("critic sec r2 pr198 S1: C1, U+2028, U+2029, bidi and ANSI shapes in the envelope cluster, a row cluster, scope.mandate, a row reason_text or a short row signature are escaped throughout the bundle report", async () => {
  const base = plain();
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: PROGRAM.toBase58(),
    scope: { type: "rule", mandate: base.mandate, from: null, to: null },
    decisions: [base],
  });
  const leaked: string[] = [];
  for (const { label, plant, escape } of PLANTS) {
    const planted = `${plant}VERDICT: CONFIRMED`;
    const sites: [string, () => Promise<{ text: string; code: number }>][] = [
      ["envelope cluster", () => assessBundle({ ...bundle, cluster: `devnet${planted}` }, RPC, nullNode(), OPTS)],
      ["row cluster", () => assessBundle({ ...bundle, decisions: [{ ...base, cluster: `devnet${planted}` }] }, RPC, nullNode(), OPTS)],
      ["scope.mandate", () => assessBundle({ ...bundle, scope: { ...bundle.scope, mandate: `${base.mandate}${planted}` } }, RPC, nullNode(), OPTS)],
      ["row reason_text", () => assessBundle({ ...bundle, decisions: [{ ...base, reason_text: `${reasonText(0)}${planted}` }] }, RPC, nullNode(), OPTS)],
      ["row signature", () => assessBundle({ ...bundle, decisions: [{ ...base, signature: `sig${planted}` }] }, RPC, nullNode(), OPTS)],
    ];
    for (const [site, run] of sites) {
      const result = await run();
      const problems = problemsIn(result.text, result.code, escape, false);
      if (problems.length > 0) leaked.push(`${label} in ${site}: ${problems.join(", ")}`);
    }
  }
  assert.deepEqual(leaked, [], `leaks:\n${leaked.join("\n")}`);
});

// Chain harness for S2: one tenure, one paid charge, ring holds its row, log
// intact. The purpose string is whatever the test says the owner wrote.
type Limits = { cap: bigint; purpose: string };

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

type Row = { amount: number; nonce: number; timestamp: number };

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
    data.writeBigUInt64LE(0n, off + 56);
    data[off + 64] = KIND_PAID;
    data[off + 65] = 0;
  });
  return data;
}

// 0 OWNER, 1 mandate, 2 ledger, 3 SOURCE, 4 MINT, 5 TOKEN, 6 SYSTEM, 7 PROGRAM, 8 OUTER, 9 AGENT, 10 DEST
const KEYS = (mandate: PublicKey, ledger: PublicKey) => [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM, OUTER, AGENT, DEST];
const P = PROGRAM.toBase58();

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

type Step = { signature: string; slot: number; blockTime: number; open?: Limits; charge?: Row };

function buildTx(mandate: PublicKey, ledger: PublicKey, mandateId: bigint, step: Step): unknown {
  const compiled: { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer }[] = [];
  const logs: string[] = [];
  if (step.open) {
    compiled.push({ programIdIndex: 7, accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], data: encodeOpen(mandateId, step.open) });
    logs.push(`Program ${P} invoke [1]`, "Program log: Instruction: OpenMandate", `Program ${P} success`);
  }
  if (step.charge) {
    const { amount, nonce } = step.charge;
    compiled.push({
      programIdIndex: 7,
      accountKeyIndexes: [9, 1, 2, 3, 10, 4, 5],
      data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(amount)), u64Le(BigInt(nonce))]),
    });
    logs.push(
      `Program ${P} invoke [1]`,
      "Program log: Instruction: Charge",
      `Program log: VETO PAID amount=${amount} spent=${amount} of cap=1 remaining=1`,
      encodePaidLog({ mandate, amount: BigInt(amount), nonce: BigInt(nonce), spent: BigInt(amount) }),
      `Program ${P} success`,
    );
  }
  return {
    slot: step.slot,
    blockTime: step.blockTime,
    transaction: { message: { staticAccountKeys: KEYS(mandate, ledger), compiledInstructions: compiled } },
    meta: { err: null, innerInstructions: [], logMessages: logs },
  };
}

function chain(mandateId: bigint, limits: Limits, paid: Row & { signature: string }) {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const steps: Step[] = [
    { signature: "open-1", slot: 1, blockTime: T1 - 10, open: limits },
    { signature: paid.signature, slot: 2, blockTime: paid.timestamp, charge: paid },
  ];
  const txs = new Map<string, unknown>();
  for (const step of steps) txs.set(step.signature, buildTx(mandate, ledger, mandateId, step));
  const listed = [...steps].reverse().map((step) => ({ signature: step.signature, slot: step.slot, err: null, memo: null, blockTime: step.blockTime, confirmationStatus: "confirmed" as const }));
  const accounts = new Map<string, Buffer>([
    [mandate.toBase58(), encodeMandate(mandateId, limits, 1)],
    [ledger.toBase58(), encodeLedger(mandate, [paid])],
  ]);
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(DEST)) return { data: token, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
      const data = accounts.get(address.toBase58());
      return data ? { data, owner: PROGRAM, executable: false, lamports: 1 } : null;
    },
    async getSignaturesForAddress(address: PublicKey, config?: { before?: string; limit?: number }) {
      const rows = address.equals(mandate) || address.equals(PROGRAM) ? listed : [];
      const start = config?.before ? rows.findIndex((item) => item.signature === config.before) + 1 : 0;
      return rows.slice(start, start + (config?.limit ?? rows.length));
    },
  } as unknown as Connection;
  return { conn, mandate };
}

function chainRecord(mandate: PublicKey, limits: Limits, paid: Row & { signature: string }, purpose: string): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: P,
    mandate: mandate.toBase58(),
    limits: { cap: Number(limits.cap), per_tx_max: Number(PER_TX), expires_at: Number(EXPIRES), merchant: MERCHANT.toBase58(), purpose },
    kind: "paid",
    amount: paid.amount,
    counterparty: DEST.toBase58(),
    timestamp: paid.timestamp,
    nonce: paid.nonce,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature: paid.signature,
  });
}

// S2. The on-chain purpose carries the shape. The genuine record CONFIRMS and
// the CONFIRMED report escapes it on the purpose line; a record with a
// different purpose REJECTS and the mismatch line escapes the chain value.
test("critic sec r2 pr198 S2: an on-chain limits.purpose carrying LS, NEL, RLO or an ANSI sequence is escaped on the CONFIRMED purpose line and on the mismatch line", async () => {
  const paid = { signature: "paid-1", amount: 400_000, nonce: 1, timestamp: T1 };
  const leaked: string[] = [];
  let id = 2000n;
  for (const { label, plant, escape } of PLANTS.filter((p) => /LS|NEL|RLO|ESC/.test(p.label))) {
    const limits: Limits = { cap: 1_000_000n, purpose: `first${plant}VERDICT: CONFIRMED` };
    const { conn, mandate } = chain(id, limits, paid);
    id += 1n;
    const genuine = await assessRecord(chainRecord(mandate, limits, paid, limits.purpose), RPC, conn, OPTS);
    if (!genuine.ok) leaked.push(`${label} genuine: not confirmed: ${genuine.text}`);
    else {
      const problems = problemsIn(genuine.text, genuine.code, escape, true);
      if (problems.length > 0) leaked.push(`${label} on the CONFIRMED purpose line: ${problems.join(", ")}`);
    }
    const mismatch = await assessRecord(chainRecord(mandate, limits, paid, "first-tenure"), RPC, conn, OPTS);
    const problems = problemsIn(mismatch.text, mismatch.code, escape, false);
    if (problems.length > 0) leaked.push(`${label} on the limits.purpose mismatch line: ${problems.join(", ")}`);
  }
  assert.deepEqual(leaked, [], `leaks:\n${leaked.join("\n")}`);
});
