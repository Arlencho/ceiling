// Backend critic, PR 121 round 3. Mock chain, same shapes as the round 2
// fixtures (verify.critic-r2.test.ts, verify.critic-sec-r2.test.ts).
//
//   N1. A genuine bulk export of a mandate with two same-nonce refusals
//       confirms under a rule scope and under a date_range scope that names
//       the mandate, and every row carries its own transaction time. Export
//       (overlayRing -> matchingRingEntry) and verify (checkRecord) bind a
//       signature to a ring row through the one ringEntryForSignature in
//       lib.ts; verify.ts no longer defines its own.
//   N2. A date_range verify pages signatures only until it crosses `from`,
//       fetches getTransaction only for signatures inside [from, to], and the
//       per-row checks reuse those transactions instead of fetching again.
//   132. Log lines count only inside the expected program's own frame:
//        a Memo "VETO PAID" ahead of a refused charge no longer makes a paid
//        record confirm (ring holds the row, and after the ring wrapped),
//        the genuine refused record still confirms in both states, a CPI into
//        Veto from another program keeps Veto's lines and drops the caller's,
//        memo text that mimics an invoke line does not open a frame, and
//        Veto's own nested token CPI does not lose the VETO line after it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeEventsFromLogs, encodePaidLog, encodeRefusedLog, linesForProgram } from "../indexer/src/events.js";
import { buildRecordFromIndexed, makeBundle, overlayRing, type IndexedDecision } from "./bulk.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  KIND_REFUSED,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  TOOLS_DIR,
  fetchLedger,
  fetchMandate,
  indexedEntries,
  ledgerPda,
  mandatePda,
  parseChargeLogs,
  parseRecord,
  reasonText,
  ringEntryForSignature,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const OUTER_PROGRAM = new PublicKey("ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const T0 = 1_790_117_952;
const LIMITS = {
  cap: 1_000_000_000,
  per_tx_max: 500_000,
  expires_at: 1_797_713_870,
  merchant: MERCHANT.toBase58(),
  purpose: "critic r3",
};

type Row = {
  kind: "paid" | "refused";
  amount: number;
  nonce: number;
  timestamp: number;
  signature: string;
  memoLines?: string[];
};

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
    data.writeBigUInt64LE(BigInt(row.kind === "refused" ? row.amount : 0), off + 56);
    data[off + 64] = row.kind === "paid" ? KIND_PAID : KIND_REFUSED;
    data[off + 65] = row.kind === "paid" ? 0 : 5;
  });
  return data;
}

function ownLines(mandate: PublicKey, row: Row): string[] {
  return row.kind === "paid"
    ? [
        `Program log: VETO PAID amount=${row.amount} spent=${row.amount} of cap=${LIMITS.cap} remaining=1`,
        encodePaidLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), spent: BigInt(row.amount) }),
      ]
    : [
        `Program log: VETO REFUSED reason=5 (${reasonText(5)}) amount=${row.amount} per_tx_max=${LIMITS.per_tx_max} remaining=1 override_to_clear=${row.amount}`,
        encodeRefusedLog({
          mandate,
          amount: BigInt(row.amount),
          nonce: BigInt(row.nonce),
          reason: 5,
          suggestedOverride: BigInt(row.amount),
        }),
      ];
}

