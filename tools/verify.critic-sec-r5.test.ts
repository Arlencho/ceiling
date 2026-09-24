// Security critic, PR 121 round 5. Scoped to the round 4 HIGH: the text
// fallback in boundVetoDecision that 7cfed05 removed. Mock chain shape of
// the round 4 fixture (verify.critic-sec-r4.test.ts). Every case below is a
// log truncation shape that was not tried in round 4, aimed at reaching a
// paid confirmation for the refused nonce 6 now that only events bind.
//
// Shape: one transaction, relay [1] -> Veto [2] charge(nonce 5, A) paid,
// then a top-level Veto [1] charge(nonce 6, A) refused. Ring wrapped. The
// program writes msg! before emit! (lib.rs), and the runtime keeps 10 KB of
// log then appends a bare "Log truncated" line (whole lines only).
//
//   E1. The cut lands inside nonce 5's Program data line: a Paid event
//       shorter than 64 bytes. No event decodes, nothing binds.
//   E2. Nonce 5's frame is intact; nonce 6's frame keeps its VETO REFUSED
//       text and loses its event. The paid claim and the genuine refused
//       record both fail closed (0 events for nonce 6).
//   E3. The relay plants a Paid event for nonce 6 at A on this mandate, a
//       VETO PAID line and a spoofed "Log truncated" inside its own frame,
//       then the real cut removes the top-level frame. E3b leaves the relay
//       frame open at the cut.
//   E4. The flood spends the whole budget before the CPI: the log is the
//       relay's invoke line and "Log truncated".
//   E5. Amount term: the CPI pays nonce 6 at 300000 on this mandate, the
//       top-level nonce 6 at 400000 is refused and its frame is cut away.
//       A paid claim at either amount fails.
//   E6. Control: a genuine single paid charge after the ring wrapped still
//       confirms through its event.
//   E7. Boundary, legitimate: the CPI pays nonce 6 at A, the top-level
//       nonce 6 at A is refused as stale, and the cut removes the refused
//       event. The paid record confirms, and that is correct: nonce 6 was
//       paid at A on this mandate in this transaction.
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
const RELAY = RELAY_PROGRAM.toBase58();
const A = 400_000;
const STALE = 3;
const OVER_CAP = 6;

const LIMITS = {
  cap: 700_000,
  per_tx_max: 500_000,
  expires_at: 1_797_713_870,
  merchant: MERCHANT.toBase58(),
  purpose: "critic sec r5",
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

function tokenFrame(depth: number): string[] {
  return frame(TOKEN_PROGRAM_ID, depth, ["Program log: Instruction: TransferChecked"]);
}

function vetoFrame(mandate: PublicKey, row: Row, depth: number): string[] {
  const inner = ["Program log: Instruction: Charge", textLine(row), eventLine(mandate, row)];
  if (row.kind === "paid") inner.splice(1, 0, ...tokenFrame(depth + 1));
  return frame(REAL_PROGRAM, depth, inner);
}

// The relay frame, open: invoke, its own lines, the CPI'd Veto frame for
// cpiRow, and whatever the caller puts after. No success line: the cut can
// land while the relay is still on top of the stack.
function relayOpen(mandate: PublicKey, cpiRow: Row, before: string[], after: string[] = []): string[] {
  return [`Program ${RELAY} invoke [1]`, "Program log: Instruction: Relay", ...before, ...vetoFrame(mandate, cpiRow, 2), ...after];
}

function relayClosed(mandate: PublicKey, cpiRow: Row, before: string[] = [], after: string[] = []): string[] {
  return [...relayOpen(mandate, cpiRow, before, after), `Program ${RELAY} consumed 9000 of 200000 compute units`, `Program ${RELAY} success`];
}

const FLOOD = Array.from({ length: 9 }, () => `Program log: ${"A".repeat(64)}`);
const TRUNCATED = "Log truncated";

function mockTx(mandate: PublicKey, ledger: PublicKey, args: { logs: string[]; ixs: Ix[]; blockTime: number }): unknown {
  const keys = KEYS.map((key, i) => (i === 2 ? ledger : i === 3 ? mandate : key));
  return {
    slot: 1,
    blockTime: args.blockTime,
    transaction: { message: { staticAccountKeys: keys, compiledInstructions: args.ixs } },
    meta: { err: null, logMessages: args.logs },
  };
}

function record(mandate: PublicKey, row: Row, claim: { kind?: "paid" | "refused"; amount?: number } = {}): DecisionRecord {
  const kind = claim.kind ?? row.kind;
  const amount = claim.amount ?? row.amount;
  const reason = kind === "paid" ? 0 : reasonOf(row);
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: VETO,
    mandate: mandate.toBase58(),
    limits: LIMITS,
    kind,
    amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: reason,
    reason_text: reasonText(reason),
    suggested_override: kind === "refused" ? amount : 0,
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
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string; limit?: number }) {
      const listed = [...table.keys()];
      const start = config?.before ? listed.indexOf(config.before) + 1 : 0;
      const limit = config?.limit ?? listed.length;
      return listed.slice(start, start + limit).map((signature) => {
        const body = table.get(signature) as { slot?: number; blockTime?: number | null; meta?: { err?: unknown } };
        return {
          signature,
          slot: typeof body?.slot === "number" ? body.slot : 1,
          err: body?.meta?.err ?? null,
          memo: null,
          blockTime: body?.blockTime ?? null,
          confirmationStatus: "confirmed" as const,
        };
      });
    },
  } as unknown as Connection;
  return { conn, mandate, ledger };
}

