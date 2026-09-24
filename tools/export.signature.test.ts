// Issue 133. export --signature must bind a ring row with ringEntryForSignature,
// the same rule verify uses. The old scorer keeps the older row on a tie and
// still picks a row when blockTime is null.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodeRefusedLog } from "../indexer/src/events.js";
import { recordFromSignature } from "./export.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_REFUSED,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  ledgerPda,
  mandatePda,
  reasonText,
  u64Le,
} from "./lib.js";
import { assessRecord, type AssessOpts } from "./verify.js";

const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const T = 1_790_117_952;
const AMOUNT = 80_000;
const NONCE = 4;
const LIMITS = { cap: 1_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, purpose: "signature bind" };

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
  for (const value of [mandateId, BigInt(LIMITS.cap), 0n, BigInt(LIMITS.per_tx_max)]) {
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
  buf.writeUInt32LE(0, o);
  o += 4;
  buf.writeUInt32LE(2, o);
  o += 4;
  buf[o] = 255;
  return buf;
}

function encodeLedger(mandate: PublicKey): Buffer {
  const rows = [
    { timestamp: T - 2, nonce: NONCE },
    { timestamp: T + 1, nonce: NONCE },
  ];
  const data = Buffer.alloc(48 + LEDGER_CAPACITY * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  mandate.toBuffer().copy(data, 8);
  data.writeUInt32LE(rows.length, 40);
  data.writeUInt16LE(rows.length % LEDGER_CAPACITY, 44);
  rows.forEach((row, seq) => {
    const off = 48 + seq * 72;
    data.writeBigInt64LE(BigInt(row.timestamp), off);
    data.writeBigUInt64LE(BigInt(AMOUNT), off + 8);
    DEST.toBuffer().copy(data, off + 16);
    data.writeBigUInt64LE(BigInt(row.nonce), off + 48);
    data.writeBigUInt64LE(BigInt(AMOUNT), off + 56);
    data[off + 64] = KIND_REFUSED;
    data[off + 65] = 5;
  });
  return data;
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, blockTime: number | null): unknown {
  const logs = [
    `Program ${REAL_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    `Program log: VETO REFUSED reason=5 (${reasonText(5)}) amount=${AMOUNT} per_tx_max=${LIMITS.per_tx_max} remaining=1 override_to_clear=${AMOUNT}`,
    encodeRefusedLog({
      mandate,
      amount: BigInt(AMOUNT),
      nonce: BigInt(NONCE),
      reason: 5,
      suggestedOverride: BigInt(AMOUNT),
    }),
    `Program ${REAL_PROGRAM.toBase58()} success`,
  ];
  return {
    slot: 1,
    blockTime,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, REAL_PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [
          {
            programIdIndex: 6,
            accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
            data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(AMOUNT)), u64Le(BigInt(NONCE))]),
          },
        ],
      },
    },
    meta: { err: null, logMessages: logs },
  };
}

function chain(blockTime: number | null): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 133n);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: token, owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(133n), owner: REAL_PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate), owner: REAL_PROGRAM }],
  ]);
  const tx = chargeTx(mandate, ledger, blockTime);
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction() {
      return tx;
    },
    async getAccountInfo(address: PublicKey) {
      const hit = accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
    async getSignaturesForAddress() {
      // The listing has to contain the signature export is reading.
      return ["charge-at-t", "charge-null-time"].map((signature) => ({
        signature,
        slot: 1,
        err: null,
        memo: null,
        blockTime,
        confirmationStatus: "confirmed" as const,
      }));
    },
  } as unknown as Connection;
  return { conn, mandate };
}

test("export --signature binds the nearer ring row, and that record confirms", async () => {
  const { conn } = chain(T);
  const record = await recordFromSignature(conn, "charge-at-t", REAL_PROGRAM, "devnet", DEVNET_GENESIS);
  assert.equal(record.timestamp, BigInt(T + 1));
  const verdict = await assessRecord(record, RPC, conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
});

test("export --signature refuses to bind when blockTime is null and several rows share the nonce", async () => {
  const { conn } = chain(null);
  await assert.rejects(
    () => recordFromSignature(conn, "charge-null-time", REAL_PROGRAM, "devnet", DEVNET_GENESIS),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /signature charge-null-time matches 2 ledger rows for nonce 4 equally; refusing to bind to the newest/);
      return true;
    },
  );
});
