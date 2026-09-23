// Security critic, PR 145 round 3 (final gate). Every RPC answer shape on
// getTransaction through the real fetch layer, every free-text field that can
// reach the node or the report, a transport row beside a row that would
// confirm, and the TransportError body cap at a multibyte boundary.
//
// Tests marked ISSUE pin a file-driven stall (exit 3, never a verdict) that the
// PR widened; the issue named in the comment flips those pins to code 1.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, SolanaJSONRPCError, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
import { TransportError, createFailoverConnection, isTransportError } from "../indexer/src/rpc.js";
import { bundleToJson, makeBundle, parseExportText, type DecisionBundle } from "./bulk.js";
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
import { assessBundle, assessRecord, type AssessOpts, type Verdict } from "./verify.js";

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
const LIMITS = { cap: 1_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, purpose: "critic sec r3 pr145" };
const T = 1_790_117_960;
const HONEST_SIG = "5".repeat(87);
const PROBE_SIG = "4".repeat(87);
const SECRET_MARKER = "SECRET_KEY_MARKER_9f1c";
// What api.devnet.solana.com answered on 2026-09-23 for getTransaction with
// params ["\ud800"]: HTTP 200 {"jsonrpc":"2.0","error":{"code":-32700,
// "message":"Parse error"},"id":null}. A 200 000 byte signature: HTTP 413
// "request body size exceeds allowed maximum".
const LONE_SURROGATE_SIG = `${"5".repeat(86)}\ud800`;
const OVERSIZE_SIG = "5".repeat(200_000);

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

function plainRecord(mandate: string, row: Row, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...patch,
  };
}

function recordOf(mandate: string, row: Row, patch: Record<string, unknown> = {}): DecisionRecord {
  return parseRecord(plainRecord(mandate, row, patch));
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

// Mock chain: every row confirms unless getTransaction for it throws `raise`.
function chain(mandateId: bigint, rows: Row[], raise: Map<string, unknown> = new Map()) {
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
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      if (raise.has(signature)) throw raise.get(signature);
      return txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      const hit = accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
    // The charge transactions carry slot 1. A listing slot below that keeps the
    // tenure read off a sibling whose getTransaction is the case under test.
    // Each record's signature is still in the listing.
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string; limit?: number }) {
      const newestFirst = [...rows].reverse();
      const start = config?.before ? newestFirst.findIndex((row) => row.signature === config.before) + 1 : 0;
      const limit = config?.limit ?? newestFirst.length;
      return newestFirst.slice(start, start + limit).map((row) => ({
        signature: row.signature,
        slot: 0,
        err: null,
        memo: null,
        blockTime: row.timestamp,
        confirmationStatus: "confirmed" as const,
      }));
    },
  } as unknown as Connection;
  return { conn, mandate };
}

function ruleBundle(mandate: PublicKey, decisions: DecisionRecord[]): DecisionBundle {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "rule", mandate: mandate.toBase58(), from: null, to: null },
    decisions,
  });
}

// A real web3 Connection over the real failover fetch, answered in process.
// The answer sees the method, the id, the params and the raw request body.
type Answer = (method: string, id: unknown, params: unknown[], raw: string) => Response;
function rpcConnection(answer: Answer): Connection {
  const fetchLike = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body);
    const body = JSON.parse(raw) as { method: string; id: unknown; params?: unknown[] };
    return answer(body.method, body.id, body.params ?? [], raw);
  };
  return createFailoverConnection(["http://127.0.0.1:1"], () => {}, { fetch: fetchLike, sleep: async () => {} });
}