function fillers(from: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < LEDGER_CAPACITY; i += 1) {
    out.push({ kind: "refused", amount: 900_000, nonce: 100 + i, timestamp: from + i, signature: `r5s-filler-${i}` });
  }
  return out;
}

function fillerTxs(mandate: PublicKey, ledger: PublicKey, rows: Row[]): [string, unknown][] {
  return rows.map((row) => [row.signature, mockTx(mandate, ledger, { logs: vetoFrame(mandate, row, 1), ixs: [chargeIx(row)], blockTime: row.timestamp })]);
}

// Relay CPI pays cpiRow, top-level topRow is refused, ring wrapped, and the
// transaction's log is whatever `logs` builds.
function wrapped(mandateId: bigint, cpiRow: Row, topRow: Row, logs: (mandate: PublicKey) => string[]) {
  const rows = [cpiRow, topRow, ...fillers(T0 + 10)];
  return chain(mandateId, rows, (m, l) => {
    const tx = mockTx(m, l, { logs: logs(m), ixs: [relayIx, chargeIx(topRow)], blockTime: T0 });
    return new Map<string, unknown>([[topRow.signature, tx], ...fillerTxs(m, l, rows.slice(2))]);
  });
}

const SIG = "r5s-relay-truncated";
const CPI_PAID_5: Row = { kind: "paid", amount: A, nonce: 5, timestamp: T0, signature: SIG };
const TOP_REFUSED_6: Row = { kind: "refused", amount: A, nonce: 6, timestamp: T0, signature: SIG, reason: OVER_CAP };
const NO_DECISION = /ledger ring has no matching row and the transaction log carries no Veto event to bind/;

async function forgedPaidNonce6(conn: Connection, mandate: PublicKey, claim: { amount?: number } = {}) {
  return assessRecord(record(mandate, TOP_REFUSED_6, { kind: "paid", ...claim }), RPC, conn, OPTS);
}

test("critic sec r5 E1: the cut lands inside nonce 5's Program data line (event shorter than 64 bytes): no event decodes, paid claim for nonce 6 fails closed", async () => {
  const { conn, mandate } = wrapped(71n, CPI_PAID_5, TOP_REFUSED_6, (m) => {
    const full = eventLine(m, CPI_PAID_5);
    const raw = Buffer.from(full.slice("Program data: ".length), "base64");
    assert.equal(raw.length, 64);
    const cut = `Program data: ${raw.subarray(0, 40).toString("base64")}`;
    return [`Program ${RELAY} invoke [1]`, "Program log: Instruction: Relay", ...FLOOD, `Program ${VETO} invoke [2]`, "Program log: Instruction: Charge", ...tokenFrame(3), textLine(CPI_PAID_5), cut, TRUNCATED];
  });
  const forged = await forgedPaidNonce6(conn, mandate);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, NO_DECISION);
  assert.doesNotMatch(forged.text, /VERDICT: CONFIRMED/);
});

test("critic sec r5 E2: nonce 5's frame intact, nonce 6's frame keeps VETO REFUSED and loses its event: paid claim and genuine refused both fail closed", async () => {
  const { conn, mandate } = wrapped(72n, CPI_PAID_5, TOP_REFUSED_6, (m) => [
    ...relayClosed(m, CPI_PAID_5, FLOOD),
    `Program ${VETO} invoke [1]`,
    "Program log: Instruction: Charge",
    textLine(TOP_REFUSED_6),
    TRUNCATED,
  ]);
  const forged = await forgedPaidNonce6(conn, mandate);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /transaction carries 0 Veto decisions for nonce 6/);
  const genuine = await assessRecord(record(mandate, TOP_REFUSED_6), RPC, conn, OPTS);
  assert.equal(genuine.ok, false, `a refused record with no event must not confirm either:\n${genuine.text}`);
  assert.match(genuine.text, /transaction carries 0 Veto decisions for nonce 6/);
});

