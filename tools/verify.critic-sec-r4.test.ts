// Security critic, PR 121 round 4. Mock chain shape of the round 3 fixture
// (verify.critic-sec-r3.test.ts). Every case tries to defeat the
// (mandate, nonce, amount) binding added by 9a10932.
//
//   A. Two decisions in one transaction sharing mandate, nonce and amount:
//      a relay CPIs charge(nonce 6, A), which pays, then a top-level
//      charge(nonce 6, A) is refused as a stale nonce (lib.rs:381, reason 3).
//      Both events and both ring rows carry the same triple. A paid record
//      and a refused record for nonce 6 must both fail closed, with the ring
//      intact and after it wrapped.
//   B. A relay CPI paid charge of nonce 5 plus a top-level refused charge of
//      nonce 6 at the same amount (round 3 S1). A paid record for nonce 6
//      must reject on the nonce 6 event; the genuine refused record must
//      confirm. B2 moves the CPI'd payment to another mandate.
//   C. No Veto event, two attributed text lines (paid, then refused, same
//      amount). Must fail closed with the ring wrapped and with the ring
//      holding the refused row.
//   D. The truncation boundary. D1: the flood cuts the log right after nonce
//      5's event, so the transaction carries one event, for nonce 5, and no
//      line for nonce 6: the events path fails closed. D2: the same flood one
//      line earlier leaves nonce 5's text line and no event at all. This is
//      the text fallback in boundVetoDecision (lib.ts) and it confirms the
//      refused nonce 6 as paid. RED on the head, same defect as the backend
//      seat's R4-1; kept here because D1 and D2 differ by one log line.
import assert from "node:assert/strict";
import test from "node:test";
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

const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const RELAY_PROGRAM = new PublicKey("ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const T0 = 1_790_300_000;
const VETO = REAL_PROGRAM.toBase58();
const A = 400_000;
const STALE = 3;
const OVER_CAP = 6;

const LIMITS = {
  cap: 700_000,
  per_tx_max: 500_000,
  expires_at: 1_797_713_870,
  merchant: MERCHANT.toBase58(),
  purpose: "critic sec r4",
};

type Row = { kind: "paid" | "refused"; amount: number; nonce: number; timestamp: number; signature: string; reason?: number };
type Ix = { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer };

const KEYS = [AGENT, DEST, null, null, SOURCE, MINT, REAL_PROGRAM, TOKEN_PROGRAM_ID, RELAY_PROGRAM];
const IX_VETO = 6;
const IX_RELAY = 8;

function chargeIx(row: Row): Ix {
  return {
    programIdIndex: IX_VETO,
    accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
    data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(row.amount)), u64Le(BigInt(row.nonce))]),
  };
}

const relayIx: Ix = { programIdIndex: IX_RELAY, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7, IX_VETO], data: Buffer.from([1]) };

function reasonOf(row: Row): number {
  return row.kind === "paid" ? 0 : (row.reason ?? OVER_CAP);
}

function overrideOf(row: Row): bigint {
  return row.kind === "paid" ? 0n : BigInt(row.amount);
}

function textLine(row: Row): string {
  if (row.kind === "paid") {
    return `Program log: VETO PAID amount=${row.amount} spent=${row.amount} of cap=${LIMITS.cap} remaining=1`;
  }
  const reason = reasonOf(row);
  return `Program log: VETO REFUSED reason=${reason} (${reasonText(reason)}) amount=${row.amount} per_tx_max=${LIMITS.per_tx_max} remaining=1 override_to_clear=${row.amount}`;
}

function eventLine(mandate: PublicKey, row: Row): string {
  return row.kind === "paid"
    ? encodePaidLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), spent: BigInt(row.amount) })
    : encodeRefusedLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), reason: reasonOf(row), suggestedOverride: overrideOf(row) });
}

function frame(program: PublicKey, depth: number, inner: string[]): string[] {
  const id = program.toBase58();
  return [`Program ${id} invoke [${depth}]`, ...inner, `Program ${id} consumed ${1000 * depth} of 200000 compute units`, `Program ${id} success`];
}

