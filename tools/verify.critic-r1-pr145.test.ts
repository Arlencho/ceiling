// Backend critic, PR 145 round 1. Fixtures for issues 124, 130, 131, 133.
// Each test names the code path it drives. Tests marked RED-ON-HEAD fail on
// the PR head; the rest fail on main and pass on the head (failing-first).
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog, encodeRefusedLog } from "../indexer/src/events.js";
import { RateLimitedError, isRateLimitError, isRetryable } from "../indexer/src/rpc.js";
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
  recordToJson,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assertSecondMintAllowed } from "./second-mint.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
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
const LIMITS = { cap: 1_000_000, per_tx_max: 500_000, expires_at: 1_797_713_870, purpose: "critic r1 pr145" };
// A valid 32-byte key whose base58 text carries the word "timeout". Found by
// sampling; any file can name it as a mandate.
const TIMEOUT_PUBKEY = "8ZtimeoutjoMuCTtfTGWTFnezvS2zLUWdgHwCUzLJg7x";

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

function chain(args: {
  mandateId: bigint;
  rows: Row[];
  blockTime?: (row: Row) => number | null;
  getTransaction?: (signature: string) => Promise<unknown>;
  getAccountInfo?: (address: PublicKey) => Promise<unknown>;
}): Chain {
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
    getTransaction: args.getTransaction ?? (async (signature: string) => txs.get(signature) ?? null),
    getAccountInfo:
      args.getAccountInfo ??
      (async (address: PublicKey) => {
        const hit = accounts.get(address.toBase58());
        if (!hit) return null;
        return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
      }),
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

// ---------------------------------------------------------------- issue 124

const KEYED_MAINNET = [
  { raw: "https://mainnet.example.test/v2/KEYINPATH", key: "KEYINPATH", shown: "https://mainnet.example.test" },
  { raw: "https://mainnet.example.test/?api-key=KEYINQUERY", key: "KEYINQUERY", shown: "https://mainnet.example.test" },
  { raw: "https://user:KEYINUSERINFO@mainnet.example.test:8899/", key: "KEYINUSERINFO", shown: "https://mainnet.example.test:8899" },
  { raw: "https://MAINNET.example.test/KEYUPPER#KEYFRAGMENT", key: "KEYUPPER", shown: "https://mainnet.example.test" },
] as const;

for (const item of KEYED_MAINNET) {
  test(`124: a keyed mainnet url (${item.key}) is refused and the key never reaches the message`, () => {
    let message = "";
    assert.throws(
      () => assertSecondMintAllowed({ ...guardOk(), rpcUrls: ["https://api.devnet.solana.com", item.raw] }),
      (err: unknown) => {
        message = err instanceof Error ? err.message : String(err);
        return true;
      },
    );
    assert.equal(message, `second-mint: refusing mainnet rpc ${item.shown}`);
    assert.doesNotMatch(message, new RegExp(item.key));
    assert.doesNotMatch(message, /KEYFRAGMENT/);
  });
}

function guardOk() {
  return {
    rpcUrls: ["https://api.devnet.solana.com"],
    genesis: DEVNET_GENESIS,
    firstMint: "First111111111111111111111111111111111111111",
    secondMint: "Second11111111111111111111111111111111111111",
    firstSource: "Src1111111111111111111111111111111111111111",
    secondSource: "Src2111111111111111111111111111111111111111",
    skrMint: "Skr11111111111111111111111111111111111111111",
  };
}

// ---------------------------------------------------------------- issue 130

test("130: a throttle on row 2 of a bundle yields no CONFIRMED and no REJECTED row, code 3, and names row 2", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "sig-1" },
    { kind: "paid", amount: 10, nonce: 2, timestamp: 1_790_117_946, signature: "sig-2" },
  ];
  const base = chain({ mandateId: 1450n, rows });
  const { conn, mandate } = chain({
    mandateId: 1450n,
    rows,
    async getTransaction(signature: string) {
      if (signature === "sig-2") throw new RateLimitedError("rpc rate limited on https://api.devnet.solana.com", [RPC]);
      return base.txs.get(signature) ?? null;
    },
  });
  const result = await assessBundle(ruleBundle(mandate, rows.map((row) => recordOf(mandate.toBase58(), row))), RPC, conn, OPTS);
  assert.equal(result.code, 3, result.text);
  assert.equal(result.ok, false);
  assert.match(result.text, /row 2 signature=sig-2 was not checked: rpc rate limited/);
  assert.doesNotMatch(result.text, /VERDICT/);
  assert.doesNotMatch(result.text, /CONFIRMED/i);
  assert.doesNotMatch(result.text, /REJECTED/);
  assert.doesNotMatch(result.text, /confirmed: 1/);
});

