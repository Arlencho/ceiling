// Security critic, PR 121 round 3. Same mock chain shape as the round 2
// fixture (verify.critic-sec-r2.test.ts), with the transaction's log lines
// and instruction list built per case so a whole invoke tree can be shaped.
//
//   S1. RED on the head, pre-existing on main. The logs path binds the first
//       Veto decision line in the transaction to the first top-level charge
//       instruction, and nothing ties the two by nonce. parseChargeFromTx
//       (lib.ts) reads only top-level instructions; linesForProgram
//       (indexer/src/events.ts) accepts a Veto frame at any depth. A program
//       the agent deploys CPIs charge(nonce 5, amount A), which pays, and the
//       same transaction then carries a top-level charge(nonce 6, amount A),
//       which is refused. Once the ring has wrapped past nonce 6, a record
//       that says nonce 6 paid prints VERDICT: CONFIRMED. Control: while the
//       ring holds the refused row the same record is REJECTED.
//   S2. RED on the head, pre-existing on main. A program that floods the log
//       ahead of charge makes the runtime drop everything after "Log
//       truncated", Veto's frame included. The ring row and spend_count are
//       written, the indexer sees no decision, and a date_range export that
//       omits the payment CONFIRMS as complete over payments.
//   S3. Attribution attacks on linesForProgram, all green on the head: a log
//       line whose text is a Veto invoke or success line, a hook program at
//       depth 3 under Veto's own token CPI that logs VETO text and a fake
//       event, an outer program at depth 1 around a CPI'd Veto frame, a failed
//       inner instruction, and the consumed / return lines the runtime adds.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeEventsFromLogs, decisionsFromTx, encodePaidLog, encodeRefusedLog, linesForProgram } from "../indexer/src/events.js";
import type { TxView } from "../indexer/src/types.js";
import { makeBundle, type DecisionBundle } from "./bulk.js";
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
  parseChargeLogs,
  parseRecord,
  reasonText,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const OUTER_PROGRAM = new PublicKey("ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o");
const HOOK_PROGRAM = new PublicKey("HookWZaERG4cKGJdknfJZbC4jchMLDDRYLzKnpTRAzX");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const T0 = 1_790_200_000;
const VETO = REAL_PROGRAM.toBase58();

const LIMITS = {
  cap: 700_000,
  per_tx_max: 500_000,
  expires_at: 1_797_713_870,
  merchant: MERCHANT.toBase58(),
  purpose: "critic sec r3",
};

type Row = {
  kind: "paid" | "refused";
  amount: number;
  nonce: number;
  timestamp: number;
  signature: string;
  reason?: number;
};

type Ix = { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer };

// Key table shared by every mock transaction.
const KEYS = [AGENT, DEST, null, null, SOURCE, MINT, REAL_PROGRAM, TOKEN_PROGRAM_ID, OUTER_PROGRAM];
const IX_VETO = 6;
const IX_OUTER = 8;

function chargeIx(row: Row, programIdIndex = IX_VETO): Ix {
  return {
    programIdIndex,
    accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
    data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(row.amount)), u64Le(BigInt(row.nonce))]),
  };
}

function reasonOf(row: Row): number {
  return row.kind === "paid" ? 0 : (row.reason ?? 5);
}

function overrideOf(row: Row): bigint {
  return row.kind === "paid" ? 0n : BigInt(row.amount);
}

// What the program itself writes for one charge, without frame lines.
function vetoLines(mandate: PublicKey, row: Row): string[] {
  if (row.kind === "paid") {
    return [
      `Program log: VETO PAID amount=${row.amount} spent=${row.amount} of cap=${LIMITS.cap} remaining=1`,
      encodePaidLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), spent: BigInt(row.amount) }),
    ];
  }
  const reason = reasonOf(row);
  return [
    `Program log: VETO REFUSED reason=${reason} (${reasonText(reason)}) amount=${row.amount} per_tx_max=${LIMITS.per_tx_max} remaining=1 override_to_clear=${row.amount}`,
    encodeRefusedLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), reason, suggestedOverride: overrideOf(row) }),
  ];
}