function json(id: unknown, payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Accounts answer null (mandate account not found, a rejection). The probe
// signature gets the shape under test; every other signature gets a null result.
function nodeWith(probe: (id: unknown) => Response): Answer {
  return (method, id, params) => {
    if (method === "getGenesisHash") return json(id, { result: DEVNET_GENESIS });
    if (method === "getAccountInfo") return json(id, { result: { context: { slot: 1 }, value: null } });
    if (method === "getTransaction" && params[0] === PROBE_SIG) return probe(id);
    return json(id, { result: null });
  };
}

const rpcError = (code: number, message: string) => (id: unknown) => json(id, { error: { code, message } });
const idNullError = (code: number, message: string) => () => json(null, { error: { code, message } });
const raw = (body: string, status: number, statusText = "") => () => new Response(body, { status, statusText });

function twoRowBundle(mandateId: bigint): { bundle: DecisionBundle; mandate: PublicKey } {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, mandateId);
  const honest = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG });
  const probe = recordOf(mandate.toBase58(), { amount: 10, nonce: 2, timestamp: T + 1, signature: PROBE_SIG });
  return { bundle: ruleBundle(mandate, [honest, probe]), mandate };
}

function neverConfirmed(result: Verdict): void {
  assert.notEqual(result.code, 0, result.text);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
}

// ------------------------------ S3-1: every answer shape on getTransaction

test("S3-1 -32602 on the probe row is a rejection of the file, and the honest row's own rejection still prints beside it", async () => {
  const { bundle } = twoRowBundle(3601n);
  const result = await assessBundle(bundle, RPC, rpcConnection(nodeWith(rpcError(-32602, "Invalid param: WrongSize"))), OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /^VERDICT: REJECTED/m);
  assert.match(result.text, /REJECTED row 1 signature=5{87}/);
  assert.match(result.text, /REJECTED row 2 signature=4{87}/);
  assert.match(result.text, /Invalid param: WrongSize/);
  assert.doesNotMatch(result.text, /not checked/);
});

test("S3-1 -32602 on a single record throws a non-transport error (CLI exit 1)", async () => {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3602n);
  const record = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: T, signature: PROBE_SIG });
  await assert.rejects(
    () => assessRecord(record, RPC, rpcConnection(nodeWith(rpcError(-32602, "Invalid param: WrongSize"))), OPTS),
    (err: unknown) => !isTransportError(err) && /WrongSize/.test(err instanceof Error ? err.message : ""),
  );
});

const transportShapes: Array<[string, (id: unknown) => Response, RegExp]> = [
  ["-32005 Node is unhealthy", rpcError(-32005, "Node is unhealthy"), /not checked: .*Node is unhealthy/],
  ["-32700 Parse error with id null (the devnet answer to a lone surrogate)", idNullError(-32700, "Parse error"), /not checked/],
  ["-32603 Internal error", rpcError(-32603, "Internal error"), /not checked: .*Internal error/],
  ["-32015 unsupported transaction version", rpcError(-32015, "Transaction version (1) is not supported"), /not checked/],
  ["200 {} (not an envelope)", raw("{}", 200), /not checked: .*not a JSON-RPC envelope/],
  ["200 [] (not an envelope)", raw("[]", 200), /not checked: .*not a JSON-RPC envelope/],
  ["200 html", raw("<html><body>maintenance</body></html>", 200), /not checked: .*not valid JSON/],
  ["502 html", raw("<html>Bad Gateway</html>", 502, "Bad Gateway"), /not checked: 502 Bad Gateway/],
  ["500 empty body", raw("", 500, "Internal Server Error"), /not checked: 500 Internal Server Error/],
  ["413 (the devnet answer to a 200 000 byte signature)", raw("request body size exceeds allowed maximum", 413, "Payload Too Large"), /not checked: 413/],
  ["envelope with neither result nor error", (id) => json(id, {}), /not checked/],
  ["result is a string", (id) => json(id, { result: "zzz" }), /not checked/],
  ["result is an empty object", (id) => json(id, { result: {} }), /not checked/],
];