test("130: a throttle while loading the mandate account is also not a verdict", async () => {
  const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "sig-acct" }];
  const base = chain({ mandateId: 1451n, rows });
  const { conn, mandate } = chain({
    mandateId: 1451n,
    rows,
    async getAccountInfo(address: PublicKey) {
      if (address.equals(base.mandate)) throw new RateLimitedError("rpc rate limited on all endpoints", [RPC]);
      return base.conn.getAccountInfo(address);
    },
  });
  // The envelope check loads the mandate first and throws through to the CLI.
  await assert.rejects(
    () => assessBundle(ruleBundle(mandate, [recordOf(mandate.toBase58(), rows[0]!)]), RPC, conn, OPTS),
    (err: unknown) => isRateLimitError(err),
  );
});

test("130 RED-ON-HEAD: a forged mandate whose base58 text says timeout is REJECTED, not \"not checked\"", async () => {
  // verify.ts:671 classifies any error thrown inside checkRecord by message
  // regex (indexer rpc.ts RETRY_RE has a bare /timeout/). fetchMandate throws
  // "mandate account not found: <pubkey from the file>". A file can therefore
  // pick a mandate string that flips REJECTED (exit 1) into exit 3 and drops
  // the envelope failures that already named the forgery.
  const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "sig-forged" }];
  const { conn, mandate } = chain({ mandateId: 1452n, rows });
  const forged = recordOf(TIMEOUT_PUBKEY, rows[0]!);
  const result = await assessBundle(ruleBundle(mandate, [forged]), RPC, conn, OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.match(result.text, /mandate: row sig-forged has 8Ztimeout/);
  assert.doesNotMatch(result.text, /was not checked/);
});

test("130 RED-ON-HEAD: the single-record path does not classify that forged mandate as a transport error", async () => {
  const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "sig-forged-1" }];
  const { conn } = chain({ mandateId: 1453n, rows });
  const forged = recordOf(TIMEOUT_PUBKEY, rows[0]!);
  let thrown: unknown = null;
  try {
    const result = await assessRecord(forged, RPC, conn, OPTS);
    assert.equal(result.code, 1, result.text);
    return;
  } catch (err) {
    thrown = err;
  }
  // Same rule verify.ts:829 applies before choosing exit 3 over exit 1.
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  assert.match(message, /mandate account not found: 8Ztimeout/);
  assert.equal(isRateLimitError(thrown) || isRetryable(thrown), false, `classified as transport: ${message}`);
});

test("130: the CLI exits 3 with no verdict when every RPC answer is 429", async () => {
  const rows: Row[] = [{ kind: "paid", amount: 10, nonce: 1, timestamp: 1_790_117_945, signature: "sig-cli" }];
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 1454n);
  const dir = mkdtempSync(join(tmpdir(), "veto-critic-r1-pr145-"));
  const file = join(dir, "record.json");
  writeFileSync(file, recordToJson(recordOf(mandate.toBase58(), rows[0]!)));
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = 429;
    res.end("Too Many Requests");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const env = { ...process.env };
    delete env.VETO_RPC;
    delete env.VETO_PROGRAM_ID;
    // The fake RPC lives in this process, so the child must run while the
    // event loop is free: spawn, not spawnSync.
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
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
    assert.ok(hits > 0, "the CLI never reached the fake RPC");
    assert.equal(run.status, 3, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.doesNotMatch(run.stdout, /VERDICT/);
    assert.doesNotMatch(run.stdout, /CONFIRMED|REJECTED/);
    assert.match(run.stderr, /verify failed: .*rate limited/);
    assert.doesNotMatch(run.stderr, /VERDICT/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- issue 131

function dateRangeBundle(mandate: PublicKey, rows: Row[], from: number | null, to: number | null) {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "date_range", mandate: mandate.toBase58(), from, to },
    decisions: rows.map((row) => recordOf(mandate.toBase58(), row)),
  });
}

test("131: a genuine row one second past an inclusive `to` is rejected by name; the row at `to` is not", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 10, nonce: 1, timestamp: 100, signature: "in-100" },
    { kind: "paid", amount: 10, nonce: 2, timestamp: 150, signature: "in-150" },
    { kind: "paid", amount: 10, nonce: 3, timestamp: 151, signature: "out-151" },
  ];
  const { conn, mandate } = chain({ mandateId: 1310n, rows });
  const result = await assessBundle(dateRangeBundle(mandate, rows, 100, 150), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.equal(result.code, 1);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.match(result.text, /signature out-151 has timestamp 151 outside scope 100\.\.150/);
  assert.doesNotMatch(result.text, /signature in-150 has timestamp/);
  assert.doesNotMatch(result.text, /signature in-100 has timestamp/);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
});

