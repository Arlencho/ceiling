// Security critic, PR 145 round 2. Re-verifies the round 1 HIGH (S3) and
// MEDIUM (transport shapes) through the real fetch layer, then tries every
// attacker-chosen string against the "not checked" path.
//
// Tests marked RED-ON-HEAD fail on bcefc31 / abb9e9e. Tests marked GUARD are
// green on head and pin a shape the fix for the backend's F4 must keep.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
import { RateLimitedError, TransportError, createFailoverConnection, isTransportError } from "../indexer/src/rpc.js";
import { bundleToJson, makeBundle, parseExportText, type DecisionBundle } from "./bulk.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  fetchMandate,
  ledgerPda,
  mandatePda,
  parseRecord,
  reasonText,
  tokenAccountOwner,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assessBundle, assessRecord, type AssessOpts, type Verdict } from "./verify.js";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const TIMEOUT_DEST = new PublicKey("8ZtimeoutjoMuCTtfTGWTFnezvS2zLUWdgHwCUzLJg7x");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const LIMITS = { cap: 1_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, purpose: "critic sec r2 pr145" };
const T = 1_790_117_952;
// A well-formed 64-byte signature so the node has no reason to reject the parameter.
const SIG64 = "5".repeat(87);
// The substring verify.ts:687 picks out of the envelope.
const PHRASE = "was not checked: the RPC returned no transaction for a listed signature";

type Row = { kind: "paid" | "refused"; amount: number; nonce: number; timestamp: number; signature: string };

function reasonOf(row: Row): number {
  return row.kind === "paid" ? 0 : 5;
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
    data.writeBigUInt64LE(0n, off + 56);
    data[off + 64] = KIND_PAID;
    data[off + 65] = reasonOf(row);
  });
  return data;
}

type Claim = { amount?: number; cluster?: string; genesis_hash?: string; purpose?: string; reason_text?: string; mandate?: string };