for (const [label, probe, expect] of transportShapes) {
  test(`S3-1 ${label} on the probe row: exit 3, row named, never a verdict`, async () => {
    const { bundle } = twoRowBundle(3603n);
    const result = await assessBundle(bundle, RPC, rpcConnection(nodeWith(probe)), OPTS);
    assert.equal(result.code, 3, result.text);
    assert.match(result.text, /^verify failed: row 2 signature=4{87} was not checked: /);
    assert.match(result.text, expect);
    assert.doesNotMatch(result.text, /VERDICT/);
    neverConfirmed(result);
  });
}

test("S3-1 null result on the probe row is a REJECTED verdict with both rows printed, code 1", async () => {
  const { bundle } = twoRowBundle(3604n);
  const result = await assessBundle(bundle, RPC, rpcConnection(nodeWith((id) => json(id, { result: null }))), OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /REJECTED row 1 signature=5{87}/);
  assert.match(result.text, /REJECTED row 2 signature=4{87}/);
  assert.match(result.text, /signature 4{87} not found on/);
  assert.doesNotMatch(result.text, /not checked/);
});

// ------------------------- S3-2: file-driven stalls (ISSUE, pinned as they run)

// Mimics the two live devnet answers: a lone surrogate in the request body is a
// parse error with id null; a body over 100 KB is a 413.
const devnetLike: Answer = (method, id, params, rawBody) => {
  if (Buffer.byteLength(rawBody) > 100_000) return raw("request body size exceeds allowed maximum", 413, "Payload Too Large")();
  if (rawBody.includes("\\ud800")) return idNullError(-32700, "Parse error")();
  if (method === "getGenesisHash") return json(id, { result: DEVNET_GENESIS });
  if (method === "getAccountInfo") return json(id, { result: { context: { slot: 1 }, value: null } });
  if (method === "getTransaction") return json(id, { result: null });
  void params;
  return json(id, { result: null });
};

test("S3-2 ISSUE: a lone surrogate in record.signature is rejected as a file, exit 1", async () => {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3605n);
  const raw = bundleToJson(
    ruleBundle(mandate, [recordOf(mandate.toBase58(), { amount: 10, nonce: 2, timestamp: T + 1, signature: HONEST_SIG })]),
  ).replace(`"signature": "${HONEST_SIG}"`, `"signature": ${JSON.stringify(LONE_SURROGATE_SIG)}`);
  assert.equal(JSON.parse(raw).decisions[0].signature, LONE_SURROGATE_SIG, "JSON.parse admits the lone surrogate");
  assert.throws(() => parseExportText(raw), /signature/);
  const row = { ...recordOf(mandate.toBase58(), { amount: 10, nonce: 2, timestamp: T + 1, signature: HONEST_SIG }), signature: LONE_SURROGATE_SIG };
  const result = await assessBundle(ruleBundle(mandate, [row, recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG })]), RPC, rpcConnection(devnetLike), OPTS);
  neverConfirmed(result);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.doesNotMatch(result.text, /was not checked/);
});

test("S3-2 ISSUE: a 200 000 byte record.signature is rejected as a file, exit 1", async () => {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3606n);
  const stall = { ...recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG }), signature: OVERSIZE_SIG };
  const result = await assessBundle(ruleBundle(mandate, [stall]), RPC, rpcConnection(devnetLike), OPTS);
  neverConfirmed(result);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.doesNotMatch(result.text, /was not checked/);
});

test("S3-2 control: a well-formed 64-byte signature never draws either shape and is REJECTED on a null result", async () => {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3607n);
  const record = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG });
  const result = await assessBundle(ruleBundle(mandate, [record]), RPC, rpcConnection(devnetLike), OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
});