test("131: a row before an open-ended `from` is rejected and the label says none for the missing bound", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 10, nonce: 1, timestamp: 99, signature: "out-99" },
    { kind: "paid", amount: 10, nonce: 2, timestamp: 100, signature: "in-100" },
  ];
  const { conn, mandate } = chain({ mandateId: 1311n, rows });
  const result = await assessBundle(dateRangeBundle(mandate, rows, 100, null), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.match(result.text, /signature out-99 has timestamp 99 outside scope 100\.\.none/);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
});

test("131: the same rows inside the range still confirm (control)", async () => {
  const rows: Row[] = [
    { kind: "paid", amount: 10, nonce: 1, timestamp: 100, signature: "in-100" },
    { kind: "paid", amount: 10, nonce: 2, timestamp: 150, signature: "in-150" },
  ];
  const { conn, mandate } = chain({ mandateId: 1312n, rows });
  const result = await assessBundle(dateRangeBundle(mandate, rows, 100, 150), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.equal(result.code, 0);
});

// ---------------------------------------------------------------- issue 133

const T = 1_790_117_952;

test("133: export and verify bind the same ring row (T+1) for two refused rows at T-2 and T+1 with blockTime T", async () => {
  const rows: Row[] = [
    { kind: "refused", amount: 80_000, nonce: 4, timestamp: T - 2, signature: "same-tx" },
    { kind: "refused", amount: 80_000, nonce: 4, timestamp: T + 1, signature: "same-tx" },
  ];
  const { conn, mandate } = chain({ mandateId: 1330n, rows, blockTime: () => T });
  const exported = await recordFromSignature(conn, "same-tx", REAL_PROGRAM, "devnet", DEVNET_GENESIS);
  assert.equal(exported.timestamp, BigInt(T + 1));
  const good = await assessRecord(exported, RPC, conn, OPTS);
  assert.equal(good.ok, true, good.text);
  // The old scorer's pick (the older row, T-2) is what verify now refuses.
  const stale = await assessRecord(recordOf(mandate.toBase58(), rows[0]!), RPC, conn, OPTS);
  assert.equal(stale.ok, false, stale.text);
  assert.match(stale.text, new RegExp(`timestamp \\(ledger\\): record has ${T - 2}, chain has ${T + 1}`));
});

test("133: export and verify both refuse a null block time with two rows on the nonce", async () => {
  const rows: Row[] = [
    { kind: "refused", amount: 80_000, nonce: 4, timestamp: T - 2, signature: "null-tx" },
    { kind: "refused", amount: 80_000, nonce: 4, timestamp: T + 1, signature: "null-tx" },
  ];
  const { conn, mandate } = chain({ mandateId: 1331n, rows, blockTime: () => null });
  const refusal = /matches 2 ledger rows for nonce 4 equally; refusing to bind to the newest/;
  await assert.rejects(
    () => recordFromSignature(conn, "null-tx", REAL_PROGRAM, "devnet", DEVNET_GENESIS),
    (err: unknown) => refusal.test(err instanceof Error ? err.message : String(err)),
  );
  for (const row of rows) {
    const verdict = await assessRecord(recordOf(mandate.toBase58(), row), RPC, conn, OPTS);
    assert.equal(verdict.ok, false, verdict.text);
    assert.match(verdict.text, refusal);
  }
});

test("133 RED-ON-HEAD: export pre-filters by log kind, verify binds by triple; a mixed-kind pair makes export emit a record verify rejects", async () => {
  // Same nonce and amount, one refused row at T-2 and one paid row at T+1,
  // transaction blockTime T with REFUSED logs. export.ts:108-114 narrows the
  // candidates to the refused row and binds T-2; verify.ts:291 keeps both,
  // picks the nearer paid row at T+1, and rejects the exported record.
  const rows: Row[] = [
    { kind: "refused", amount: 80_000, nonce: 4, timestamp: T - 2, signature: "mixed-tx", reason: 4 },
    { kind: "paid", amount: 80_000, nonce: 4, timestamp: T + 1, signature: "other-tx" },
  ];
  const { conn } = chain({ mandateId: 1332n, rows, blockTime: () => T });
  const exported = await recordFromSignature(conn, "mixed-tx", REAL_PROGRAM, "devnet", DEVNET_GENESIS);
  const verdict = await assessRecord(exported, RPC, conn, OPTS);
  assert.equal(verdict.ok, true, `export bound ts=${exported.timestamp} kind=${exported.kind}; verify said:\n${verdict.text}`);
});