// Real transaction log shape: every program's lines sit inside its own
// invoke / success frame. A memo instruction ahead of charge gets its own frame.
function chargeTx(mandate: PublicKey, ledger: PublicKey, row: Row): unknown {
  const memo = row.memoLines
    ? [`Program ${MEMO_PROGRAM.toBase58()} invoke [1]`, ...row.memoLines, `Program ${MEMO_PROGRAM.toBase58()} success`]
    : [];
  const logs = [
    ...memo,
    `Program ${REAL_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    ...ownLines(mandate, row),
    `Program ${REAL_PROGRAM.toBase58()} success`,
  ];
  const keys = [AGENT, DEST, ledger, mandate, SOURCE, MINT, REAL_PROGRAM, TOKEN_PROGRAM_ID, MEMO_PROGRAM];
  const charge = {
    programIdIndex: 6,
    accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
    data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(row.amount)), u64Le(BigInt(row.nonce))]),
  };
  const memoIx = { programIdIndex: 8, accountKeyIndexes: [], data: Buffer.from("VETO PAID amount=" + row.amount) };
  return {
    slot: 1,
    blockTime: row.timestamp,
    transaction: {
      message: { staticAccountKeys: keys, compiledInstructions: row.memoLines ? [memoIx, charge] : [charge] },
    },
    meta: { err: null, logMessages: logs },
  };
}

function record(mandate: PublicKey, row: Row, claim: { kind?: "paid" | "refused" } = {}): DecisionRecord {
  const kind = claim.kind ?? row.kind;
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: REAL_PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: LIMITS,
    kind,
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: kind === "paid" ? 0 : 5,
    reason_text: reasonText(kind === "paid" ? 0 : 5),
    suggested_override: kind === "refused" ? row.amount : 0,
    signature: row.signature,
  });
}

function tokenAccount(): Buffer {
  const data = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(data, 32);
  return data;
}

type Counts = { getTransaction: number; getSignaturesForAddress: number };

// Rows are oldest-first; the signature list is newest-first and honours
// `before` and `limit` the way the RPC does.
function chain(mandateId: bigint, rows: Row[]): { conn: Connection; mandate: PublicKey; counts: Counts } {
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
  const txs = new Map<string, unknown>(rows.map((row) => [row.signature, chargeTx(mandate, ledger, row)]));
  const newestFirst = [...rows].reverse();
  const counts: Counts = { getTransaction: 0, getSignaturesForAddress: 0 };
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      counts.getTransaction += 1;
      return txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      const hit = accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string; limit?: number }) {
      counts.getSignaturesForAddress += 1;
      const start = config?.before ? newestFirst.findIndex((row) => row.signature === config.before) + 1 : 0;
      const limit = config?.limit ?? 1000;
      return newestFirst.slice(start, start + limit).map((row) => ({
        signature: row.signature,
        slot: 1,
        err: null,
        memo: null,
        blockTime: row.timestamp,
        confirmationStatus: "confirmed" as const,
      }));
    },
  } as unknown as Connection;
  return { conn, mandate, counts };
}

function indexed(mandate: PublicKey, row: Row): IndexedDecision {
  return {
    signature: row.signature,
    timestamp: row.timestamp,
    mandate: mandate.toBase58(),
    amount: BigInt(row.amount),
    nonce: BigInt(row.nonce),
    counterparty: DEST.toBase58(),
    kind: row.kind,
    reason: row.kind === "paid" ? 0 : 5,
    suggestedOverride: BigInt(row.kind === "refused" ? row.amount : 0),
  };
}

// Bulk rows the way export.ts recordsFromIndexer builds them.
async function exportBulkRows(conn: Connection, mandate: PublicKey, rows: Row[]): Promise<DecisionRecord[]> {
  const mandateAccount = await fetchMandate(conn, mandate);
  const ledger = await fetchLedger(conn, ledgerPda(REAL_PROGRAM, mandate));
  return rows.map((row) => {
    const decision = indexed(mandate, row);
    return buildRecordFromIndexed({
      cluster: "devnet",
      genesisHash: DEVNET_GENESIS,
      programId: REAL_PROGRAM,
      mandateAccount,
      decision,
      ringEntry: overlayRing(ledger, decision),
    });
  });
}

function bundleOf(
  mandate: PublicKey,
  decisions: DecisionRecord[],
  scope: { type: "rule" | "date_range"; mandate: string | null; from: number | null; to: number | null },
) {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope,
    decisions,
  });
}

const OPTS: AssessOpts = { env: {} };

const TWO_REFUSALS: Row[] = [
  { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0, signature: "r3-refused-first" },
  { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0 + 3, signature: "r3-refused-second" },
  { kind: "paid", amount: 100_000, nonce: 6, timestamp: T0 + 5, signature: "r3-paid" },
];

// N1

test("critic r3 N1: bulk export rows of two same-nonce refusals each carry their own transaction time", async () => {
  const { conn, mandate } = chain(41n, TWO_REFUSALS);
  const [first, second, paid] = await exportBulkRows(conn, mandate, TWO_REFUSALS);
  assert.equal(first!.timestamp, BigInt(T0), `first refusal exported at ${first!.timestamp}, landed at ${T0}`);
  assert.equal(second!.timestamp, BigInt(T0 + 3));
  assert.equal(paid!.timestamp, BigInt(T0 + 5));
});

test("critic r3 N1: the genuine rule export of that mandate CONFIRMS", async () => {
  const { conn, mandate } = chain(42n, TWO_REFUSALS);
  const decisions = await exportBulkRows(conn, mandate, TWO_REFUSALS);
  const verdict = await assessBundle(
    bundleOf(mandate, decisions, { type: "rule", mandate: mandate.toBase58(), from: null, to: null }),
    RPC,
    conn,
    OPTS,
  );
  assert.equal(verdict.ok, true, verdict.text);
  assert.match(verdict.text, /confirmed: 3/);
});

test("critic r3 N1: the genuine date_range export naming the mandate CONFIRMS", async () => {
  const { conn, mandate } = chain(43n, TWO_REFUSALS);
  const decisions = await exportBulkRows(conn, mandate, TWO_REFUSALS);
  const verdict = await assessBundle(
    bundleOf(mandate, decisions, { type: "date_range", mandate: mandate.toBase58(), from: T0 - 1, to: T0 + 10 }),
    RPC,
    conn,
    OPTS,
  );
  assert.equal(verdict.ok, true, verdict.text);
  assert.match(verdict.text, /confirmed: 3/);
});

test("critic r3 N1: export and verify bind through the one ringEntryForSignature in lib.ts", async () => {
  const { conn, mandate } = chain(44n, TWO_REFUSALS);
  const ledger = await fetchLedger(conn, ledgerPda(REAL_PROGRAM, mandate));
  for (const row of TWO_REFUSALS.slice(0, 2)) {
    const exported = overlayRing(ledger, indexed(mandate, row));
    const rows = indexedEntries(ledger).filter((entry) => entry.entry.nonce === BigInt(row.nonce));
    const verified = ringEntryForSignature(rows, row.timestamp, row.signature);
    assert.ok(exported, `export found no ring row for ${row.signature}`);
    assert.ok(!("error" in verified), `verify refused to bind ${row.signature}`);
    assert.equal(exported.ts, verified.entry.ts, `${row.signature}: export bound ${exported.ts}, verify bound ${verified.entry.ts}`);
  }
  const verifySource = readFileSync(`${TOOLS_DIR}/verify.ts`, "utf8");
  const libSource = readFileSync(`${TOOLS_DIR}/lib.ts`, "utf8");
  assert.doesNotMatch(verifySource, /function ringEntryForSignature/, "verify.ts still defines its own binder");
  assert.match(verifySource, /ringEntryForSignature\(rows, blockTime, record\.signature\)/);
  assert.match(libSource, /export function ringEntryForSignature/);
  assert.match(libSource, /ringEntryForSignature\(hits, want\.timestamp \?\? null/, "matchingRingEntry does not use the shared binder");
});

// N2

function manyRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "refused" as const,
    amount: 600_000,
    nonce: 100 + i,
    timestamp: T0 + i * 10,
    signature: `r3-many-${i}`,
  }));
}

test("critic r3 N2: a date_range verify over the newest 3 of 40 fetches 3 transactions and one signature page", async () => {
  const rows = manyRows(40);
  const inRange = rows.slice(37);
  const { conn, mandate, counts } = chain(45n, rows);
  const decisions = await exportBulkRows(conn, mandate, inRange);
  const verdict = await assessBundle(
    bundleOf(mandate, decisions, {
      type: "date_range",
      mandate: mandate.toBase58(),
      from: inRange[0]!.timestamp,
      to: inRange[2]!.timestamp,
    }),
    RPC,
    conn,
    { ...OPTS, pageSize: 10 },
  );
  assert.equal(verdict.ok, true, verdict.text);
  assert.equal(counts.getTransaction, 3, `getTransaction called ${counts.getTransaction} times for a 3-row range`);
  assert.equal(counts.getSignaturesForAddress, 1, `paged ${counts.getSignaturesForAddress} times past the from bound`);
});

test("critic r3 N2: a date_range in the middle skips signatures newer than `to` and stops at `from`", async () => {
  const rows = manyRows(40);
  const inRange = rows.slice(30, 33);
  const { conn, mandate, counts } = chain(46n, rows);
  const decisions = await exportBulkRows(conn, mandate, inRange);
  const verdict = await assessBundle(
    bundleOf(mandate, decisions, {
      type: "date_range",
      mandate: mandate.toBase58(),
      from: inRange[0]!.timestamp,
      to: inRange[2]!.timestamp,
    }),
    RPC,
    conn,
    { ...OPTS, pageSize: 10 },
  );
  assert.equal(verdict.ok, true, verdict.text);
  assert.equal(counts.getTransaction, 3, `getTransaction called ${counts.getTransaction} times for a 3-row range`);
  // Page 1 (rows 39..30) ends exactly on `from`; the walk needs page 2 to
  // see a signature older than `from` before it can stop. Two pages, not four.
  assert.equal(counts.getSignaturesForAddress, 2, `paged ${counts.getSignaturesForAddress} times`);
});

test("critic r3 N2 control: the population check still sees a row missing from the file", async () => {
  const rows = manyRows(40);
  const inRange = rows.slice(37);
  const { conn, mandate } = chain(47n, rows);
  const decisions = await exportBulkRows(conn, mandate, inRange.slice(1));
  const verdict = await assessBundle(
    bundleOf(mandate, decisions, {
      type: "date_range",
      mandate: mandate.toBase58(),
      from: inRange[0]!.timestamp,
      to: inRange[2]!.timestamp,
    }),
    RPC,
    conn,
    { ...OPTS, pageSize: 10 },
  );
  assert.equal(verdict.ok, false, verdict.text);
  assert.match(verdict.text, /r3-many-37 is in the indexed date_range and missing from the file/);
});

// 132

const MEMO_PAID = [`Program log: Memo (len 23): "VETO PAID amount=600000"`];

test("critic r3 132: memo VETO PAID ahead of a refused charge, ring holds the row: paid REJECTED, refused CONFIRMED", async () => {
  const rows: Row[] = [{ kind: "refused", amount: 600_000, nonce: 7, timestamp: T0, signature: "r3-memo-1", memoLines: MEMO_PAID }];
  const { conn, mandate } = chain(48n, rows);
  const forged = await assessRecord(record(mandate, rows[0]!, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(forged.ok, false, `paid record of a refused charge confirmed:\n${forged.text}`);
  assert.match(forged.text, /kind \(ledger\): record has paid, chain has refused/);
  assert.doesNotMatch(forged.text, /no longer holds this decision/);
  const genuine = await assessRecord(record(mandate, rows[0]!), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
});

test("critic r3 132: same after the ring wrapped past the row: paid REJECTED on logs, refused CONFIRMED on logs", async () => {
  const rows: Row[] = [
    { kind: "refused", amount: 600_000, nonce: 7, timestamp: T0, signature: "r3-memo-2", memoLines: MEMO_PAID },
    ...Array.from({ length: LEDGER_CAPACITY }, (_, i) => ({
      kind: "refused" as const,
      amount: 600_000,
      nonce: 200 + i,
      timestamp: T0 + 10 + i,
      signature: `r3-wrap-${i}`,
    })),
  ];
  const { conn, mandate } = chain(49n, rows);
  const forged = await assessRecord(record(mandate, rows[0]!, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(forged.ok, false, `paid record of a wrapped refused charge confirmed:\n${forged.text}`);
  assert.match(forged.text, /kind \(logs\): record has paid, chain has refused/);
  const genuine = await assessRecord(record(mandate, rows[0]!), RPC, conn, OPTS);
  assert.equal(genuine.ok, true, genuine.text);
  assert.match(genuine.text, /no longer holds this decision/);
});

test("critic r3 132: a CPI into Veto from another program keeps Veto's lines and drops the caller's", () => {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 50n);
  const veto = ownLines(mandate, { kind: "refused", amount: 600_000, nonce: 8, timestamp: T0, signature: "cpi" });
  const logs = [
    `Program ${OUTER_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Relay",
    "Program log: VETO PAID amount=600000",
    `Program ${REAL_PROGRAM.toBase58()} invoke [2]`,
    "Program log: Instruction: Charge",
    ...veto,
    `Program ${REAL_PROGRAM.toBase58()} success`,
    "Program log: VETO PAID amount=600000",
    encodePaidLog({ mandate, amount: 600_000n, nonce: 8n, spent: 600_000n }),
    `Program ${OUTER_PROGRAM.toBase58()} success`,
  ];
  assert.deepEqual(linesForProgram(logs, REAL_PROGRAM.toBase58()), ["Program log: Instruction: Charge", ...veto]);
  assert.equal(parseChargeLogs(logs, REAL_PROGRAM)?.kind, "refused");
  const events = decodeEventsFromLogs(logs, REAL_PROGRAM.toBase58());
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "refused");
  assert.equal(decodeEventsFromLogs(logs, OUTER_PROGRAM.toBase58()).length, 1, "the caller's own event stays the caller's");
});

