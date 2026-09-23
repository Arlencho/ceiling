// Security critic, PR 145 round 1. Transport shapes on the not-checked path
// (issue 130) and the rpc url redaction (issue 124).
//
// Tests marked RED-ON-HEAD fail on the PR head e8742eb. Tests marked
// OUT-OF-SCOPE document a pre-existing defect outside the fix diff; they are
// red on head and on main and do not move the verdict.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog, encodeRefusedLog } from "../indexer/src/events.js";
import { redactRpcUrl } from "../indexer/src/rpc.js";
import { makeBundle } from "./bulk.js";
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
  recordToJson,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assertSecondMintAllowed } from "./second-mint.js";
import { assessBundle, type AssessOpts, type Verdict } from "./verify.js";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
// A valid key whose base58 text carries "timeout" (backend round 1). Here it
// is the charge destination, which the signer of the transaction chooses.
const TIMEOUT_DEST = new PublicKey("8ZtimeoutjoMuCTtfTGWTFnezvS2zLUWdgHwCUzLJg7x");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const LIMITS = { cap: 1_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, purpose: "critic sec r1 pr145" };

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

function encodeLedger(mandate: PublicKey, rows: Row[], dest: PublicKey = DEST): Buffer {
  const data = Buffer.alloc(48 + LEDGER_CAPACITY * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  mandate.toBuffer().copy(data, 8);
  data.writeUInt32LE(rows.length, 40);
  data.writeUInt16LE(rows.length % LEDGER_CAPACITY, 44);
  rows.forEach((row, seq) => {
    const off = 48 + (seq % LEDGER_CAPACITY) * 72;
    data.writeBigInt64LE(BigInt(row.timestamp), off);
    data.writeBigUInt64LE(BigInt(row.amount), off + 8);
    dest.toBuffer().copy(data, off + 16);
    data.writeBigUInt64LE(BigInt(row.nonce), off + 48);
    data.writeBigUInt64LE(BigInt(row.kind === "refused" ? row.amount : 0), off + 56);
    data[off + 64] = row.kind === "paid" ? KIND_PAID : KIND_REFUSED;
    data[off + 65] = reasonOf(row);
  });
  return data;
}

function recordOf(mandate: string, row: Row, claim: { amount?: number; counterparty?: string } = {}): DecisionRecord {
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
    amount: claim.amount ?? row.amount,
    counterparty: claim.counterparty ?? DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: reason,
    reason_text: reasonText(reason),
    suggested_override: refused ? row.amount : 0,
    signature: row.signature,
  });
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, row: Row, dest: PublicKey = DEST): unknown {
  const decision =
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
  const logs = [
    `Program ${REAL_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    ...decision,
    `Program ${REAL_PROGRAM.toBase58()} success`,
  ];
  return {
    slot: 1,
    blockTime: row.timestamp,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, dest, ledger, mandate, SOURCE, MINT, REAL_PROGRAM, TOKEN_PROGRAM_ID],
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

function chain(args: {
  mandateId: bigint;
  rows: Row[];
  dest?: PublicKey;
  listed?: Row[];
  getTransaction?: (signature: string, fallback: (signature: string) => Promise<unknown>) => Promise<unknown>;
}): Chain {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, args.mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const dest = args.dest ?? DEST;
  const paid = args.rows.filter((row) => row.kind === "paid");
  const refused = args.rows.filter((row) => row.kind === "refused");
  const spent = paid.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: token, owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(args.mandateId, paid.length, refused.length, spent), owner: REAL_PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, args.rows, dest), owner: REAL_PROGRAM }],
  ]);
  const txs = new Map(args.rows.map((row) => [row.signature, chargeTx(mandate, ledger, row, dest)]));
  const fallback = async (signature: string) => txs.get(signature) ?? null;
  const newestFirst = [...(args.listed ?? args.rows)].reverse();
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    getTransaction: args.getTransaction
      ? (signature: string) => args.getTransaction!(signature, fallback)
      : fallback,
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

function dateRangeBundle(mandate: string | null, decisions: DecisionRecord[], from: number | null, to: number | null) {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "date_range", mandate, from, to },
    decisions,
  });
}

function neverConfirmed(result: Verdict): void {
  assert.notEqual(result.code, 0);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.text, /CONFIRMED/);
}

function notChecked(result: Verdict, signature: string): void {
  assert.equal(result.code, 3, result.text);
  assert.match(result.text, new RegExp(`signature=${signature} was not checked`));
  assert.doesNotMatch(result.text, /VERDICT/);
}

const T = 1_790_117_952;

// ------------------------------------------------ S1: web3 error shapes, bundle path
//
// web3 turns every non-2xx answer into Error(`${status} ${statusText}: ${body}`)
// (node_modules/@solana/web3.js/lib/index.cjs.js:5270) and an unparseable
// body into the JSON.parse error from jayson (lib/client/browser/index.js:134).
// The failover fetch in indexer/src/rpc.ts only intercepts 429.

const WEB3_SHAPES = [
  { name: "502 from a gateway", message: "502 Bad Gateway: <html><body>502 Bad Gateway</body></html>", expect: 3 },
  { name: "500 from the node", message: "500 Internal Server Error: ", expect: 3 },
  { name: "503 from the node", message: "503 Service Unavailable: ", expect: 3 },
  { name: "malformed JSON-RPC body", message: "Unexpected token '<', \"<html>\" is not valid JSON", expect: 3 },
  { name: "undici headers timeout", message: "Headers Timeout Error", expect: 3 },
] as const;

for (const shape of WEB3_SHAPES) {
  test(`S1 130: ${shape.name} on getTransaction never prints CONFIRMED, and is not a verdict`, async () => {
    const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-s1" }];
    const { conn, mandate } = chain({
      mandateId: 1450n,
      rows,
      async getTransaction() {
        throw new Error(shape.message);
      },
    });
    const result = await assessBundle(ruleBundle(mandate, [recordOf(mandate.toBase58(), rows[0]!)]), RPC, conn, OPTS);
    neverConfirmed(result);
    // RED-ON-HEAD for 502, 500 and the malformed body: they land as a
    // REJECTED row with code 1, which is the shape issue 130 set out to stop.
    notChecked(result, "sig-s1");
  });
}

// ------------------------------------------------ S2: CLI end to end

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

function singleFile(tag: string): string {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 1451n);
  const dir = mkdtempSync(join(tmpdir(), `veto-critic-sec-r1-pr145-${tag}-`));
  const file = join(dir, "record.json");
  writeFileSync(
    file,
    recordToJson(recordOf(mandate.toBase58(), { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-cli" })),
  );
  return file;
}

const CLI_SHAPES = [
  {
    name: "502 for every request",
    answer: (res: import("node:http").ServerResponse) => {
      res.statusCode = 502;
      res.end("<html>502 Bad Gateway</html>");
    },
  },
  {
    name: "200 with a non-JSON body",
    answer: (res: import("node:http").ServerResponse) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html");
      res.end("<html>maintenance</html>");
    },
  },
] as const;

for (const shape of CLI_SHAPES) {
  test(`S2 130 RED-ON-HEAD: the CLI exits 3 and prints no verdict when the RPC answers ${shape.name}`, async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      shape.answer(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const run = await runCli(singleFile(shape.name.replace(/\W+/g, "-")), server);
      assert.ok(hits > 0, "the CLI never reached the fake RPC");
      assert.doesNotMatch(run.stdout, /CONFIRMED/);
      assert.doesNotMatch(run.stdout, /VERDICT/);
      assert.equal(run.status, 3, `status ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    } finally {
      server.close();
    }
  });
}