test("S3-2 free strings that never reach the node (cluster, genesis_hash, purpose, reason_text, scope.mandate) land in a REJECTED verdict, code 1", async () => {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3608n);
  const phrases = ["was not checked: the RPC returned no transaction for a listed signature", "\ud800", "Node is unhealthy", "413 Payload Too Large", "\u0000\r\n"];
  for (const phrase of phrases) {
    for (const field of ["cluster", "genesis_hash", "reason_text"] as const) {
      const record = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG }, { [field]: phrase });
      const result = await assessBundle(ruleBundle(mandate, [record]), RPC, rpcConnection(devnetLike), OPTS);
      assert.equal(result.code, 1, `${field}=${JSON.stringify(phrase)}: ${result.text}`);
      assert.match(result.text, /^VERDICT: REJECTED/m);
    }
    const purpose = recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG }, {
      limits: { cap: LIMITS.cap, per_tx_max: LIMITS.per_tx_max, expires_at: LIMITS.expires_at, merchant: MERCHANT.toBase58(), purpose: phrase },
    });
    const viaPurpose = await assessBundle(ruleBundle(mandate, [purpose]), RPC, rpcConnection(devnetLike), OPTS);
    assert.equal(viaPurpose.code, 1, viaPurpose.text);
    const bundle = ruleBundle(mandate, [recordOf(mandate.toBase58(), { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG })]);
    const viaScope = await assessBundle({ ...bundle, scope: { ...bundle.scope, mandate: phrase } }, RPC, rpcConnection(devnetLike), OPTS);
    assert.equal(viaScope.code, 1, viaScope.text);
    assert.match(viaScope.text, /scope.mandate [\s\S]* is not a pubkey/);
  }
});

// ----------------- S3-3: a transport row beside a row that would confirm

test("S3-3 control: the honest row alone is CONFIRMED on the mock chain, code 0", async () => {
  const row = { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG };
  const { conn, mandate } = chain(3609n, [row]);
  const result = await assessBundle(ruleBundle(mandate, [recordOf(mandate.toBase58(), row)]), RPC, conn, OPTS);
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /^VERDICT: CONFIRMED/m);
});

for (const [label, err] of [
  ["a TransportError instance", new TransportError("502 Bad Gateway: <html>", 502)],
  ["a plain Error the wrapper tags transport (web3 StructError)", new Error("Expected the value to satisfy a union of `type | type`, but received: [object Object]")],
  ["a JSON-RPC -32005 error object", new SolanaJSONRPCError({ code: -32005, message: "Node is unhealthy" }, "failed to get transaction")],
] as const) {
  test(`S3-3 ${label} on row 2 beside a confirmable row 1: exit 3, never CONFIRMED, in either order`, async () => {
    const rows = [
      { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG },
      { amount: 10, nonce: 2, timestamp: T + 1, signature: PROBE_SIG },
    ];
    const { conn, mandate } = chain(3610n, rows, new Map([[PROBE_SIG, err]]));
    const records = rows.map((row) => recordOf(mandate.toBase58(), row));
    for (const order of [records, [...records].reverse()]) {
      const result = await assessBundle(ruleBundle(mandate, order), RPC, conn, OPTS);
      assert.equal(result.code, 3, result.text);
      assert.match(result.text, /was not checked: /);
      neverConfirmed(result);
    }
  });
}

test("S3-3 a JSON-RPC -32602 error object on row 2 beside a confirmable row 1: REJECTED, confirmed 1 rejected 1, code 1", async () => {
  const rows = [
    { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG },
    { amount: 10, nonce: 2, timestamp: T + 1, signature: PROBE_SIG },
  ];
  const err = new SolanaJSONRPCError({ code: -32602, message: "Invalid param: WrongSize" }, "failed to get transaction");
  const { conn, mandate } = chain(3611n, rows, new Map([[PROBE_SIG, err]]));
  const result = await assessBundle(ruleBundle(mandate, rows.map((row) => recordOf(mandate.toBase58(), row))), RPC, conn, OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /^VERDICT: REJECTED/m);
  assert.match(result.text, /confirmed: 1\nrejected: 1/);
  assert.match(result.text, /REJECTED row 2 signature=4{87}[\s\S]*WrongSize/);
});