test("critic r3 132: memo text that mimics an invoke line does not open a Veto frame, before or after the charge", () => {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 51n);
  const veto = ownLines(mandate, { kind: "refused", amount: 600_000, nonce: 9, timestamp: T0, signature: "mimic" });
  const memoFrame = (lines: string[]) => [
    `Program ${MEMO_PROGRAM.toBase58()} invoke [1]`,
    ...lines,
    `Program ${MEMO_PROGRAM.toBase58()} success`,
  ];
  const logs = [
    ...memoFrame([
      `Program log: Memo (len 58): "Program ${REAL_PROGRAM.toBase58()} invoke [1]"`,
      `Program log: Memo (len 23): "VETO PAID amount=600000"`,
      `Program log: Memo (len 52): "Program ${MEMO_PROGRAM.toBase58()} success"`,
    ]),
    `Program ${REAL_PROGRAM.toBase58()} invoke [1]`,
    ...veto,
    `Program ${REAL_PROGRAM.toBase58()} success`,
    ...memoFrame([`Program log: Memo (len 23): "VETO PAID amount=600000"`]),
  ];
  assert.deepEqual(linesForProgram(logs, REAL_PROGRAM.toBase58()), veto);
  assert.equal(parseChargeLogs(logs, REAL_PROGRAM)?.kind, "refused");
  assert.equal(decodeEventsFromLogs(logs, REAL_PROGRAM.toBase58()).length, 1);
});

