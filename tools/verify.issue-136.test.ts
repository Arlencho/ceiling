// Issue 136. One transaction can carry two charges. Export and verify bind
// the charge whose mandate, nonce, and amount equal the record, and fail
// closed when zero or several charges match.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog, encodeRefusedLog } from "../indexer/src/events.js";
import { recordFromSignature } from "./export.js";
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
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const T0 = 1_790_117_952;
const SIG = "two-charges";
const LIMITS = {
  cap: 1_000_000,
  per_tx_max: 500_000,
  expires_at: 1_797_713_870,
  merchant: MERCHANT.toBase58(),
  purpose: "two charges",
};

type Row = { kind: "paid" | "refused"; amount: number; nonce: number; timestamp: number; signature: string };

function encodeMandate(mandateId: bigint): Buffer {
  const purpose = Buffer.from(LIMITS.purpose, "utf8");
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const key of [OWNER, AGENT, MINT, SOURCE, MERCHANT]) {
    key.toBuffer().copy(buf, o);
    o += 32;
  }
  for (const value of [mandateId, BigInt(LIMITS.cap), 100_000n, BigInt(LIMITS.per_tx_max)]) {
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
  buf.writeUInt32LE(1, o);
  o += 4;
  buf.writeUInt32LE(1, o);
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

function record(mandate: PublicKey, row: Row): DecisionRecord {
  const reason = row.kind === "paid" ? 0 : 5;
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: LIMITS,
    kind: row.kind,
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: reason,
    reason_text: reasonText(reason),
    suggested_override: row.kind === "refused" ? row.amount : 0,
    signature: row.signature,
  });
}

function lines(mandate: PublicKey, row: Row): string[] {
  const body =
    row.kind === "paid"
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
  return [
    `Program ${PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    ...body,
    `Program ${PROGRAM.toBase58()} success`,
  ];
}

function ix(row: Row) {
  return {
    programIdIndex: 6,
    accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
    data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(row.amount)), u64Le(BigInt(row.nonce))]),
  };
}

function twoChargeTx(mandate: PublicKey, ledger: PublicKey, rows: Row[]): unknown {
  const keys = [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID];
  return {
    slot: 1,
    blockTime: rows[0]!.timestamp,
    transaction: { message: { staticAccountKeys: keys, compiledInstructions: rows.map(ix) } },
    meta: { err: null, logMessages: rows.flatMap((row) => lines(mandate, row)) },
  };
}

function chain(mandateId: bigint, rows: Row[]): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: token, owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(mandateId), owner: PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: PROGRAM }],
  ]);
  const tx = twoChargeTx(mandate, ledger, rows);
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return signature === SIG ? tx : null;
    },
    async getAccountInfo(address: PublicKey) {
      const hit = accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
  } as unknown as Connection;
  return { conn, mandate };
}

const refused: Row = { kind: "refused", amount: 600_000, nonce: 7, timestamp: T0, signature: SIG };
const paid: Row = { kind: "paid", amount: 100_000, nonce: 7, timestamp: T0, signature: SIG };

test("the second charge of a two-charge transaction exports and confirms", async () => {
  const { conn, mandate } = chain(136n, [refused, paid]);
  const exported = await recordFromSignature(conn, SIG, PROGRAM, "devnet", DEVNET_GENESIS, {
    mandate: mandate.toBase58(),
    nonce: BigInt(paid.nonce),
    amount: BigInt(paid.amount),
  });
  assert.equal(exported.kind, "paid");
  assert.equal(exported.amount, BigInt(paid.amount));
  assert.equal(exported.nonce, BigInt(paid.nonce));
  const verdict = await assessRecord(exported, RPC, conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
  assert.match(verdict.text, /VERDICT: CONFIRMED/);
});

test("export --signature refuses to guess when a transaction carries two charges", async () => {
  const { conn } = chain(1361n, [refused, paid]);
  await assert.rejects(
    () => recordFromSignature(conn, SIG, PROGRAM, "devnet", DEVNET_GENESIS),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /2 charges/);
      return true;
    },
  );
});

test("two charges with the same mandate, nonce, and amount do not confirm", async () => {
  const twin: Row = { kind: "paid", amount: 100_000, nonce: 7, timestamp: T0, signature: SIG };
  const { conn, mandate } = chain(1362n, [paid, twin]);
  const verdict = await assessRecord(record(mandate, paid), RPC, conn, OPTS);
  assert.equal(verdict.ok, false, verdict.text);
  assert.match(verdict.text, /2 charges matching mandate, nonce, and amount/);
  assert.doesNotMatch(verdict.text, /VERDICT: CONFIRMED/);
});