// A program frame exactly as the runtime prints it (stable_log.rs).
function frame(program: PublicKey, depth: number, inner: string[], end: "success" | string = "success"): string[] {
  const id = program.toBase58();
  return [
    `Program ${id} invoke [${depth}]`,
    ...inner,
    `Program ${id} consumed ${1000 * depth} of 200000 compute units`,
    end === "success" ? `Program ${id} success` : `Program ${id} failed: ${end}`,
  ];
}

function vetoFrame(mandate: PublicKey, row: Row, depth = 1, nested: string[] = []): string[] {
  const inner = ["Program log: Instruction: Charge", ...nested, ...vetoLines(mandate, row)];
  return frame(REAL_PROGRAM, depth, inner);
}

// Veto's own token CPI on a paid charge, one level under Veto.
function tokenFrame(depth: number, program: PublicKey = TOKEN_PROGRAM_ID, hook: string[] = []): string[] {
  return frame(program, depth, ["Program log: Instruction: TransferChecked", ...hook]);
}

function mockTx(mandate: PublicKey, ledger: PublicKey, args: { logs: string[]; ixs: Ix[]; blockTime: number; err?: unknown }): unknown {
  const keys = KEYS.map((key, i) => (i === 2 ? ledger : i === 3 ? mandate : key));
  return {
    slot: 1,
    blockTime: args.blockTime,
    transaction: { message: { staticAccountKeys: keys, compiledInstructions: args.ixs } },
    meta: { err: args.err ?? null, logMessages: args.logs },
  };
}

function record(mandate: PublicKey, row: Row, claim: { kind?: "paid" | "refused"; nonce?: number } = {}): DecisionRecord {
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
    nonce: claim.nonce ?? row.nonce,
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

// Ring rows and transactions are given separately: one transaction can write
// several rows, and a row's transaction can carry any log tree.
function chain(
  mandateId: bigint,
  rows: Row[],
  txs: (mandate: PublicKey, ledger: PublicKey) => Map<string, unknown>,
): { conn: Connection; mandate: PublicKey; ledger: PublicKey } {
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
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string }) {
      if (config?.before) return [];
      return [...table.entries()].map(([signature, tx]) => {
        const body = tx as { slot?: number; blockTime?: number | null };
        return { signature, slot: body.slot ?? 1, err: null, memo: null, blockTime: body.blockTime ?? null, confirmationStatus: "confirmed" as const };
      });
    },
  } as unknown as Connection;
  return { conn, mandate, ledger };
}

function fillers(count: number, from: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ kind: "refused", amount: 900_000, nonce: 100 + i, timestamp: from + i, signature: `filler-${i}` });
  }
  return out;
}

function fillerTxs(mandate: PublicKey, ledger: PublicKey, rows: Row[]): [string, unknown][] {
  return rows.map((row) => [
    row.signature,
    mockTx(mandate, ledger, { logs: vetoFrame(mandate, row), ixs: [chargeIx(row)], blockTime: row.timestamp }),
  ]);
}

// S1. One transaction: ix 1 is the agent's own program, which CPIs
// charge(nonce 5, 400000) and the charge pays (Veto at depth 2, its token
// CPI at depth 3); ix 2 is a top-level charge(nonce 6, 400000), refused as
// over the remaining cap. The program writes two ring rows.
const CPI_PAID: Row = { kind: "paid", amount: 400_000, nonce: 5, timestamp: T0, signature: "s1-cpi-then-top" };
const TOP_REFUSED: Row = { kind: "refused", amount: 400_000, nonce: 6, timestamp: T0, signature: "s1-cpi-then-top", reason: 6 };

function s1Tx(mandate: PublicKey, ledger: PublicKey): unknown {
  const outerIx: Ix = { programIdIndex: IX_OUTER, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7, IX_VETO], data: Buffer.from([1]) };
  const logs = [
    ...frame(OUTER_PROGRAM, 1, [
      "Program log: Instruction: Relay",
      ...vetoFrame(mandate, CPI_PAID, 2, tokenFrame(3)),
    ]),
    ...vetoFrame(mandate, TOP_REFUSED, 1),
  ];
  return mockTx(mandate, ledger, { logs, ixs: [outerIx, chargeIx(TOP_REFUSED)], blockTime: T0 });
}