// The program writes msg! then emit! (lib.rs:207/214, :239/248). withEvent
// false models a program build or a cut that leaves the text line alone.
function vetoFrame(mandate: PublicKey, row: Row, depth: number, withEvent = true): string[] {
  const inner = ["Program log: Instruction: Charge", textLine(row)];
  if (withEvent) inner.push(eventLine(mandate, row));
  if (row.kind === "paid") inner.splice(1, 0, ...frame(TOKEN_PROGRAM_ID, depth + 1, ["Program log: Instruction: TransferChecked"]));
  return frame(REAL_PROGRAM, depth, inner);
}

function relayThenTop(mandate: PublicKey, cpiRow: Row, topRow: Row, withEvents = true, cpiMandate = mandate): string[] {
  return [
    ...frame(RELAY_PROGRAM, 1, ["Program log: Instruction: Relay", ...vetoFrame(cpiMandate, cpiRow, 2, withEvents)]),
    ...vetoFrame(mandate, topRow, 1, withEvents),
  ];
}

function mockTx(mandate: PublicKey, ledger: PublicKey, args: { logs: string[]; ixs: Ix[]; blockTime: number }): unknown {
  const keys = KEYS.map((key, i) => (i === 2 ? ledger : i === 3 ? mandate : key));
  return {
    slot: 1,
    blockTime: args.blockTime,
    transaction: { message: { staticAccountKeys: keys, compiledInstructions: args.ixs } },
    meta: { err: null, logMessages: args.logs },
  };
}

function record(mandate: PublicKey, row: Row, claim: { kind?: "paid" | "refused" } = {}): DecisionRecord {
  const kind = claim.kind ?? row.kind;
  const reason = kind === "paid" ? 0 : reasonOf(row);
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: VETO,
    mandate: mandate.toBase58(),
    limits: LIMITS,
    kind,
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: reason,
    reason_text: reasonText(reason),
    suggested_override: kind === "refused" ? row.amount : 0,
    signature: row.signature,
  });
}

function encodeMandate(mandateId: bigint, spendCount: number, refusalCount: number, spent: bigint): Buffer {
  const purpose = Buffer.from(LIMITS.purpose, "utf8");
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const key of [OWNER, AGENT, MINT, SOURCE, MERCHANT]) {
    key.toBuffer().copy(buf, o);
    o += 32;
  }
  for (const value of [mandateId, BigInt(LIMITS.cap), spent, BigInt(LIMITS.per_tx_max)]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeBigInt64LE(BigInt(LIMITS.expires_at), o);
  o += 8;
  for (const value of [0n, 0n, 0n]) {
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
  buf.writeUInt32LE(refusalCount, o);
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
    const off = 48 + (seq % LEDGER_CAPACITY) * 72;
    data.writeBigInt64LE(BigInt(row.timestamp), off);
    data.writeBigUInt64LE(BigInt(row.amount), off + 8);
    DEST.toBuffer().copy(data, off + 16);
    data.writeBigUInt64LE(BigInt(row.nonce), off + 48);
    data.writeBigUInt64LE(overrideOf(row), off + 56);
    data[off + 64] = row.kind === "paid" ? KIND_PAID : KIND_REFUSED;
    data[off + 65] = reasonOf(row);
  });
  return data;
}

function tokenAccount(): Buffer {
  const data = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(data, 32);
  return data;
}

function chain(mandateId: bigint, rows: Row[], txs: (mandate: PublicKey, ledger: PublicKey) => Map<string, unknown>) {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const paid = rows.filter((row) => row.kind === "paid");
  const refused = rows.filter((row) => row.kind === "refused");
  const spent = paid.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: tokenAccount(), owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(mandateId, paid.length, refused.length, spent), owner: REAL_PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: REAL_PROGRAM }],
  ]);
  const table = txs(mandate, ledger);
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return table.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      const hit = accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
  } as unknown as Connection;
  return { conn, mandate, ledger };
}

function fillers(from: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < LEDGER_CAPACITY; i += 1) {
    out.push({ kind: "refused", amount: 900_000, nonce: 100 + i, timestamp: from + i, signature: `r4s-filler-${i}` });
  }
  return out;
}

function fillerTxs(mandate: PublicKey, ledger: PublicKey, rows: Row[]): [string, unknown][] {
  return rows.map((row) => [row.signature, mockTx(mandate, ledger, { logs: vetoFrame(mandate, row, 1), ixs: [chargeIx(row)], blockTime: row.timestamp })]);
}

