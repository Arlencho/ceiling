// Backend critic, PR 145 round 2. Two shapes the round 1 fix introduced and
// one parity regression check for the export/verify binder.
// Tests marked RED-ON-HEAD fail on bcefc31.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog, encodeRefusedLog } from "../indexer/src/events.js";
import { createFailoverConnection, isTransportError } from "../indexer/src/rpc.js";
import { makeBundle } from "./bulk.js";
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
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

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
const LIMITS = { cap: 1_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, purpose: "critic r2 pr145" };
// Same key round 1 used as a mandate. As a signature it is 32 bytes, and a
// node answers getTransaction with the JSON-RPC error "Invalid param: WrongSize"
// (checked against api.devnet.solana.com on 2026-09-23).
const TIMEOUT_PUBKEY = "8ZtimeoutjoMuCTtfTGWTFnezvS2zLUWdgHwCUzLJg7x";
// A record signature is requireString only (lib.ts:741). verify.ts:687 picks
// "not checked" lines out of the envelope by substring, and envelope lines
// embed the record signature.
const CRAFTED_SIG = "sig was not checked: the RPC returned no transaction for a listed signature";

type Row = { kind: "paid" | "refused"; amount: number; nonce: number; timestamp: number; signature: string; reason?: number };

function reasonOf(row: Row): number {
  return row.kind === "paid" ? 0 : (row.reason ?? 5);
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
    data.writeBigUInt64LE(BigInt(row.kind === "refused" ? row.amount : 0), off + 56);
    data[off + 64] = row.kind === "paid" ? KIND_PAID : KIND_REFUSED;
    data[off + 65] = reasonOf(row);
  });
  return data;
}

