// Backend critic, PR 121 round 4. Mock chain, same shapes as the round 3
// fixtures (verify.critic-r3.test.ts, verify.critic-sec-r3.test.ts).
//
//   R4-1. boundVetoDecision (lib.ts) falls back to a text line when the
//         transaction carries no Veto event and exactly one decision line.
//         The program writes its text line (lib.rs:207, :239) before its
//         event (lib.rs:214, :248), and the runtime truncates the log per
//         message at 10 KB with a trailing "Log truncated"
//         (solana-program-runtime log_collector.rs:34-38). A flood sized to
//         cut between the two leaves one attributed text line and no event,
//         which is exactly the fallback's precondition. With the S1 relay
//         shape (a CPI'd paid charge of nonce 5 ahead of a top-level refused
//         charge of nonce 6, same amount) and a wrapped ring, the text line
//         is nonce 5's and the instruction is nonce 6's: the fallback cannot
//         bind them, and a record "nonce 6 paid" must not confirm.
//   R4-2. Control: the same transaction while the ring still holds the
//         refused row for nonce 6 is REJECTED on kind (ledger).
//   R4-3. Control: a single genuine charge whose log is intact still
//         confirms through the events path after the ring wrapped.
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
const T0 = 1_790_117_952;
const LIMITS = {
  cap: 1_000_000_000,
  per_tx_max: 500_000,
  expires_at: 1_797_713_870,
  merchant: MERCHANT.toBase58(),
  purpose: "critic r4",
};
const OPTS: AssessOpts = { env: {} };

type Row = { kind: "paid" | "refused"; amount: number; nonce: number; timestamp: number; signature: string };

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

function record(mandate: PublicKey, row: Row): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: REAL_PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: LIMITS,
    kind: row.kind,
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: row.kind === "paid" ? 0 : 5,
    reason_text: reasonText(row.kind === "paid" ? 0 : 5),
    suggested_override: row.kind === "refused" ? row.amount : 0,
    signature: row.signature,
  });
}

function tokenAccount(): Buffer {
  const data = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(data, 32);
  return data;
}

const KEYS = (ledger: PublicKey, mandate: PublicKey) => [
  AGENT,
  DEST,
  ledger,
  mandate,
  SOURCE,
  MINT,
  REAL_PROGRAM,
  TOKEN_PROGRAM_ID,
  RELAY_PROGRAM,
];

function chargeIx(row: Row) {
  return {
    programIdIndex: 6,
    accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
    data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(row.amount)), u64Le(BigInt(row.nonce))]),
  };
}