// ------------------------------------------------ S3: chain-controlled text steers the classifier
//
// lib.ts:943 throws `token account not found: <destination>`; the destination
// is an account the transaction signer chose. Base58 admits "timeout".

test("S3 130 RED-ON-HEAD: a charge whose destination pubkey spells timeout turns a REJECTED row into not checked", async () => {
  const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-s3" }];
  const { conn, mandate } = chain({ mandateId: 1452n, rows, dest: TIMEOUT_DEST });
  // The file claims the honest merchant destination; the chain names TIMEOUT_DEST,
  // which owns no token account. That is a forgery and must be REJECTED.
  const result = await assessBundle(ruleBundle(mandate, [recordOf(mandate.toBase58(), rows[0]!)]), RPC, conn, OPTS);
  neverConfirmed(result);
  assert.notEqual(result.code, 3, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  // The throw at lib.ts:943 discards the counterparty mismatch already collected; either line is a rejection.
  assert.match(result.text, /token account not found: 8Ztimeout|counterparty \(destination\)/);
});

// ------------------------------------------------ S4: a partial forgery next to a transport error

for (const forgedFirst of [true, false]) {
  test(`S4 130: a forged row ${forgedFirst ? "before" : "after"} a throttled row never prints CONFIRMED`, async () => {
    const rows: Row[] = [
      { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-a" },
      { kind: "paid", amount: 20, nonce: 2, timestamp: T + 1, signature: "sig-b" },
    ];
    const throttled = forgedFirst ? "sig-b" : "sig-a";
    const { conn, mandate } = chain({
      mandateId: 1453n,
      rows,
      async getTransaction(signature, fallback) {
        if (signature === throttled) throw new Error("rpc rate limited on https://api.devnet.solana.com");
        return fallback(signature);
      },
    });
    const forged = recordOf(mandate.toBase58(), forgedFirst ? rows[0]! : rows[1]!, { amount: 999 });
    const honest = recordOf(mandate.toBase58(), forgedFirst ? rows[1]! : rows[0]!);
    const decisions = forgedFirst ? [forged, honest] : [honest, forged];
    const result = await assessBundle(ruleBundle(mandate, decisions), RPC, conn, OPTS);
    neverConfirmed(result);
    assert.equal(result.code, 3);
    assert.doesNotMatch(result.text, /confirmed: /);
  });
}

// ------------------------------------------------ S5: the population walk drops a null transaction
//
// indexer/src/history.ts:162 `if (!tx) continue;` and tools/verify.ts:540
// `if (!tx) continue;` (both on main). An RPC that lists a signature and
// answers null for it removes the payment from the date_range population.

test("S5 OUT-OF-SCOPE: an RPC that answers null for a listed payment lets a date_range file that omits it confirm", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-kept" },
    { kind: "paid", amount: 20, nonce: 2, timestamp: T + 1, signature: "sig-dropped" },
  ];
  const { conn, mandate } = chain({
    mandateId: 1454n,
    rows,
    async getTransaction(signature, fallback) {
      if (signature === "sig-dropped") return null;
      return fallback(signature);
    },
  });
  // No mandate in scope: the ring cannot catch the omission (issue 135 shape).
  const bundle = dateRangeBundle(null, [recordOf(mandate.toBase58(), rows[0]!)], T - 10, T + 10);
  const result = await assessBundle(bundle, RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.doesNotMatch(result.text, /CONFIRMED/);
  assert.match(result.text, /sig-dropped/);
});

test("S5 control: the same RPC throwing a transport error for that signature is not a verdict", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-kept" },
    { kind: "paid", amount: 20, nonce: 2, timestamp: T + 1, signature: "sig-dropped" },
  ];
  const { conn, mandate } = chain({
    mandateId: 1455n,
    rows,
    async getTransaction(signature, fallback) {
      if (signature === "sig-dropped") throw new Error("rpc rate limited on https://api.devnet.solana.com");
      return fallback(signature);
    },
  });
  const bundle = dateRangeBundle(null, [recordOf(mandate.toBase58(), rows[0]!)], T - 10, T + 10);
  await assert.rejects(assessBundle(bundle, RPC, conn, OPTS), /rate limited/);
});