test("critic sec r5 E3: the relay plants a Paid event for nonce 6, a VETO PAID line and a spoofed Log truncated in its own frame, then the real cut removes the top-level frame", async () => {
  const planted = (m: PublicKey) => [
    encodePaidLog({ mandate: m, amount: BigInt(A), nonce: 6n, spent: BigInt(A) }),
    textLine({ ...TOP_REFUSED_6, kind: "paid" }),
    `Program log: ${TRUNCATED}`,
  ];
  // E3a: relay frame closed, cut after it.
  const closed = wrapped(73n, CPI_PAID_5, TOP_REFUSED_6, (m) => [...relayClosed(m, CPI_PAID_5, FLOOD, planted(m)), TRUNCATED]);
  const a = await forgedPaidNonce6(closed.conn, closed.mandate);
  assert.equal(a.ok, false, a.text);
  assert.match(a.text, /transaction carries 0 Veto decisions for nonce 6/);
  // E3b: relay frame still open at the cut; the relay is on top of the stack.
  const open = wrapped(74n, CPI_PAID_5, TOP_REFUSED_6, (m) => [...relayOpen(m, CPI_PAID_5, FLOOD, planted(m)), TRUNCATED]);
  const b = await forgedPaidNonce6(open.conn, open.mandate);
  assert.equal(b.ok, false, b.text);
  assert.match(b.text, /transaction carries 0 Veto decisions for nonce 6/);
  // E3c: the planted lines come before the CPI, so they sit in the relay frame at depth 1 ahead of Veto's frame.
  const before = wrapped(75n, CPI_PAID_5, TOP_REFUSED_6, (m) => [...relayOpen(m, CPI_PAID_5, [...FLOOD, ...planted(m)]), TRUNCATED]);
  const c = await forgedPaidNonce6(before.conn, before.mandate);
  assert.equal(c.ok, false, c.text);
  assert.match(c.text, /transaction carries 0 Veto decisions for nonce 6/);
});

test("critic sec r5 E4: the flood spends the whole budget before the CPI: log is the relay's invoke line and Log truncated", async () => {
  const { conn, mandate } = wrapped(76n, CPI_PAID_5, TOP_REFUSED_6, () => [`Program ${RELAY} invoke [1]`, ...FLOOD, TRUNCATED]);
  const forged = await forgedPaidNonce6(conn, mandate);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, NO_DECISION);
  const genuine = await assessRecord(record(mandate, TOP_REFUSED_6), RPC, conn, OPTS);
  assert.equal(genuine.ok, false, genuine.text);
});

test("critic sec r5 E5: the CPI pays nonce 6 at 300000 on this mandate, the top-level nonce 6 at 400000 is refused and cut away: a paid claim at either amount fails", async () => {
  const cpi6Small: Row = { kind: "paid", amount: 300_000, nonce: 6, timestamp: T0, signature: SIG };
  const { conn, mandate } = wrapped(77n, cpi6Small, TOP_REFUSED_6, (m) => [...relayClosed(m, cpi6Small, FLOOD), `Program ${VETO} invoke [1]`, TRUNCATED]);
  const atTop = await forgedPaidNonce6(conn, mandate);
  assert.equal(atTop.ok, false, atTop.text);
  assert.match(atTop.text, /transaction carries 0 Veto decisions for nonce 6/);
  const atCpi = await forgedPaidNonce6(conn, mandate, { amount: 300_000 });
  assert.equal(atCpi.ok, false, atCpi.text);
  assert.match(atCpi.text, /amount \(instruction\): record has 300000, chain has 400000/);
});

test("critic sec r5 E6 control: a genuine single paid charge after the ring wrapped still confirms through its event", async () => {
  const genuine: Row = { kind: "paid", amount: A, nonce: 7, timestamp: T0, signature: "r5s-genuine-paid" };
  const rows = [genuine, ...fillers(T0 + 10)];
  const { conn, mandate } = chain(78n, rows, (m, l) => {
    const tx = mockTx(m, l, { logs: vetoFrame(m, genuine, 1), ixs: [chargeIx(genuine)], blockTime: T0 });
    return new Map<string, unknown>([[genuine.signature, tx], ...fillerTxs(m, l, rows.slice(1))]);
  });
  const verdict = await assessRecord(record(mandate, genuine), RPC, conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
  assert.match(verdict.text, /VERDICT: CONFIRMED/);
  assert.match(verdict.text, /no longer holds this decision/);
});

test("critic sec r5 E7 boundary: CPI pays nonce 6 at A, top-level nonce 6 at A refused as stale, cut removes the refused event: the paid record confirms, and nonce 6 was paid at A in this transaction", async () => {
  const cpiPaid6: Row = { kind: "paid", amount: A, nonce: 6, timestamp: T0, signature: SIG };
  const topStale6: Row = { kind: "refused", amount: A, nonce: 6, timestamp: T0, signature: SIG, reason: STALE };
  const { conn, mandate } = wrapped(79n, cpiPaid6, topStale6, (m) => [
    ...relayClosed(m, cpiPaid6, FLOOD),
    `Program ${VETO} invoke [1]`,
    "Program log: Instruction: Charge",
    textLine(topStale6),
    TRUNCATED,
  ]);
  const paid = await assessRecord(record(mandate, cpiPaid6), RPC, conn, OPTS);
  assert.equal(paid.ok, true, paid.text);
  // Without the cut the same transaction carries two decisions for the triple and neither record confirms (round 4 A2).
  const intact = wrapped(80n, cpiPaid6, topStale6, (m) => [...relayClosed(m, cpiPaid6, FLOOD), ...vetoFrame(m, topStale6, 1)]);
  const both = await assessRecord(record(intact.mandate, cpiPaid6), RPC, intact.conn, OPTS);
  assert.equal(both.ok, false, both.text);
  assert.match(both.text, /transaction carries 2 Veto decisions for nonce 6/);
});