function recordOf(mandate: string, row: Row): DecisionRecord {
  const refused = row.kind === "refused";
  const reason = reasonOf(row);
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: REAL_PROGRAM.toBase58(),
    mandate,
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
    reason_code: reason,
    reason_text: reasonText(reason),
    suggested_override: refused ? row.amount : 0,
    signature: row.signature,
  });
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, row: Row, blockTime: number | null = row.timestamp): unknown {
  const decision =
    row.kind === "paid"
      ? [
          `Program log: VETO PAID amount=${row.amount} spent=${row.amount} of cap=${LIMITS.cap} remaining=1`,
          encodePaidLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), spent: BigInt(row.amount) }),
        ]
      : [
          `Program log: VETO REFUSED reason=${reasonOf(row)} (${reasonText(reasonOf(row))}) amount=${row.amount} per_tx_max=${LIMITS.per_tx_max} remaining=1 override_to_clear=${row.amount}`,
          encodeRefusedLog({
            mandate,
            amount: BigInt(row.amount),
            nonce: BigInt(row.nonce),
            reason: reasonOf(row),
            suggestedOverride: BigInt(row.amount),
          }),
        ];
  const logs = [
    `Program ${REAL_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    ...decision,
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
            data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(row.amount)), u64Le(BigInt(row.nonce))]),
          },
        ],
      },
    },
    meta: { err: null, logMessages: logs },
  };
}

type Chain = { conn: Connection; mandate: PublicKey; ledger: PublicKey; txs: Map<string, unknown> };

function chain(args: { mandateId: bigint; rows: Row[]; blockTime?: (row: Row) => number | null }): Chain {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, args.mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const paid = args.rows.filter((row) => row.kind === "paid");
  const refused = args.rows.filter((row) => row.kind === "refused");
  const spent = paid.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: token, owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(args.mandateId, paid.length, refused.length, spent), owner: REAL_PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, args.rows), owner: REAL_PROGRAM }],
  ]);
  const txs = new Map(
    args.rows.map((row) => [row.signature, chargeTx(mandate, ledger, row, args.blockTime ? args.blockTime(row) : row.timestamp)]),
  );
  const newestFirst = [...args.rows].reverse();
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
      const start = config?.before ? newestFirst.findIndex((row) => row.signature === config.before) + 1 : 0;
      const limit = config?.limit ?? newestFirst.length;
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
  return { conn, mandate, ledger, txs };
}

function ruleBundle(mandate: PublicKey, decisions: DecisionRecord[]) {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "rule", mandate: mandate.toBase58(), from: null, to: null },
    decisions,
  });
}

// A real web3 Connection over the real failover fetch, answered in process.
// getTransaction answers as a node does for a signature of the wrong length.
type Answer = (method: string, id: unknown) => Response;
function rpcConnection(answer: Answer): Connection {
  const fetchLike = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: unknown };
    return answer(body.method, body.id);
  };
  return createFailoverConnection(["http://127.0.0.1:1"], () => {}, { fetch: fetchLike });
}

function json(id: unknown, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function nodeAnswers(onTransaction: (id: unknown) => Response): Answer {
  return (method, id) => {
    if (method === "getGenesisHash") return json(id, { result: DEVNET_GENESIS });
    if (method === "getAccountInfo") return json(id, { result: { context: { slot: 1 }, value: null } });
    if (method === "getTransaction") return onTransaction(id);
    return json(id, { result: null });
  };
}

const wrongSize = (id: unknown) => json(id, { error: { code: -32602, message: "Invalid param: WrongSize" } });

// ------------------------------------------------ verify.ts:687 substring filter

test("R2-1 RED-ON-HEAD: a record signature that spells the unread phrase turns a REJECTED bundle into exit 3", async () => {
  const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: CRAFTED_SIG }];
  const { conn, mandate } = chain({ mandateId: 2451n, rows });
  const other = mandatePda(REAL_PROGRAM, OWNER, 2452n);
  // scope names the chain mandate, the row names another one: the envelope
  // line "mandate: row <sig> has ..., scope has ..." embeds the signature.
  const result = await assessBundle(ruleBundle(mandate, [recordOf(other.toBase58(), rows[0]!)]), RPC, conn, OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.match(result.text, /mandate: row sig was not checked.* has .*, scope has /);
  assert.doesNotMatch(result.text, /^verify failed/m);
});

test("R2-1 control: a listed signature with no transaction is still not checked (code 3)", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 10, nonce: 1, timestamp: 100, signature: "sig-kept" },
    { kind: "paid", amount: 10, nonce: 2, timestamp: 101, signature: "sig-dropped" },
  ];
  const base = chain({ mandateId: 2453n, rows });
  const conn = {
    ...base.conn,
    async getTransaction(signature: string) {
      return signature === "sig-dropped" ? null : (base.txs.get(signature) ?? null);
    },
  } as unknown as Connection;
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "date_range", mandate: null, from: 100, to: 101 },
    decisions: [recordOf(base.mandate.toBase58(), rows[0]!)],
  });
  const result = await assessBundle(bundle, RPC, conn, OPTS);
  assert.equal(result.code, 3, result.text);
  assert.match(result.text, /signature sig-dropped was not checked: the RPC returned no transaction/);
  assert.doesNotMatch(result.text, /VERDICT|CONFIRMED|REJECTED/);
});

// -------------------------------- verify.ts:805 tags a JSON-RPC error as transport

test("R2-2 RED-ON-HEAD: single record, a 32-byte signature is REJECTED, not a transport failure", async () => {
  const conn = rpcConnection(nodeAnswers(wrongSize));
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 2454n);
  const record = recordOf(mandate.toBase58(), { kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: TIMEOUT_PUBKEY });
  let thrown: unknown = null;
  try {
    const result = await assessRecord(record, RPC, conn, OPTS);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /REJECTED/);
    return;
  } catch (err) {
    thrown = err;
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  assert.equal(isTransportError(thrown), false, `classified as transport: ${message}`);
});

test("R2-2 RED-ON-HEAD: bundle, the same signature drops the envelope forgery line and exits 3", async () => {
  const conn = rpcConnection(nodeAnswers(wrongSize));
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 2455n);
  const other = mandatePda(REAL_PROGRAM, OWNER, 2456n);
  const record = recordOf(other.toBase58(), { kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: TIMEOUT_PUBKEY });
  const result = await assessBundle(ruleBundle(mandate, [record]), RPC, conn, OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.match(result.text, /mandate: row 8Ztimeout.* has .*, scope has /);
  assert.doesNotMatch(result.text, /was not checked/);
});

test("R2-2 control: a 502 on getTransaction through the same connection is a transport failure", async () => {
  const conn = rpcConnection(nodeAnswers(() => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" })));
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 2457n);
  const record = recordOf(mandate.toBase58(), { kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "5".repeat(87) });
  await assert.rejects(
    () => assessRecord(record, RPC, conn, OPTS),
    (err: unknown) => isTransportError(err) && /502 Bad Gateway/.test(err instanceof Error ? err.message : ""),
  );
});

// ---------------------------------------- export and verify bind the same row

const T = 1_790_117_952;

test("R2-3 parity: a paid row at T-2 and a refused row at T+1 on one nonce bind the same row in export and verify", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 80_000, nonce: 4, timestamp: T - 2, signature: "paid-tx" },
    { kind: "refused", amount: 80_000, nonce: 4, timestamp: T + 1, signature: "refused-tx", reason: 4 },
  ];
  const { conn, mandate } = chain({ mandateId: 2458n, rows, blockTime: () => T });
  for (const row of rows) {
    const exported = await recordFromSignature(conn, row.signature, REAL_PROGRAM, "devnet", DEVNET_GENESIS);
    assert.equal(exported.timestamp, BigInt(row.timestamp), `${row.signature}: export bound ts=${exported.timestamp}`);
    assert.equal(exported.kind, row.kind);
    const verdict = await assessRecord(exported, RPC, conn, OPTS);
    assert.equal(verdict.ok, true, `${row.signature}: export bound ts=${exported.timestamp} kind=${exported.kind}; verify said:\n${verdict.text}`);
    // The other row of the pair, carried under this signature, is refused.
    const wrong = rows.find((r) => r !== row)!;
    const stale = await assessRecord(recordOf(mandate.toBase58(), { ...wrong, signature: row.signature }), RPC, conn, OPTS);
    assert.equal(stale.ok, false, stale.text);
  }
});