// One transaction: relay [1] -> Veto [2] charge(cpiRow) paid, then top-level
// Veto [1] charge(topRow) refused. Two ring rows at one ts.
function setup(mandateId: bigint, cpiRow: Row, topRow: Row, opts: { wrapped: boolean; logs?: (mandate: PublicKey) => string[] }) {
  const own = [cpiRow, topRow];
  const rows = opts.wrapped ? [...own, ...fillers(T0 + 10)] : own;
  return chain(mandateId, rows, (m, l) => {
    const logs = opts.logs ? opts.logs(m) : relayThenTop(m, cpiRow, topRow);
    const tx = mockTx(m, l, { logs, ixs: [relayIx, chargeIx(topRow)], blockTime: T0 });
    return new Map<string, unknown>([[topRow.signature, tx], ...(opts.wrapped ? fillerTxs(m, l, rows.slice(2)) : [])]);
  });
}

// A. Same triple twice: CPI pays nonce 6 at A, the top-level charge of
// nonce 6 at A is refused as stale.
const SIG_A = "r4s-same-triple";
const CPI_PAID_6: Row = { kind: "paid", amount: A, nonce: 6, timestamp: T0, signature: SIG_A };
const TOP_STALE_6: Row = { kind: "refused", amount: A, nonce: 6, timestamp: T0, signature: SIG_A, reason: STALE };

test("critic sec r4 A1: two decisions sharing mandate, nonce and amount, ring intact: paid and refused records both fail closed", async () => {
  const { conn, mandate } = setup(51n, CPI_PAID_6, TOP_STALE_6, { wrapped: false });
  const paid = await assessRecord(record(mandate, CPI_PAID_6), RPC, conn, OPTS);
  assert.equal(paid.ok, false, paid.text);
  assert.match(paid.text, /transaction carries 2 Veto decisions for nonce 6/);
  assert.match(paid.text, /matches 2 ledger rows for nonce 6 equally; refusing to bind/);
  const refused = await assessRecord(record(mandate, TOP_STALE_6), RPC, conn, OPTS);
  assert.equal(refused.ok, false, refused.text);
  assert.match(refused.text, /transaction carries 2 Veto decisions for nonce 6/);
});

test("critic sec r4 A2: two decisions sharing mandate, nonce and amount, ring wrapped: paid and refused records both fail closed", async () => {
  const { conn, mandate } = setup(52n, CPI_PAID_6, TOP_STALE_6, { wrapped: true });
  for (const row of [CPI_PAID_6, TOP_STALE_6]) {
    const verdict = await assessRecord(record(mandate, row), RPC, conn, OPTS);
    assert.equal(verdict.ok, false, `${row.kind} record confirmed:\n${verdict.text}`);
    assert.match(verdict.text, /transaction carries 2 Veto decisions for nonce 6/);
    assert.doesNotMatch(verdict.text, /VERDICT: CONFIRMED/);
  }
});

// B. Round 3 S1: CPI pays nonce 5 at A, top-level nonce 6 at A is refused.
const SIG_B = "r4s-relay-identical-amount";
const CPI_PAID_5: Row = { kind: "paid", amount: A, nonce: 5, timestamp: T0, signature: SIG_B };
const TOP_REFUSED_6: Row = { kind: "refused", amount: A, nonce: 6, timestamp: T0, signature: SIG_B, reason: OVER_CAP };