test("S5 control: the same RPC answering the real transaction names the omission", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-kept" },
    { kind: "paid", amount: 20, nonce: 2, timestamp: T + 1, signature: "sig-dropped" },
  ];
  const { conn, mandate } = chain({ mandateId: 1456n, rows });
  const bundle = dateRangeBundle(null, [recordOf(mandate.toBase58(), rows[0]!)], T - 10, T + 10);
  const result = await assessBundle(bundle, RPC, conn, OPTS);
  assert.equal(result.ok, false);
  assert.match(result.text, /signature sig-dropped is in the indexed date_range and missing from the file/);
});

test("S5 regression: a null answer on the per-row check is still REJECTED, never not checked", async () => {
  const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: T, signature: "sig-null" }];
  const { conn, mandate } = chain({
    mandateId: 1457n,
    rows,
    async getTransaction() {
      return null;
    },
  });
  const result = await assessBundle(ruleBundle(mandate, [recordOf(mandate.toBase58(), rows[0]!)]), RPC, conn, OPTS);
  assert.equal(result.ok, false);
  assert.notEqual(result.code, 3);
  assert.match(result.text, /signature sig-null not found on https:\/\/api\.devnet\.solana\.com/);
});

// ------------------------------------------------ S6: issue 124 redaction

const KEY = "SECRET-KEY-9f8e7d";

test("S6 124: userinfo, port, path, query and fragment are all cut; scheme and host:port remain", () => {
  const raw = `https://user:${KEY}@Mainnet.Example.Test:8443/v1/${KEY}/rpc?api-key=${KEY}&x=${KEY}#${KEY}`;
  assert.equal(redactRpcUrl(raw), "https://mainnet.example.test:8443");
  assert.throws(
    () => assertSecondMintAllowed({ genesis: DEVNET_GENESIS, rpcUrls: [raw] } as unknown as Parameters<typeof assertSecondMintAllowed>[0]),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message, "second-mint: refusing mainnet rpc https://mainnet.example.test:8443");
      assert.doesNotMatch(message, new RegExp(KEY));
      return true;
    },
  );
});

test("S6 124: a key encoded into the path with percent escapes is cut too", () => {
  const raw = `https://mainnet.example.test/${encodeURIComponent("key with spaces/and+plus")}?k=${encodeURIComponent(KEY)}`;
  assert.equal(redactRpcUrl(raw), "https://mainnet.example.test");
});

test("S6 124 INFO: a key that is the hostname itself survives redaction (no known provider does this)", () => {
  const raw = `https://${KEY.toLowerCase()}.mainnet.example.test/`;
  assert.equal(redactRpcUrl(raw), `https://${KEY.toLowerCase()}.mainnet.example.test`);
});