test("critic sec r3 S1 control: ring holds the refused row for nonce 6, a paid record for nonce 6 is REJECTED", async () => {
  const { conn, mandate } = chain(41n, [CPI_PAID, TOP_REFUSED], (m, l) => new Map([[CPI_PAID.signature, s1Tx(m, l)]]));
  const forged = await assessRecord(record(mandate, TOP_REFUSED, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /kind \(ledger\): record has paid, chain has refused/);
});

test("critic sec r3 S1: after the ring wrapped, a CPI'd paid charge of another nonce makes the refused top-level charge CONFIRM as paid", async () => {
  const rows = [CPI_PAID, TOP_REFUSED, ...fillers(LEDGER_CAPACITY, T0 + 10)];
  const { conn, mandate } = chain(
    42n,
    rows,
    (m, l) => new Map<string, unknown>([[CPI_PAID.signature, s1Tx(m, l)], ...fillerTxs(m, l, rows.slice(2))]),
  );
  const forged = await assessRecord(record(mandate, TOP_REFUSED, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(
    forged.ok,
    false,
    `nonce 6 was refused on chain (ring row refused, refusal_count moved); the paid decision in the same transaction belongs to nonce 5:\n${forged.text}`,
  );
});

// S2. A program ahead of charge floods the log. The runtime keeps the first
// 10 KB, appends "Log truncated" and drops the rest, Veto's frame included.
function floodedTx(mandate: PublicKey, ledger: PublicKey, row: Row): unknown {
  const flood: string[] = [];
  const line = `Program log: ${"x".repeat(900)}`;
  for (let i = 0; i < 11; i += 1) flood.push(line);
  const logs = [`Program ${OUTER_PROGRAM.toBase58()} invoke [1]`, ...flood, "Log truncated"];
  const floodIx: Ix = { programIdIndex: IX_OUTER, accountKeyIndexes: [], data: Buffer.from([2]) };
  return mockTx(mandate, ledger, { logs, ixs: [floodIx, chargeIx(row)], blockTime: row.timestamp });
}

test("critic sec r3 S2: a payment whose log was truncated is hidden from the date_range population and the file that omits it CONFIRMS", async () => {
  const shown: Row = { kind: "paid", amount: 200_000, nonce: 1, timestamp: T0, signature: "s2-shown" };
  const hidden: Row = { kind: "paid", amount: 300_000, nonce: 2, timestamp: T0 + 5, signature: "s2-hidden" };
  const { conn, mandate, ledger } = chain(
    43n,
    [shown, hidden],
    (m, l) =>
      new Map<string, unknown>([
        [shown.signature, mockTx(m, l, { logs: vetoFrame(m, shown, 1, tokenFrame(2)), ixs: [chargeIx(shown)], blockTime: shown.timestamp })],
        [hidden.signature, floodedTx(m, l, hidden)],
      ]),
  );
  // The chain holds the payment: ring row and spend_count both moved.
  const view: TxView = {
    signature: hidden.signature,
    slot: 1,
    blockTime: hidden.timestamp,
    err: null,
    accountKeys: KEYS.map((key, i) => (i === 2 ? ledger : i === 3 ? mandate : key)!.toBase58()),
    logs: (floodedTx(mandate, ledger, hidden) as { meta: { logMessages: string[] } }).meta.logMessages,
    instructions: [{ programId: VETO, accounts: [AGENT, mandate, ledger, SOURCE, DEST, MINT, TOKEN_PROGRAM_ID].map((k) => k.toBase58()), data: chargeIx(hidden).data }],
  };
  assert.deepEqual(decisionsFromTx(view, VETO), [], "the indexer sees a decision in a truncated log (then this case is moot)");
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: VETO,
    scope: { type: "date_range", mandate: mandate.toBase58(), from: T0 - 1, to: T0 + 100 },
    decisions: [record(mandate, shown)],
  });
  const verdict = await assessBundle(bundle, RPC, conn, OPTS);
  assert.equal(
    verdict.ok,
    false,
    `the ledger ring holds paid nonce 2 at ${hidden.timestamp} inside [from, to] and spend_count is 2; the file has one payment and is called complete:\n${verdict.text}`,
  );
});

// S3. Attribution attacks on linesForProgram. Each is green on the head.
const S3_ROW: Row = { kind: "refused", amount: 600_000, nonce: 9, timestamp: T0, signature: "s3" };
const S3_PAID: Row = { kind: "paid", amount: 300_000, nonce: 9, timestamp: T0, signature: "s3-paid" };
const S3_MANDATE = mandatePda(REAL_PROGRAM, OWNER, 44n);

function forged(kind: "paid" | "refused" = "paid", amount = 600_000): string[] {
  return [
    kind === "paid"
      ? `Program log: VETO PAID amount=${amount} spent=${amount} of cap=${LIMITS.cap} remaining=1`
      : `Program log: VETO REFUSED reason=5 (${reasonText(5)}) amount=${amount} per_tx_max=1 remaining=1 override_to_clear=${amount}`,
    kind === "paid"
      ? encodePaidLog({ mandate: S3_MANDATE, amount: BigInt(amount), nonce: 9n, spent: BigInt(amount) })
      : encodeRefusedLog({ mandate: S3_MANDATE, amount: BigInt(amount), nonce: 9n, reason: 5, suggestedOverride: BigInt(amount) }),
  ];
}

test("critic sec r3 S3a: a program whose log text is a Veto invoke line, a VETO PAID line and a Veto success line opens no frame", () => {
  const logs = [
    ...frame(OUTER_PROGRAM, 1, [
      `Program log: Program ${VETO} invoke [1]`,
      `Program log: Program ${VETO} invoke [2]`,
      ...forged("paid"),
      `Program log: Program ${VETO} success`,
      `Program log: Program ${VETO} consumed 1 of 1 compute units`,
      `Program data: ${Buffer.from(`Program ${VETO} invoke [1]`).toString("base64")}`,
    ]),
    ...vetoFrame(S3_MANDATE, S3_ROW),
  ];
  const own = linesForProgram(logs, VETO);
  assert.deepEqual(own, ["Program log: Instruction: Charge", ...vetoLines(S3_MANDATE, S3_ROW)]);
  assert.equal(parseChargeLogs(logs, VETO)?.kind, "refused");
  assert.deepEqual(decodeEventsFromLogs(logs, VETO).map((e) => e.kind), ["refused"]);
});

test("critic sec r3 S3b: a transfer hook at depth 3 under Veto's own token CPI that logs VETO REFUSED and a fake event is not Veto", () => {
  // Veto pays: Veto [1] -> Token-2022 [2] -> hook [3]. The hook writes a
  // refused line and a refused event for the same nonce and amount.
  const hook = frame(HOOK_PROGRAM, 3, ["Program log: Instruction: Execute", ...forged("refused", 300_000)]);
  const logs = vetoFrame(S3_MANDATE, S3_PAID, 1, tokenFrame(2, TOKEN_2022, hook));
  const own = linesForProgram(logs, VETO);
  assert.deepEqual(own, ["Program log: Instruction: Charge", ...vetoLines(S3_MANDATE, S3_PAID)]);
  const parsed = parseChargeLogs(logs, VETO);
  assert.equal(parsed?.kind, "paid");
  assert.equal(parsed?.amount, 300_000n);
  assert.deepEqual(decodeEventsFromLogs(logs, VETO).map((e) => [e.kind, e.nonce]), [["paid", 9n]]);
  // The hook's own frame gets exactly its own lines.
  assert.deepEqual(linesForProgram(logs, HOOK_PROGRAM.toBase58()), ["Program log: Instruction: Execute", ...forged("refused", 300_000)]);
});

test("critic sec r3 S3c: an outer program at depth 1 that logs VETO PAID before and after a CPI'd Veto frame at depth 2 (token at depth 3)", () => {
  const logs = frame(OUTER_PROGRAM, 1, [
    ...forged("paid"),
    ...vetoFrame(S3_MANDATE, S3_ROW, 2, tokenFrame(3)),
    ...forged("paid"),
    `Program return: ${OUTER_PROGRAM.toBase58()} AQ==`,
  ]);
  assert.deepEqual(linesForProgram(logs, VETO), ["Program log: Instruction: Charge", ...vetoLines(S3_MANDATE, S3_ROW)]);
  assert.equal(parseChargeLogs(logs, VETO)?.kind, "refused");
  assert.deepEqual(decodeEventsFromLogs(logs, VETO).map((e) => e.kind), ["refused"]);
});

test("critic sec r3 S3d: a failed inner instruction after a CPI'd Veto frame pops the stack on the failed lines and verify rejects the transaction", async () => {
  // Outer [1] -> Veto [2] refused, success; Outer [1] -> Token [2] failed;
  // Outer failed. The runtime rolls the transaction back: meta.err is set.
  const logs = [
    `Program ${OUTER_PROGRAM.toBase58()} invoke [1]`,
    ...vetoFrame(S3_MANDATE, S3_ROW, 2),
    ...frame(TOKEN_PROGRAM_ID, 2, ["Program log: Instruction: Transfer", "Program log: Error: insufficient funds"], "custom program error: 0x1"),
    `Program ${OUTER_PROGRAM.toBase58()} consumed 9000 of 200000 compute units`,
    `Program ${OUTER_PROGRAM.toBase58()} failed: custom program error: 0x1`,
    ...forged("paid"),
  ];
  // Attribution: Veto's lines only, and the trailing lines after the outer
  // failure belong to no frame.
  assert.deepEqual(linesForProgram(logs, VETO), ["Program log: Instruction: Charge", ...vetoLines(S3_MANDATE, S3_ROW)]);
  assert.deepEqual(linesForProgram(logs, OUTER_PROGRAM.toBase58()), []);
  const err = { InstructionError: [0, { Custom: 1 }] };
  const { conn, mandate } = chain(
    45n,
    [],
    (m, l) => new Map([[S3_ROW.signature, mockTx(m, l, { logs, ixs: [chargeIx(S3_ROW)], blockTime: T0, err })]]),
  );
  const verdict = await assessRecord(record(mandate, S3_ROW, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(verdict.ok, false, verdict.text);
  assert.match(verdict.text, /transaction failed on chain/);
  const view: TxView = {
    signature: S3_ROW.signature,
    slot: 1,
    blockTime: T0,
    err,
    accountKeys: [],
    logs,
    instructions: [{ programId: VETO, accounts: [AGENT, mandate, S3_MANDATE, SOURCE, DEST, MINT, TOKEN_PROGRAM_ID].map((k) => k.toBase58()), data: chargeIx(S3_ROW).data }],
  };
  assert.deepEqual(decisionsFromTx(view, VETO), []);
});

test("critic sec r3 S3e: Veto failing itself after its VETO PAID line (compute exhausted) leaves nothing a record can confirm against", async () => {
  const logs = [
    `Program ${VETO} invoke [1]`,
    "Program log: Instruction: Charge",
    ...vetoLines(S3_MANDATE, S3_PAID),
    `Program ${VETO} consumed 200000 of 200000 compute units`,
    `Program ${VETO} failed: exceeded CUs meter at BPF instruction`,
  ];
  assert.equal(parseChargeLogs(logs, VETO)?.kind, "paid", "Veto did write the line; the transaction status has to carry the rejection");
  const { conn, mandate } = chain(
    46n,
    [],
    (m, l) =>
      new Map([[S3_PAID.signature, mockTx(m, l, { logs, ixs: [chargeIx(S3_PAID)], blockTime: T0, err: { InstructionError: [0, "ComputationalBudgetExceeded"] } })]]),
  );
  const verdict = await assessRecord(record(mandate, S3_PAID), RPC, conn, OPTS);
  assert.equal(verdict.ok, false, verdict.text);
  assert.match(verdict.text, /transaction failed on chain/);
});