test("critic sec r4 B1: relay CPI paid nonce 5 plus top-level refused nonce 6 at one amount, ring wrapped: paid claim for nonce 6 REJECTS on the nonce 6 event, genuine refused CONFIRMS", async () => {
  const { conn, mandate } = setup(53n, CPI_PAID_5, TOP_REFUSED_6, { wrapped: true });
  const forged = await assessRecord(record(mandate, TOP_REFUSED_6, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /kind \(logs\): record has paid, chain has refused/);
  assert.match(forged.text, /reason_code \(logs\): record has 0, chain has 6/);
  const genuine = await assessRecord(record(mandate, TOP_REFUSED_6), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
  assert.match(genuine.text, /no longer holds this decision/);
});

test("critic sec r4 B2: the CPI'd payment of nonce 6 at A sits on another mandate: paid claim on this mandate REJECTS, genuine refused CONFIRMS", async () => {
  const other = mandatePda(REAL_PROGRAM, OWNER, 999n);
  const cpiOther: Row = { ...CPI_PAID_6, signature: SIG_B };
  const top: Row = { ...TOP_REFUSED_6 };
  const { conn, mandate } = chain(54n, [top, ...fillers(T0 + 10)], (m, l) => {
    const logs = relayThenTop(m, cpiOther, top, true, other);
    const tx = mockTx(m, l, { logs, ixs: [relayIx, chargeIx(top)], blockTime: T0 });
    return new Map<string, unknown>([[top.signature, tx], ...fillerTxs(m, l, fillers(T0 + 10))]);
  });
  const forged = await assessRecord(record(mandate, top, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /kind \(logs\): record has paid, chain has refused/);
  const genuine = await assessRecord(record(mandate, top), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
});

// C. No Veto event anywhere, two attributed text lines.
test("critic sec r4 C1: no Veto event, two text lines (paid then refused, same amount), ring wrapped: paid claim fails closed", async () => {
  const { conn, mandate } = setup(55n, CPI_PAID_5, TOP_REFUSED_6, { wrapped: true, logs: (m) => relayThenTop(m, CPI_PAID_5, TOP_REFUSED_6, false) });
  const forged = await assessRecord(record(mandate, TOP_REFUSED_6, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /transaction carries 2 Veto decisions for nonce 6/);
  const refused = await assessRecord(record(mandate, TOP_REFUSED_6), RPC, conn, OPTS);
  assert.equal(refused.ok, false, "two unbound text lines must not confirm any record");
});

test("critic sec r4 C2: no Veto event, two text lines, ring holds the refused row: paid claim REJECTS on kind (ledger) and on the line count", async () => {
  const { conn, mandate } = setup(56n, CPI_PAID_5, TOP_REFUSED_6, { wrapped: false, logs: (m) => relayThenTop(m, CPI_PAID_5, TOP_REFUSED_6, false) });
  const forged = await assessRecord(record(mandate, TOP_REFUSED_6, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /kind \(ledger\): record has paid, chain has refused/);
  assert.match(forged.text, /transaction carries 2 Veto decisions for nonce 6/);
});

// D. The truncation boundary. The relay floods its own frame; the runtime
// keeps 10 KB and appends a bare "Log truncated".
function truncatedLogs(mandate: PublicKey, keepEvent: boolean): string[] {
  const kept = ["Program log: Instruction: Charge", ...frame(TOKEN_PROGRAM_ID, 3, ["Program log: Instruction: TransferChecked"]), textLine(CPI_PAID_5)];
  if (keepEvent) kept.push(eventLine(mandate, CPI_PAID_5));
  return [
    `Program ${RELAY_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Relay",
    ...Array.from({ length: 9 }, () => `Program log: ${"A".repeat(64)}`),
    `Program ${VETO} invoke [2]`,
    ...kept,
    "Log truncated",
  ];
}

test("critic sec r4 D1: flood cuts after nonce 5's event, ring wrapped: the events path finds no decision for nonce 6 and fails closed", async () => {
  const { conn, mandate } = setup(57n, CPI_PAID_5, TOP_REFUSED_6, { wrapped: true, logs: (m) => truncatedLogs(m, true) });
  const forged = await assessRecord(record(mandate, TOP_REFUSED_6, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /transaction carries 0 Veto decisions for nonce 6/);
});

test("critic sec r4 D2: flood cuts one line earlier, after nonce 5's text line, ring wrapped: the text fallback must not confirm nonce 6 as paid", async () => {
  const { conn, mandate } = setup(58n, CPI_PAID_5, TOP_REFUSED_6, { wrapped: true, logs: (m) => truncatedLogs(m, false) });
  const forged = await assessRecord(record(mandate, TOP_REFUSED_6, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(
    forged.ok,
    false,
    `nonce 6 was refused on chain; the log ends in "Log truncated" with nonce 5's text line and no event, and the paid claim confirmed:\n${forged.text}`,
  );
});
