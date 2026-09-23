// Backend critic, PR 154 round 4.
// Regression lock for the two paths the round 3 fix removed from limitSource
// (verify.ts, the `live` branch): a live mandate whose ring holds the record's
// mandate, nonce, and amount is not proof that the listing would have held
// the signature. An empty mandate listing, and a connection that cannot list
// signatures at all, both reject with `mandate history does not list
// signature`. With the listing intact the same record CONFIRMS, so the
// rejection comes from the listing and nothing else.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
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
const PER_TX = 500_000n;
const EXPIRES = 1_797_713_870n;
const T1 = 1_790_300_400;
const CAP = 1_000_000n;
const PURPOSE = "single-tenure";
const SIG = "charge-1-1";
const SLOT = 2;
const AMOUNT = 100_000;
const NONCE = 1;

function encodeMandate(mandateId: bigint, spendCount: number): Buffer {
  const purpose = Buffer.from(PURPOSE, "utf8");
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const key of [OWNER, AGENT, MINT, SOURCE, MERCHANT]) {
    key.toBuffer().copy(buf, o);
    o += 32;
  }
  for (const value of [mandateId, CAP, 100_000n, PER_TX]) {
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

// One paid row: the record's own triple.
function encodeLedger(mandate: PublicKey): Buffer {
  const data = Buffer.alloc(48 + LEDGER_CAPACITY * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  mandate.toBuffer().copy(data, 8);
  data.writeUInt32LE(1, 40);
  data.writeUInt16LE(1, 44);
  const off = 48;
  data.writeBigInt64LE(BigInt(T1), off);
  data.writeBigUInt64LE(BigInt(AMOUNT), off + 8);
  DEST.toBuffer().copy(data, off + 16);
  data.writeBigUInt64LE(BigInt(NONCE), off + 48);
  data.writeBigUInt64LE(0n, off + 56);
  data[off + 64] = KIND_PAID;
  data[off + 65] = 0;
  return data;
}

function chargeTx(mandate: PublicKey, ledger: PublicKey): unknown {
  return {
    slot: SLOT,
    blockTime: T1,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [
          { programIdIndex: 6, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7], data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(AMOUNT)), u64Le(BigInt(NONCE))]) },
        ],
      },
    },
    meta: {
      err: null,
      logMessages: [
        `Program ${PROGRAM.toBase58()} invoke [1]`,
        "Program log: Instruction: Charge",
        `Program log: VETO PAID amount=${AMOUNT} spent=${AMOUNT} of cap=1 remaining=1`,
        encodePaidLog({ mandate, amount: BigInt(AMOUNT), nonce: BigInt(NONCE), spent: BigInt(AMOUNT) }),
        `Program ${PROGRAM.toBase58()} success`,
      ],
    },
  };
}

function paidRecord(mandate: PublicKey): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: { cap: Number(CAP), per_tx_max: Number(PER_TX), expires_at: Number(EXPIRES), merchant: MERCHANT.toBase58(), purpose: PURPOSE },
    kind: "paid",
    amount: AMOUNT,
    counterparty: DEST.toBase58(),
    timestamp: T1,
    nonce: NONCE,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature: SIG,
  });
}

type Listing = "intact" | "empty" | "absent";

// Live single-tenure mandate, ring holds the charge. `intact` lists the
// charge; `empty` serves an empty page for every address; `absent` is a
// connection with no getSignaturesForAddress at all.
function chain(mandateId: bigint, listing: Listing): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: token, owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(mandateId, 1), owner: PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate), owner: PROGRAM }],
  ]);
  const tx = chargeTx(mandate, ledger);
  const conn: Record<string, unknown> = {
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
  };
  if (listing !== "absent") {
    conn.getSignaturesForAddress = async () =>
      listing === "intact"
        ? [{ signature: SIG, slot: SLOT, err: null, memo: null, blockTime: T1, confirmationStatus: "confirmed" as const }]
        : [];
  }
  return { conn: conn as unknown as Connection, mandate };
}

test("critic r4 control: a single-tenure live mandate whose listing holds the charge CONFIRMS", async () => {
  const { conn, mandate } = chain(1600n, "intact");
  const result = await assessRecord(paidRecord(mandate), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /VERDICT: CONFIRMED/);
});

test("critic r4 lock: an empty mandate listing rejects the same record even though the live ring holds its triple", async () => {
  const { conn, mandate } = chain(1601n, "empty");
  const result = await assessRecord(paidRecord(mandate), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, new RegExp(`mandate history does not list signature ${SIG}`));
});

test("critic r4 lock: a connection with no getSignaturesForAddress rejects the same record even though the live ring holds its triple", async () => {
  const { conn, mandate } = chain(1602n, "absent");
  const result = await assessRecord(paidRecord(mandate), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, new RegExp(`mandate history does not list signature ${SIG}`));
});
