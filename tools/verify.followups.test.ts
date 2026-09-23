// Issue 130. A per-row transport error is not a verdict: the row was not checked.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { makeBundle } from "./bulk.js";
import {
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
  type DecisionRecord,
} from "./lib.js";
import { assessBundle, type AssessOpts, type Verdict } from "./verify.js";

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
const LIMITS = { cap: 1_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, purpose: "followups" };

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

function recordOf(mandate: PublicKey, row: Row): DecisionRecord {
  const refused = row.kind === "refused";
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: REAL_PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: {
      cap: LIMITS.cap,
      per_tx_max: LIMITS.per_tx_max,
      expires_at: LIMITS.expires_at,
      merchant: MERCHANT.toBase58(),
      purpose: LIMITS.purpose,
    },
    kind: row.kind,
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: refused ? 5 : 0,
    reason_text: reasonText(refused ? 5 : 0),
    suggested_override: refused ? row.amount : 0,
    signature: row.signature,
  });
}

function chain(args: {
  mandateId: bigint;
  rows: Row[];
  getTransaction: (signature: string) => Promise<unknown>;
}): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, args.mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const paid = args.rows.filter((row) => row.kind === "paid");
  const refused = args.rows.filter((row) => row.kind === "refused");
  const spent = paid.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: token, owner: TOKEN_PROGRAM_ID }],
    [
      mandate.toBase58(),
      { data: encodeMandate(args.mandateId, paid.length, refused.length, spent), owner: REAL_PROGRAM },
    ],
    [ledger.toBase58(), { data: encodeLedger(mandate, args.rows), owner: REAL_PROGRAM }],
  ]);
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    getTransaction: args.getTransaction,
    async getAccountInfo(address: PublicKey) {
      const hit = accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
    async getSignaturesForAddress() {
      return [];
    },
  } as unknown as Connection;
  return { conn, mandate };
}

function assertNotChecked(result: Verdict, signature: string, detail: string): void {
  assert.equal(result.code, 3);
  assert.equal(result.ok, false);
  assert.match(result.text, new RegExp(`signature=${signature} was not checked: ${detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(result.text, /VERDICT/);
  assert.doesNotMatch(result.text, /REJECTED/);
  assert.doesNotMatch(result.text, /CONFIRMED/);
}

const TRANSPORT = [
  { name: "rate limit", detail: "rpc rate limited on https://api.devnet.solana.com" },
  { name: "timeout", detail: "request timed out" },
  { name: "network", detail: "fetch failed: connect ECONNRESET" },
] as const;

for (const item of TRANSPORT) {
  test(`a ${item.name} while checking a row reports that row as not checked`, async () => {
    const signature = `sig-${item.name.replace(" ", "-")}`;
    const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature }];
    const { conn, mandate } = chain({
      mandateId: 130n,
      rows,
      async getTransaction() {
        throw new Error(item.detail);
      },
    });
    const bundle = makeBundle({
      cluster: "devnet",
      genesisHash: DEVNET_GENESIS,
      programId: REAL_PROGRAM.toBase58(),
      scope: { type: "rule", mandate: mandate.toBase58(), from: null, to: null },
      decisions: [recordOf(mandate, rows[0]!)],
    });
    const result = await assessBundle(bundle, RPC, conn, OPTS);
    assertNotChecked(result, signature, item.detail);
  });
}

test("a missing signature is still a rejected row", async () => {
  const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "missing-sig" }];
  const { conn, mandate } = chain({
    mandateId: 1301n,
    rows,
    async getTransaction() {
      return null;
    },
  });
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "rule", mandate: mandate.toBase58(), from: null, to: null },
    decisions: [recordOf(mandate, rows[0]!)],
  });
  const result = await assessBundle(bundle, RPC, conn, OPTS);
  assert.equal(result.code, 1);
  assert.equal(result.ok, false);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.match(result.text, /missing-sig not found on/);
  assert.doesNotMatch(result.text, /was not checked/);
});