function recordOf(mandate: string, row: Row, claim: Claim = {}): DecisionRecord {
  const reason = reasonOf(row);
  return parseRecord({
    schema_version: 1,
    cluster: claim.cluster ?? "devnet",
    genesis_hash: claim.genesis_hash ?? DEVNET_GENESIS,
    program_id: REAL_PROGRAM.toBase58(),
    mandate: claim.mandate ?? mandate,
    limits: {
      cap: LIMITS.cap,
      per_tx_max: LIMITS.per_tx_max,
      expires_at: LIMITS.expires_at,
      merchant: MERCHANT.toBase58(),
      purpose: claim.purpose ?? LIMITS.purpose,
    },
    kind: row.kind,
    amount: claim.amount ?? row.amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: reason,
    reason_text: claim.reason_text ?? reasonText(reason),
    suggested_override: 0,
    signature: row.signature,
  });
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, row: Row, extraLog?: string): unknown {
  const logs = [
    `Program ${REAL_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    ...(extraLog ? [extraLog] : []),
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

type Chain = { conn: Connection; mandate: PublicKey; ledger: PublicKey };

// Mock connection. Typed errors thrown here are exactly what the real fetch
// layer raises (rpc.ts:245, :253, :275), so a mock throwing TransportError or
// RateLimitedError is faithful on this head.
function chain(args: {
  mandateId: bigint;
  rows: Row[];
  extraLog?: string;
  genesis?: () => Promise<string>;
  getTransaction?: (signature: string, fallback: (signature: string) => Promise<unknown>) => Promise<unknown>;
  getAccountInfo?: (address: PublicKey, fallback: (address: PublicKey) => Promise<unknown>) => Promise<unknown>;
  getSignaturesForAddress?: () => Promise<unknown>;
}): Chain {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, args.mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const spent = args.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: token, owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(args.mandateId, args.rows.length, 0, spent), owner: REAL_PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, args.rows), owner: REAL_PROGRAM }],
  ]);
  const txs = new Map(args.rows.map((row) => [row.signature, chargeTx(mandate, ledger, row, args.extraLog)]));
  const txFallback = async (signature: string) => txs.get(signature) ?? null;
  const accountFallback = async (address: PublicKey) => {
    const hit = accounts.get(address.toBase58());
    if (!hit) return null;
    return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
  };
  const newestFirst = [...args.rows].reverse();
  const conn = {
    getGenesisHash: args.genesis ?? (async () => DEVNET_GENESIS),
    getTransaction: args.getTransaction ? (s: string) => args.getTransaction!(s, txFallback) : txFallback,
    getAccountInfo: args.getAccountInfo ? (a: PublicKey) => args.getAccountInfo!(a, accountFallback) : accountFallback,
    getSignaturesForAddress:
      args.getSignaturesForAddress ??
      (async (_address: PublicKey, config?: { before?: string; limit?: number }) => {
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
      }),
  } as unknown as Connection;
  return { conn, mandate, ledger };
}

function ruleBundle(mandate: string, decisions: DecisionRecord[], envelope: { program_id?: string; cluster?: string } = {}) {
  return makeBundle({
    cluster: envelope.cluster ?? "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: envelope.program_id ?? REAL_PROGRAM.toBase58(),
    scope: { type: "rule", mandate, from: null, to: null },
    decisions,
  });
}

function dateRangeBundle(decisions: DecisionRecord[], from: number, to: number): DecisionBundle {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "date_range", mandate: null, from, to },
    decisions,
  });
}

function neverConfirmed(result: Verdict): void {
  assert.notEqual(result.code, 0, result.text);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.text, /CONFIRMED|confirmed: /);
}

function notChecked(result: Verdict, signature: string): void {
  assert.equal(result.code, 3, result.text);
  assert.match(result.text, new RegExp(`signature=${signature} was not checked`));
  assert.doesNotMatch(result.text, /VERDICT/);
}

function rejectedVerdict(result: Verdict): void {
  assert.equal(result.code, 1, result.text);
  assert.equal(result.ok, false);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.doesNotMatch(result.text, /^verify failed/m);
}

// A real web3 Connection over the real failover fetch, answered in process
// (the backend's round 2 harness). sleep is a no-op so 429 exhausts instantly.
type Answer = (method: string, id: unknown) => Promise<Response> | Response;
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

function nodeAnswers(onTransaction: (id: unknown) => Promise<Response> | Response, onAccount?: (id: unknown) => Response): Answer {
  return (method, id) => {
    if (method === "getGenesisHash") return json(id, { result: DEVNET_GENESIS });
    if (method === "getAccountInfo") return (onAccount ?? ((i) => json(i, { result: { context: { slot: 1 }, value: null } })))(id);
    if (method === "getTransaction") return onTransaction(id);
    return json(id, { result: null });
  };
}

function http(status: number, statusText: string, body: string): Response {
  return new Response(body, { status, statusText });
}

// ------------------------------------------------ T1: transport shapes through the real fetch layer
//
// Round 1 S1 threw a plain Error from a mock; on this head that is green only
// because verify.ts:818 re-tags every rejection. These drive the real layer so
// they keep meaning once that re-tag is narrowed.

const TRANSPORT_SHAPES: { name: string; answer: (id: unknown) => Promise<Response> | Response; guard?: true }[] = [
  { name: "500 Internal Server Error", answer: () => http(500, "Internal Server Error", "") },
  { name: "502 Bad Gateway with an html body", answer: () => http(502, "Bad Gateway", "<html><body>502 Bad Gateway</body></html>") },
  { name: "503 Service Unavailable", answer: () => http(503, "Service Unavailable", "upstream connect error") },
  { name: "429 on every pass", answer: () => http(429, "Too Many Requests", "") },
  {
    name: "fetch rejecting with an undici headers timeout",
    answer: async () => {
      const cause = Object.assign(new Error("Headers Timeout Error"), { name: "HeadersTimeoutError", code: "UND_ERR_HEADERS_TIMEOUT" });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    },
  },
  { name: "200 with a non-JSON maintenance body", answer: () => http(200, "OK", "<html>maintenance</html>") },
  // GUARD: valid JSON that is not a JSON-RPC envelope. Green on head through the
  // verify.ts:818 re-tag; a fix for the backend's F4 that just deletes the re-tag
  // turns this into a REJECTED row again (the round 1 MEDIUM).
  { name: "200 with valid JSON that is not a JSON-RPC envelope", answer: () => http(200, "OK", "{}"), guard: true },
  // GUARD: a JSON-RPC error the node raises about itself, not about the parameter.
  { name: "JSON-RPC error -32005 Node is unhealthy", answer: (id) => json(id, { error: { code: -32005, message: "Node is unhealthy", data: { numSlotsBehind: 100 } } }), guard: true },
];

for (const shape of TRANSPORT_SHAPES) {
  const tag = shape.guard ? "GUARD" : "130";
  test(`T1 ${tag}: ${shape.name} on getTransaction is not checked in a bundle and rejects typed for a single record`, async () => {
    const row: Row = { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: SIG64 };
    const mandate = mandatePda(REAL_PROGRAM, OWNER, 2461n);
    const record = recordOf(mandate.toBase58(), row);
    const bundle = await assessBundle(ruleBundle(mandate.toBase58(), [record]), RPC, rpcConnection(nodeAnswers(shape.answer)), OPTS);
    neverConfirmed(bundle);
    notChecked(bundle, SIG64);
    await assert.rejects(
      () => assessRecord(record, RPC, rpcConnection(nodeAnswers(shape.answer)), OPTS),
      (err: unknown) => isTransportError(err),
    );
  });
}

test("T1 130: a null result for the row's own signature through the real layer is REJECTED, code 1, never not checked", async () => {
  const row: Row = { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: SIG64 };
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 2462n);
  const conn = rpcConnection(nodeAnswers((id) => json(id, { result: null })));
  const result = await assessBundle(ruleBundle(mandate.toBase58(), [recordOf(mandate.toBase58(), row)]), RPC, conn, OPTS);
  neverConfirmed(result);
  rejectedVerdict(result);
  assert.match(result.text, new RegExp(`signature ${SIG64} not found on`));
});

// ------------------------------------------------ T2: the account path through the real fetch layer (round 1 HIGH)

test("T2 HIGH ADDRESSED: getAccountInfo answering value null for the timeout key is a plain not-found error, never transport", async () => {
  const conn = rpcConnection(nodeAnswers(() => json(1, { result: null })));
  await assert.rejects(
    () => tokenAccountOwner(conn, TIMEOUT_DEST),
    (err: unknown) => !isTransportError(err) && /^token account not found: 8Ztimeout/.test(err instanceof Error ? err.message : ""),
  );
  await assert.rejects(
    () => fetchMandate(conn, TIMEOUT_DEST),
    (err: unknown) => !isTransportError(err) && /^mandate account not found: 8Ztimeout/.test(err instanceof Error ? err.message : ""),
  );
});

test("T2 HIGH ADDRESSED: a 502 on getAccountInfo survives web3's plain-Error wrap as transport (lib.ts:499)", async () => {
  const conn = rpcConnection(nodeAnswers(() => json(1, { result: null }), () => http(502, "Bad Gateway", "<html>bad gateway</html>")));
  await assert.rejects(
    () => fetchMandate(conn, TIMEOUT_DEST),
    (err: unknown) => isTransportError(err) && /502 Bad Gateway/.test(err instanceof Error ? err.message : ""),
  );
});

// ------------------------------------------------ T3: attacker-chosen strings against verify.ts:687
//
// The unread filter scans every envelope line for PHRASE. Envelope lines embed
// record.cluster (:430), record.genesis_hash (:426), bundle.program_id (:403),
// scope.mandate (:433, :448) and record.signature (:421 to :433, the backend's
// R2-1). All are requireString or non-empty only. A file that carries the
// phrase in any of them exits 3 before a single row is checked, and every
// REJECTED line the envelope found is dropped with it.

test("T3 RED-ON-HEAD: record.cluster carrying the phrase turns a REJECTED bundle into exit 3", async () => {
  const row: Row = { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-t3-cluster" };
  const { conn, mandate } = chain({ mandateId: 2463n, rows: [row] });
  const record = recordOf(mandate.toBase58(), row, { cluster: `devnet ${PHRASE}` });
  const result = await assessBundle(ruleBundle(mandate.toBase58(), [record]), RPC, conn, OPTS);
  neverConfirmed(result);
  rejectedVerdict(result);
  assert.match(result.text, /cluster: row sig-t3-cluster has devnet was not checked/);
});

test("T3 RED-ON-HEAD: record.genesis_hash carrying the phrase turns a REJECTED bundle into exit 3", async () => {
  const row: Row = { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-t3-genesis" };
  const { conn, mandate } = chain({ mandateId: 2464n, rows: [row] });
  const record = recordOf(mandate.toBase58(), row, { genesis_hash: `${DEVNET_GENESIS} ${PHRASE}` });
  const result = await assessBundle(ruleBundle(mandate.toBase58(), [record]), RPC, conn, OPTS);
  neverConfirmed(result);
  rejectedVerdict(result);
  assert.match(result.text, /genesis_hash: row sig-t3-genesis has/);
});

test("T3 RED-ON-HEAD: the envelope program_id carrying the phrase turns a REJECTED bundle into exit 3", async () => {
  const row: Row = { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-t3-program" };
  const { conn, mandate } = chain({ mandateId: 2465n, rows: [row] });
  const bundle = ruleBundle(mandate.toBase58(), [recordOf(mandate.toBase58(), row)], { program_id: `${REAL_PROGRAM.toBase58()} ${PHRASE}` });
  // The CLI accepts this envelope: program_id is a non-empty string (bulk.ts:258).
  const parsed = parseExportText(bundleToJson(bundle));
  assert.equal(parsed.kind, "bundle");
  const result = await assessBundle(bundle, RPC, conn, OPTS);
  neverConfirmed(result);
  rejectedVerdict(result);
  assert.match(result.text, /program_id: envelope has/);
});

test("T3 RED-ON-HEAD: scope.mandate carrying the phrase needs nothing on chain and turns a forged bundle into exit 3", async () => {
  const row: Row = { kind: "paid", amount: 999, nonce: 7, timestamp: T, signature: "sig-t3-scope" };
  const { conn, mandate } = chain({ mandateId: 2466n, rows: [] });
  const bundle = ruleBundle(`${mandate.toBase58()} ${PHRASE}`, [recordOf(mandate.toBase58(), row)]);
  const parsed = parseExportText(bundleToJson(bundle));
  assert.equal(parsed.kind, "bundle");
  const result = await assessBundle(bundle, RPC, conn, OPTS);
  neverConfirmed(result);
  rejectedVerdict(result);
  assert.match(result.text, /scope\.mandate .* is not a pubkey/);
  // The forged row is named, not dropped.
  assert.match(result.text, /sig-t3-scope/);
});

test("T3 control: record.mandate cannot carry the phrase, parseRecord refuses it", () => {
  const row: Row = { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-t3-mandate" };
  assert.throws(() => recordOf(DEST.toBase58(), row, { mandate: `${DEST.toBase58()} ${PHRASE}` }), /mandate/);
});

test("T3 control: the phrase in limits.purpose and reason_text lands in row failures and stays a REJECTED verdict", async () => {
  const row: Row = { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-t3-row" };
  const { conn, mandate } = chain({ mandateId: 2467n, rows: [row] });
  const record = recordOf(mandate.toBase58(), row, { purpose: `x ${PHRASE}`, reason_text: `ok ${PHRASE}` });
  const result = await assessBundle(ruleBundle(mandate.toBase58(), [record]), RPC, conn, OPTS);
  rejectedVerdict(result);
  assert.match(result.text, /REJECTED row 1 signature=sig-t3-row/);
});

test("T3 control: a program log line carrying the phrase is inert, the honest row still confirms", async () => {
  const row: Row = { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-t3-log" };
  const { conn, mandate } = chain({ mandateId: 2468n, rows: [row], extraLog: `Program log: signature sig-t3-log ${PHRASE}` });
  const result = await assessBundle(ruleBundle(mandate.toBase58(), [recordOf(mandate.toBase58(), row)]), RPC, conn, OPTS);
  assert.equal(result.code, 0, result.text);
  assert.doesNotMatch(result.text, /was not checked/);
});

// ------------------------------------------------ T4: CLI end to end for the scope.mandate vector

type Run = { status: number | null; stdout: string; stderr: string };

async function runCli(file: string, server: Server): Promise<Run> {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env };
  delete env.VETO_RPC;
  delete env.VETO_PROGRAM_ID;
  return new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "verify.ts", file, "--rpc", url], {
      cwd: TOOLS_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("T4 RED-ON-HEAD: the CLI prints VERDICT: REJECTED and exits 1 for a bundle whose scope.mandate carries the phrase", async () => {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 2469n);
  const row: Row = { kind: "paid", amount: 999, nonce: 7, timestamp: T, signature: "sig-t4" };
  const bundle = ruleBundle(`${mandate.toBase58()} ${PHRASE}`, [recordOf(mandate.toBase58(), row)]);
  const dir = mkdtempSync(join(tmpdir(), "veto-critic-sec-r2-pr145-"));
  const file = join(dir, "bundle.json");
  writeFileSync(file, bundleToJson(bundle));
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      res.setHeader("content-type", "application/json");
      const result = method === "getGenesisHash" ? DEVNET_GENESIS : null;
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const run = await runCli(file, server);
    assert.ok(hits > 0, "the CLI never reached the fake RPC");
    assert.doesNotMatch(run.stdout, /CONFIRMED/);
    assert.doesNotMatch(run.stderr, /was not checked/);
    assert.match(run.stdout, /VERDICT: REJECTED/, `status ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.equal(run.status, 1, `status ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  } finally {
    server.close();
  }
});

// ------------------------------------------------ T5: a not-checked row at any stage never prints CONFIRMED
//
// Row 1 is honest and would confirm alone. Row 2 (or the stage named) fails
// with the typed error the fetch layer raises. The bundle must never print
// CONFIRMED or a confirmed count, and the honest row must not leak as a verdict.

const STAGE_ERRORS = [
  { name: "TransportError 502", make: () => new TransportError("502 Bad Gateway: <html>", 502) },
  { name: "RateLimitedError", make: () => new RateLimitedError("rpc rate limited on http://127.0.0.1:1") },
] as const;

for (const stage of STAGE_ERRORS) {
  test(`T5 ${stage.name} on getTransaction for row 2 of 2: code 3, no CONFIRMED, honest row 1 not reported`, async () => {
    const rows: Row[] = [
      { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-honest" },
      { kind: "paid", amount: 20, nonce: 2, timestamp: T + 1, signature: "sig-unread" },
    ];
    const { conn, mandate } = chain({
      mandateId: 2470n,
      rows,
      async getTransaction(signature, fallback) {
        if (signature === "sig-unread") throw stage.make();
        return fallback(signature);
      },
    });
    const result = await assessBundle(ruleBundle(mandate.toBase58(), rows.map((row) => recordOf(mandate.toBase58(), row))), RPC, conn, OPTS);
    neverConfirmed(result);
    notChecked(result, "sig-unread");
    assert.doesNotMatch(result.text, /sig-honest/);
  });

  test(`T5 ${stage.name} on the destination token account load: code 3, no CONFIRMED`, async () => {
    const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-dest" }];
    const { conn, mandate } = chain({
      mandateId: 2471n,
      rows,
      async getAccountInfo(address, fallback) {
        if (address.equals(DEST)) throw stage.make();
        return fallback(address);
      },
    });
    const result = await assessBundle(dateRangeBundle([recordOf(mandate.toBase58(), rows[0]!)], T - 1, T + 1), RPC, conn, OPTS);
    neverConfirmed(result);
    notChecked(result, "sig-dest");
  });

  test(`T5 ${stage.name} on the ledger account load: code 3, no CONFIRMED`, async () => {
    const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-ledger" }];
    const base = chain({ mandateId: 2472n, rows });
    const { conn } = chain({
      mandateId: 2472n,
      rows,
      async getAccountInfo(address, fallback) {
        if (address.equals(base.ledger)) throw stage.make();
        return fallback(address);
      },
    });
    const result = await assessBundle(dateRangeBundle([recordOf(base.mandate.toBase58(), rows[0]!)], T - 1, T + 1), RPC, conn, OPTS);
    neverConfirmed(result);
    notChecked(result, "sig-ledger");
  });

  test(`T5 ${stage.name} on the scope mandate load (rule population): the bundle rejects typed, no verdict`, async () => {
    const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-mandate" }];
    const base = chain({ mandateId: 2473n, rows });
    const { conn } = chain({
      mandateId: 2473n,
      rows,
      async getAccountInfo(address, fallback) {
        if (address.equals(base.mandate)) throw stage.make();
        return fallback(address);
      },
    });
    await assert.rejects(
      () => assessBundle(ruleBundle(base.mandate.toBase58(), [recordOf(base.mandate.toBase58(), rows[0]!)]), RPC, conn, OPTS),
      (err: unknown) => isTransportError(err),
    );
  });

  test(`T5 ${stage.name} on getGenesisHash: the bundle rejects typed, no verdict`, async () => {
    const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-genesis" }];
    const { conn, mandate } = chain({
      mandateId: 2474n,
      rows,
      async genesis() {
        throw stage.make();
      },
    });
    await assert.rejects(
      () => assessBundle(ruleBundle(mandate.toBase58(), [recordOf(mandate.toBase58(), rows[0]!)]), RPC, conn, OPTS),
      (err: unknown) => isTransportError(err),
    );
  });
}

test("T5 TransportError 502 on getSignaturesForAddress (date_range population): the bundle rejects typed through withRetry", async () => {
  const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-walk" }];
  const { conn, mandate } = chain({
    mandateId: 2475n,
    rows,
    async getSignaturesForAddress() {
      throw new TransportError("502 Bad Gateway: <html>", 502);
    },
  });
  await assert.rejects(
    () => assessBundle(dateRangeBundle([recordOf(mandate.toBase58(), rows[0]!)], T - 1, T + 1), RPC, conn, OPTS),
    (err: unknown) => isTransportError(err) && /502 Bad Gateway/.test(err instanceof Error ? err.message : ""),
  );
});

// ------------------------------------------------ T6: regression check named for this round

test("T6 regression: a forged row beside a not-checked row is never CONFIRMED and the forgery is not silently confirmed either", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-forged" },
    { kind: "paid", amount: 20, nonce: 2, timestamp: T + 1, signature: "sig-unread" },
  ];
  const { conn, mandate } = chain({
    mandateId: 2476n,
    rows,
    async getTransaction(signature, fallback) {
      if (signature === "sig-unread") throw new TransportError("503 Service Unavailable: ", 503);
      return fallback(signature);
    },
  });
  const forged = recordOf(mandate.toBase58(), rows[0]!, { amount: 999 });
  const result = await assessBundle(ruleBundle(mandate.toBase58(), [forged, recordOf(mandate.toBase58(), rows[1]!)]), RPC, conn, OPTS);
  neverConfirmed(result);
  assert.equal(result.code, 3);
});