test("critic r3 132 control: Veto's own nested token CPI does not lose the VETO PAID line after it", () => {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 52n);
  const veto = ownLines(mandate, { kind: "paid", amount: 100_000, nonce: 10, timestamp: T0, signature: "nested" });
  const logs = [
    `Program ${REAL_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    `Program ${TOKEN_PROGRAM_ID.toBase58()} invoke [2]`,
    "Program log: Instruction: Transfer",
    `Program ${TOKEN_PROGRAM_ID.toBase58()} consumed 4645 of 180000 compute units`,
    `Program ${TOKEN_PROGRAM_ID.toBase58()} success`,
    ...veto,
    `Program ${REAL_PROGRAM.toBase58()} consumed 30000 of 200000 compute units`,
    `Program ${REAL_PROGRAM.toBase58()} success`,
  ];
  assert.deepEqual(linesForProgram(logs, REAL_PROGRAM.toBase58()), ["Program log: Instruction: Charge", ...veto]);
  const parsed = parseChargeLogs(logs, REAL_PROGRAM);
  assert.equal(parsed?.kind, "paid");
  assert.equal(parsed?.amount, 100_000n);
  assert.equal(decodeEventsFromLogs(logs, REAL_PROGRAM.toBase58())[0]?.kind, "paid");
});