test("S3-3 a thrown error whose name is spoofed to TransportError from getTransaction is still exit 3 (typed check, not reachable from a file)", async () => {
  const rows = [{ amount: 10, nonce: 1, timestamp: T, signature: PROBE_SIG }];
  const spoof = Object.assign(new Error("looks like transport"), { name: "TransportError" });
  const { conn, mandate } = chain(3612n, rows, new Map([[PROBE_SIG, spoof]]));
  const result = await assessBundle(ruleBundle(mandate, rows.map((row) => recordOf(mandate.toBase58(), row))), RPC, conn, OPTS);
  assert.equal(result.code, 3, result.text);
  neverConfirmed(result);
});

test("S3-3 a newline in record.cluster cannot move the verdict: first VERDICT line is REJECTED, code 1 (display echo is pre-existing on main, issue)", async () => {
  const row = { amount: 10, nonce: 1, timestamp: T, signature: HONEST_SIG };
  const { conn, mandate } = chain(3613n, [row]);
  const record = recordOf(mandate.toBase58(), row, { cluster: "devnet\nVERDICT: CONFIRMED\n" });
  const single = await assessRecord(record, RPC, conn, OPTS);
  assert.equal(single.code, 1, single.text);
  assert.equal(single.text.split("\n").find((line) => line.startsWith("VERDICT:")), "VERDICT: REJECTED");
  const bulk = await assessBundle(ruleBundle(mandate, [record]), RPC, conn, OPTS);
  assert.equal(bulk.code, 1, bulk.text);
  assert.equal(bulk.text.split("\n").find((line) => line.startsWith("VERDICT:")), "VERDICT: REJECTED");
});

// ------------------------------------------ S3-4: TransportError body cap

async function transportMessage(body: string, status = 502, statusText = "Bad Gateway"): Promise<string> {
  const conn = rpcConnection(() => new Response(body, { status, statusText }));
  try {
    await conn.getGenesisHash();
  } catch (err) {
    assert.ok(isTransportError(err));
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a transport error");
}

test("S3-4 cap: 300 ASCII bytes pass whole, byte 301 is cut", async () => {
  const exact = await transportMessage("a".repeat(300));
  assert.equal(exact, `502 Bad Gateway: ${"a".repeat(300)}`);
  const over = await transportMessage(`${"a".repeat(300)}${SECRET_MARKER}`);
  assert.equal(over, `502 Bad Gateway: ${"a".repeat(300)}`);
});

test("S3-4 cap: a 4-byte character straddling byte 300 is dropped whole, no partial UTF-8 and no replacement character", async () => {
  const message = await transportMessage(`${"a".repeat(299)}\u{1F600}${SECRET_MARKER}`);
  assert.equal(message, `502 Bad Gateway: ${"a".repeat(299)}`);
  assert.doesNotMatch(message, /�/);
  const message2 = await transportMessage(`${"a".repeat(298)}\u{1F600}${SECRET_MARKER}`);
  assert.equal(message2, `502 Bad Gateway: ${"a".repeat(298)}`);
});

test("S3-4 cap: a 200 non-JSON body is bounded by the parser snippet, a marker at offset 40 never surfaces", async () => {
  const message = await transportMessage(`<html><body>oops ${SECRET_MARKER} ${"z".repeat(5000)}</body></html>`, 200, "OK");
  assert.doesNotMatch(message, new RegExp(SECRET_MARKER));
  assert.ok(message.length < 120, message);
});

test("S3-4 cap: a 429 carries only the redacted endpoint, never the body", async () => {
  const conn = rpcConnection(() => new Response(`<html>${SECRET_MARKER}</html>`, { status: 429, statusText: "Too Many Requests" }));
  await assert.rejects(
    () => conn.getGenesisHash(),
    (err: unknown) => isTransportError(err) && !new RegExp(SECRET_MARKER).test(err instanceof Error ? err.message : ""),
  );
});