// Instruction 1: a relay program that pads its own log (a 1232-byte transaction
// cannot carry a 10 KB memo, but a program can msg! that much for a few
// thousand CU), then CPIs charge(nonce 5) and pays. Instruction 2: a top-level
// charge(nonce 6), refused.
// The runtime's log budget ends right after Veto's text line for nonce 5, so
// nonce 5's event, Veto's success line, the relay's success line and the whole
// nonce 6 frame are replaced by "Log truncated". The program still wrote both
// ring rows and moved spend_count.
function truncatedRelayTx(mandate: PublicKey, ledger: PublicKey, paid: Row, refused: Row): unknown {
  const veto = REAL_PROGRAM.toBase58();
  const logs = [
    `Program ${RELAY_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Relay",
    ...Array.from({ length: 9 }, () => `Program log: ${"A".repeat(64)}`),
    `Program ${veto} invoke [2]`,
    "Program log: Instruction: Charge",
    ownLines(mandate, paid)[0]!,
    "Log truncated",
  ];
  const relayIx = { programIdIndex: 9, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7, 6], data: Buffer.from([1]) };
  return {
    slot: 1,
    blockTime: refused.timestamp,
    transaction: {
      message: { staticAccountKeys: KEYS(ledger, mandate), compiledInstructions: [relayIx, chargeIx(refused)] },
    },
    meta: { err: null, logMessages: logs },
  };
}

function intactTx(mandate: PublicKey, ledger: PublicKey, row: Row): unknown {
  const veto = REAL_PROGRAM.toBase58();
  return {
    slot: 1,
    blockTime: row.timestamp,
    transaction: { message: { staticAccountKeys: KEYS(ledger, mandate), compiledInstructions: [chargeIx(row)] } },
    meta: {
      err: null,
      logMessages: [`Program ${veto} invoke [1]`, "Program log: Instruction: Charge", ...ownLines(mandate, row), `Program ${veto} success`],
    },
  };
}

function connFor(mandateId: bigint, ledgerRows: Row[], txs: Map<string, unknown>, counts: { paid: number; refused: number }) {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: tokenAccount(), owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(mandateId, counts.paid, counts.refused, 400_000n), owner: REAL_PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, ledgerRows), owner: REAL_PROGRAM }],
  ]);
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      const hit = accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string; limit?: number }) {
      const listed = [...txs.keys()];
      const start = config?.before ? listed.indexOf(config.before) + 1 : 0;
      const limit = config?.limit ?? listed.length;
      return listed.slice(start, start + limit).map((signature) => {
        const body = txs.get(signature) as { slot?: number; blockTime?: number | null; meta?: { err?: unknown } };
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

const SIG = "r4-truncated-relay";
const PAID_5: Row = { kind: "paid", amount: 400_000, nonce: 5, timestamp: T0, signature: SIG };
const REFUSED_6: Row = { kind: "refused", amount: 400_000, nonce: 6, timestamp: T0, signature: SIG };
const CLAIM_6_PAID: Row = { kind: "paid", amount: 400_000, nonce: 6, timestamp: T0, signature: SIG };

function wrapRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < LEDGER_CAPACITY; i += 1) {
    rows.push({ kind: "refused", amount: 600_000, nonce: 100 + i, timestamp: T0 + 10 + i, signature: `r4-wrap-${i}` });
  }
  return rows;
}

test("critic r4 R4-1: after the ring wrapped, a truncated relay transaction does not confirm the refused nonce 6 as paid", async () => {
  const mandateId = 61n;
  const mandate = mandatePda(REAL_PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const txs = new Map<string, unknown>([[SIG, truncatedRelayTx(mandate, ledger, PAID_5, REFUSED_6)]]);
  const { conn } = connFor(mandateId, [PAID_5, REFUSED_6, ...wrapRows()], txs, { paid: 1, refused: 1 + LEDGER_CAPACITY });
  const forged = await assessRecord(record(mandate, CLAIM_6_PAID), RPC, conn, OPTS);
  assert.equal(forged.ok, false, `nonce 6 was refused; a paid record confirmed from nonce 5's truncated text line:\n${forged.text}`);
});

test("critic r4 R4-2 control: while the ring holds the refused row for nonce 6, the same paid claim is REJECTED on kind (ledger)", async () => {
  const mandateId = 62n;
  const mandate = mandatePda(REAL_PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const txs = new Map<string, unknown>([[SIG, truncatedRelayTx(mandate, ledger, PAID_5, REFUSED_6)]]);
  const { conn } = connFor(mandateId, [PAID_5, REFUSED_6], txs, { paid: 1, refused: 1 });
  const forged = await assessRecord(record(mandate, CLAIM_6_PAID), RPC, conn, OPTS);
  assert.equal(forged.ok, false, forged.text);
  assert.match(forged.text, /kind \(ledger\): record has paid, chain has refused/);
});

test("critic r4 R4-3 control: a genuine intact charge still confirms through the events path after the ring wrapped", async () => {
  const mandateId = 63n;
  const mandate = mandatePda(REAL_PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const genuine: Row = { kind: "paid", amount: 400_000, nonce: 5, timestamp: T0, signature: "r4-intact" };
  const txs = new Map<string, unknown>([["r4-intact", intactTx(mandate, ledger, genuine)]]);
  const { conn } = connFor(mandateId, [genuine, ...wrapRows()], txs, { paid: 1, refused: LEDGER_CAPACITY });
  const result = await assessRecord(record(mandate, genuine), RPC, conn, OPTS);
  assert.equal(result.ok, true, `genuine paid record after wrap is rejected:\n${result.text}`);
  assert.match(result.text, /no longer holds this decision/);
});
