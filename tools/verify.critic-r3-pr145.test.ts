// Backend critic, PR 145 round 3. Pins the two round 2 closures as typed
// decisions: the unread list is its own list (F3), and the -32602 carve-out
// reads the JSON-RPC code and nothing else (F4). Every test is green on 5ef3bbd.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
import { createFailoverConnection, isTransportError } from "../indexer/src/rpc.js";
import { makeBundle } from "./bulk.js";
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
const LIMITS = { cap: 1_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, purpose: "critic r3 pr145" };
const TIMEOUT_PUBKEY = "8ZtimeoutjoMuCTtfTGWTFnezvS2zLUWdgHwCUzLJg7x";
const CRAFTED_SIG = "sig was not checked: the RPC returned no transaction for a listed signature";
const SECRET_MARKER = "SECRET_KEY_MARKER_9f1c";

type Row = { amount: number; nonce: number; timestamp: number; signature: string };

function encodeMandate(mandateId: bigint, spendCount: number, spent: bigint): Buffer {
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
  buf.writeUInt32LE(0, o);
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
    data.writeBigUInt64LE(0n, off + 56);
    data[off + 64] = KIND_PAID;
    data[off + 65] = 0;
  });
  return data;
}

function recordOf(mandate: string, row: Row): DecisionRecord {
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
    kind: "paid",
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature: row.signature,
  });
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, row: Row): unknown {
  const logs = [
    `Program ${REAL_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    `Program log: VETO PAID amount=${row.amount} spent=${row.amount} of cap=${LIMITS.cap} remaining=1`,
    encodePaidLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), spent: BigInt(row.amount) }),
    `Program ${REAL_PROGRAM.toBase58()} success`,
  ];
  return {
    slot: 1,
    blockTime: row.timestamp,
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

type Chain = { conn: Connection; mandate: PublicKey; txs: Map<string, unknown> };

function chain(mandateId: bigint, rows: Row[], unread: Set<string>): Chain {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const spent = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: token, owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(mandateId, rows.length, spent), owner: REAL_PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: REAL_PROGRAM }],
  ]);
  const txs = new Map(rows.map((row) => [row.signature, chargeTx(mandate, ledger, row)]));
  const newestFirst = [...rows].reverse();
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      if (unread.has(signature)) return null;
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
  return { conn, mandate, txs };
}

function dateRangeBundle(decisions: DecisionRecord[]) {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "date_range", mandate: null, from: 100, to: 101 },
    decisions,
  });
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
type Answer = (method: string, id: unknown) => Response;
function rpcConnection(answer: Answer): Connection {
  const fetchLike = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: unknown };
    return answer(body.method, body.id);
  };
  return createFailoverConnection(["http://127.0.0.1:1"], () => {}, { fetch: fetchLike, sleep: async () => {} });
}

function json(id: unknown, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function nodeAnswers(onTransaction: (id: unknown) => Response, onGenesis?: (id: unknown) => Response): Answer {
  return (method, id) => {
    if (method === "getGenesisHash") return onGenesis ? onGenesis(id) : json(id, { result: DEVNET_GENESIS });
    if (method === "getAccountInfo") return json(id, { result: { context: { slot: 1 }, value: null } });
    if (method === "getTransaction") return onTransaction(id);
    return json(id, { result: null });
  };
}

const rpcError = (code: number, message: string) => (id: unknown) => json(id, { error: { code, message } });

// --------------------------------------------- F3: unread is a typed list

test("R3-1 F3: a real unread signature beside a record whose signature spells the phrase names only the real one", async () => {
  const rows: Row[] = [
    { amount: 10, nonce: 1, timestamp: 100, signature: CRAFTED_SIG },
    { amount: 10, nonce: 2, timestamp: 101, signature: "sig-dropped" },
  ];
  const { conn, mandate } = chain(3451n, rows, new Set(["sig-dropped"]));
  const result = await assessBundle(dateRangeBundle([recordOf(mandate.toBase58(), rows[0]!)]), RPC, conn, OPTS);
  assert.equal(result.code, 3, result.text);
  assert.deepEqual(result.failures, [
    "signature sig-dropped was not checked: the RPC returned no transaction for a listed signature",
  ]);
  assert.equal(result.text, `verify failed: ${result.failures[0]}\n`);
  assert.doesNotMatch(result.text, /VERDICT|CONFIRMED|REJECTED/);
});

test("R3-1 control: the same file with every listed signature answered is a REJECTED verdict, code 1", async () => {
  const rows: Row[] = [
    { amount: 10, nonce: 1, timestamp: 100, signature: CRAFTED_SIG },
    { amount: 10, nonce: 2, timestamp: 101, signature: "sig-present" },
  ];
  const { conn, mandate } = chain(3452n, rows, new Set());
  const result = await assessBundle(dateRangeBundle([recordOf(mandate.toBase58(), rows[0]!)]), RPC, conn, OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.match(result.text, /sig-present.*missing from the file/);
  assert.doesNotMatch(result.text, /^verify failed/m);
});

// ------------------------------- F4: the carve-out reads the code, not the text

test("R3-2 F4: JSON-RPC -32005 carrying the text 'Invalid param: WrongSize' is still transport (code decides, not message)", async () => {
  const conn = rpcConnection(nodeAnswers(rpcError(-32005, "Invalid param: WrongSize")));
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3453n);
  const record = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: TIMEOUT_PUBKEY });
  await assert.rejects(() => assessRecord(record, RPC, conn, OPTS), (err: unknown) => isTransportError(err));
  const bundle = await assessBundle(ruleBundle(mandate, [record]), RPC, conn, OPTS);
  assert.equal(bundle.code, 3, bundle.text);
  assert.match(bundle.text, /was not checked: .*Invalid param: WrongSize/);
  assert.doesNotMatch(bundle.text, /VERDICT/);
});

test("R3-2 F4: JSON-RPC -32602 carrying the text 'Node is unhealthy' is a rejection of the file (code decides, not message)", async () => {
  const conn = rpcConnection(nodeAnswers(rpcError(-32602, "Node is unhealthy")));
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3454n);
  const other = mandatePda(REAL_PROGRAM, OWNER, 3455n);
  const record = recordOf(other.toBase58(), { amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: TIMEOUT_PUBKEY });
  const bundle = await assessBundle(ruleBundle(mandate, [record]), RPC, conn, OPTS);
  assert.equal(bundle.code, 1, bundle.text);
  assert.match(bundle.text, /VERDICT: REJECTED/);
  assert.match(bundle.text, /mandate: row 8Ztimeout.* has .*, scope has /);
  assert.doesNotMatch(bundle.text, /was not checked/);
});

test("R3-3 F4: a 502 whose body is a JSON-RPC -32602 document is tagged transport at the fetch layer before any code is read", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param: WrongSize" } });
  const conn = rpcConnection(nodeAnswers(() => new Response(body, { status: 502, statusText: "Bad Gateway" })));
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3456n);
  const record = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: TIMEOUT_PUBKEY });
  const bundle = await assessBundle(ruleBundle(mandate, [record]), RPC, conn, OPTS);
  assert.equal(bundle.code, 3, bundle.text);
  assert.match(bundle.text, /was not checked: 502 Bad Gateway/);
});

test("R3-3 F4: JSON-RPC -32005 on getGenesisHash for a single record rejects typed as transport (verify.ts:196)", async () => {
  const conn = rpcConnection(nodeAnswers(rpcError(-32602, "unreached"), rpcError(-32005, "Node is unhealthy")));
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3457n);
  const record = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "5".repeat(87) });
  await assert.rejects(() => assessRecord(record, RPC, conn, OPTS), (err: unknown) => isTransportError(err));
});

// Bundle genesis reads use the same wrapper as a single record. A node failure
// is transport (exit 3). No verdict is printed.
test("R3-3: JSON-RPC -32005 on getGenesisHash for a bundle is transport, never CONFIRMED", async () => {
  const conn = rpcConnection(nodeAnswers(rpcError(-32602, "unreached"), rpcError(-32005, "Node is unhealthy")));
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3459n);
  const record = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "5".repeat(87) });
  await assert.rejects(
    () => assessBundle(ruleBundle(mandate, [record]), RPC, conn, OPTS),
    (err: unknown) => isTransportError(err) && /Node is unhealthy/.test(err instanceof Error ? err.message : ""),
  );
});

// ------------------------------------------- body cap, end to end through verify

test("R3-4 cap: a 5xx body echoing a key past byte 300 does not reach the not-checked line", async () => {
  const body = `${"x".repeat(600)}${SECRET_MARKER}${"y".repeat(400)}`;
  const conn = rpcConnection(nodeAnswers(() => new Response(body, { status: 502, statusText: "Bad Gateway" })));
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3458n);
  const record = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "5".repeat(87) });
  const bundle = await assessBundle(ruleBundle(mandate, [record]), RPC, conn, OPTS);
  assert.equal(bundle.code, 3, bundle.text);
  assert.doesNotMatch(bundle.text, new RegExp(SECRET_MARKER));
  const carried = bundle.text.split("502 Bad Gateway: ")[1] ?? "";
  assert.ok(Buffer.byteLength(carried.trimEnd()) <= 300, `carried ${Buffer.byteLength(carried)} bytes`);
});
