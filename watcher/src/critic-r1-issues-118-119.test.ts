// Critic round 1 fixtures for fix/watcher-nonce-and-replay (issues 118, 119).
//
// The three `once` cases drive index.ts against a fake RPC, because the fix
// for 119 lives in index.ts (ledger repair and the recordedCharge reader), not
// in processWindow. The two processWindow cases are the attacks named in the
// review brief: a clock that moves backwards across a cadence boundary, and a
// feed that answers with overlapping windows.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { dueSlots } from "./cadence.js";
import { ledgerPda, mandatePda } from "./chain.js";
import { windowContaining, type PriceFeed, type PriceWindow } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import { processWindow } from "./run.js";

const require = createRequire(import.meta.url);
type WsServer = {
  on(event: string, cb: (...args: never[]) => void): void;
  once(event: string, cb: (...args: never[]) => void): void;
  address(): { port: number } | string | null;
  close(cb?: () => void): void;
};
type WsSocket = {
  readyState: number;
  on(event: string, cb: (data: Buffer | string) => void): void;
  once(event: string, cb: () => void): void;
  send(data: string): void;
  close(code: number, reason: string): void;
};
const { Server: WsServer } = require("ws") as {
  Server: new (opts: { host: string; port: number }) => WsServer;
};

const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));
const WATCHER_DIR = join(SRC_DIR, "..");
const PROGRAM_ID = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const WINDOW_START = "2026-09-20T00:00:00+02:00";
const WINDOW_END = "2026-09-20T00:15:00+02:00";
const WINDOW_NONCE = 1789855200n;
const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A ledger account holding one refused row for `nonce`. */
function ledgerWithRefusal(nonce: bigint): Buffer {
  const body = Buffer.alloc(40 + 72);
  body.writeUInt32LE(1, 32);
  const row = body.subarray(40, 112);
  row.writeBigInt64LE(1_789_855_210n, 0);
  row.writeBigUInt64LE(446_000n, 8);
  row.writeBigUInt64LE(nonce, 48);
  row.writeBigUInt64LE(446_000n, 56);
  row[64] = 2;
  row[65] = 5;
  return Buffer.concat([LEDGER_DISCRIMINATOR, body]);
}

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params: unknown[] };
type LedgerAnswer = { kind: "bytes"; data: Buffer } | { kind: "throttle" } | { kind: "null" };

async function startFakeRpc(args: {
  owner: PublicKey;
  ledger: LedgerAnswer;
}): Promise<{ url: string; readonly sends: number; readonly ledgerReads: number; close: () => Promise<void> }> {
  const programId = new PublicKey(PROGRAM_ID);
  let sends = 0;
  let ledgerReads = 0;
  const mandate = mandatePda(programId, args.owner, 1n);
  const ledger = ledgerPda(programId, mandate);
  const accountOf = (data: Buffer) => ({
    executable: false,
    owner: PROGRAM_ID,
    lamports: 1_000_000,
    data: [data.toString("base64"), "base64"],
    rentEpoch: 0,
  });
  const ok = (id: number | string, result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
  const handle = (req: RpcRequest): { status: number; body: unknown } => {
    switch (req.method) {
      case "getLatestBlockhash":
      case "getRecentBlockhash":
        return ok(req.id, {
          context: { slot: 1 },
          value: { blockhash: base58(new Uint8Array(32).fill(9)), lastValidBlockHeight: 10_000 },
        });
      case "getBlockHeight":
        return ok(req.id, 1);
      case "getAccountInfo": {
        const asked = String(req.params[0] ?? "");
        if (asked === ledger.toBase58()) {
          ledgerReads += 1;
          if (args.ledger.kind === "throttle") return { status: 429, body: "Too Many Requests" };
          if (args.ledger.kind === "null") return ok(req.id, { context: { slot: 1 }, value: null });
          return ok(req.id, { context: { slot: 1 }, value: accountOf(args.ledger.data) });
        }
        return ok(req.id, { context: { slot: 1 }, value: accountOf(Buffer.alloc(232)) });
      }
      case "sendTransaction":
        sends += 1;
        return ok(req.id, base58(Uint8Array.from({ length: 64 }, (_, i) => i + 31)));
      case "getSignatureStatuses":
        return ok(req.id, { context: { slot: 1 }, value: [null] });
      case "getSignaturesForAddress":
        return ok(req.id, []);
      case "getTransaction":
        return ok(req.id, null);
      default:
        return {
          status: 200,
          body: { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unexpected rpc method ${req.method}` } },
        };
    }
  };
  const writeReply = (res: ServerResponse, status: number, body: unknown) => {
    if (status === 429) {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end("Too Many Requests");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let lastBindError = "unknown bind error";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const http = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk: Buffer | string) => {
        raw += String(chunk);
      });
      req.on("end", () => {
        const parsed = JSON.parse(raw) as RpcRequest | RpcRequest[];
        if (Array.isArray(parsed)) {
          const replies = parsed.map((r) => handle(r));
          if (replies.some((r) => r.status === 429)) {
            writeReply(res, 429, null);
            return;
          }
          writeReply(res, 200, replies.map((r) => r.body));
          return;
        }
        const reply = handle(parsed);
        writeReply(res, reply.status, reply.body);
      });
    });
    const url = await new Promise<string>((resolve) => {
      http.listen(0, "127.0.0.1", () => {
        const address = http.address();
        resolve(`http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`);
      });
    });
    let wss: WsServer;
    try {
      wss = new WsServer({ host: "127.0.0.1", port: Number(new URL(url).port) + 1 });
      if (wss.address() === null) {
        await new Promise<void>((resolve, reject) => {
          wss.once("listening", () => resolve());
          wss.once("error", ((err: unknown) => reject(err)) as (...a: never[]) => void);
        });
      }
    } catch (err) {
      await new Promise<void>((done) => http.close(() => done()));
      lastBindError = err instanceof Error ? err.message : String(err);
      continue;
    }
    const sockets = new Set<WsSocket>();
    wss.on("connection", ((socket: WsSocket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("message", (data: Buffer | string) => {
        let msg: { id?: number | string; method?: string };
        try {
          msg = JSON.parse(String(data)) as { id?: number | string; method?: string };
        } catch {
          return;
        }
        if (msg.id !== undefined) socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: 1 }));
        if (msg.method === "signatureSubscribe") {
          setTimeout(() => {
            if (socket.readyState !== 1) return;
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "signatureNotification",
                params: { subscription: 1, result: { context: { slot: 1 }, value: { err: null } } },
              }),
            );
          }, 200);
        }
      });
    }) as (socket: never) => void);
    return {
      url,
      get sends() {
        return sends;
      },
      get ledgerReads() {
        return ledgerReads;
      },
      close: async () => {
        const gone = [...sockets].map(
          (socket) =>
            new Promise<void>((done) => {
              const timer = setTimeout(done, 1_000);
              socket.once("close", () => {
                clearTimeout(timer);
                done();
              });
              socket.close(1000, "test done");
            }),
        );
        await Promise.all(gone);
        await new Promise<void>((done) => wss.close(() => done()));
        await new Promise<void>((done) => http.close(() => done()));
      },
    };
  }
  throw new Error(`could not bind http rpc and websocket on port+1: ${lastBindError}`);
}

type ChildRun = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function runOnce(args: { rpcUrl: string; owner: Keypair; agent: Keypair; timeoutMs: number }): Promise<ChildRun & { journal: JsonlJournal }> {
  const dir = mkdtempSync(join(tmpdir(), "veto-c118-once-"));
  writeFileSync(join(dir, "agent.json"), JSON.stringify(Array.from(args.agent.secretKey)));
  const journalPath = join(dir, "decisions.jsonl");
  const feedBody = JSON.stringify([
    { SEK_per_kWh: 0.00892, EUR_per_kWh: 0.0008, EXR: 11.1, time_start: WINDOW_START, time_end: WINDOW_END },
  ]);
  const preload = join(dir, "stub-feed.mjs");
  writeFileSync(
    preload,
    [
      `const FEED = "https://www.elprisetjustnu.se";`,
      `const body = ${JSON.stringify(feedBody)};`,
      `const real = globalThis.fetch;`,
      `globalThis.fetch = (input, init) => {`,
      `  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;`,
      `  if (url.startsWith(FEED)) return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));`,
      `  return real(input, init);`,
      `};`,
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VETO_RPC: args.rpcUrl,
    VETO_PROGRAM_ID: PROGRAM_ID,
    VETO_MINT: Keypair.generate().publicKey.toBase58(),
    VETO_OWNER: args.owner.publicKey.toBase58(),
    VETO_OWNER_TOKEN: Keypair.generate().publicKey.toBase58(),
    VETO_MERCHANT: Keypair.generate().publicKey.toBase58(),
    VETO_MERCHANT_TOKEN: Keypair.generate().publicKey.toBase58(),
    VETO_AGENT: args.agent.publicKey.toBase58(),
    VETO_KEYS_DIR: dir,
    VETO_MANDATE_ID: "1",
    VETO_JOURNAL: journalPath,
  };
  const nodeArgs = ["--import", "tsx", "--import", pathToFileURL(preload).href, join(SRC_DIR, "index.ts"), "once", "--window", WINDOW_START];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, { cwd: WATCHER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    const journal = new JsonlJournal(journalPath);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr, timedOut: true, journal });
    }, args.timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      setTimeout(() => resolve({ code, stdout, stderr, timedOut: false, journal }), 50);
    });
  });
}

// ---------------------------------------------------------------------------
// Issue 119 at the layer the fix lives in. The local journal is gone, the
// chain ledger holds a refusal for the window, last_nonce never moved. `once`
// must not send that nonce again. Fails on main (one send).
// ---------------------------------------------------------------------------
test("critic r1: once does not resend a window the chain ledger already refused when the local journal is lost", { timeout: 40_000 }, async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const rpc = await startFakeRpc({ owner: owner.publicKey, ledger: { kind: "bytes", data: ledgerWithRefusal(WINDOW_NONCE) } });
  try {
    const run = await runOnce({ rpcUrl: rpc.url, owner, agent, timeoutMs: 30_000 });
    assert.equal(rpc.sends, 0, `the refused window was sent again: stderr=${run.stderr} stdout=${run.stdout}`);
    assert.equal(run.timedOut, false, `once did not exit: stderr=${run.stderr}`);
    assert.equal(run.code, 0, `stderr=${run.stderr}`);
    const rows = run.journal.load().filter((r) => r.nonce === WINDOW_NONCE.toString());
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]?.decision, "refused");
    assert.equal(run.journal.hasNonce(WINDOW_NONCE), true);
  } finally {
    await rpc.close();
  }
});

// ---------------------------------------------------------------------------
// Journal lost and the ledger read rate limited on every endpoint. The mandate
// read still answers, so last_nonce alone would let the send through. `once`
// must defer, not send. Fails on main (one send, exit 0).
// ---------------------------------------------------------------------------
test("critic r1: once with a lost journal and a throttled ledger read defers instead of sending", { timeout: 40_000 }, async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const rpc = await startFakeRpc({ owner: owner.publicKey, ledger: { kind: "throttle" } });
  try {
    const run = await runOnce({ rpcUrl: rpc.url, owner, agent, timeoutMs: 30_000 });
    assert.equal(rpc.sends, 0, `sent while the ledger could not be read: stderr=${run.stderr} stdout=${run.stdout}`);
    assert.equal(run.timedOut, false, `once did not exit: stderr=${run.stderr}`);
    assert.equal(run.code, 1, `a deferred window must exit 1: stderr=${run.stderr}`);
    assert.match(run.stderr, /rate limited/);
    assert.ok(rpc.ledgerReads >= 1, "the ledger must have been asked");
    assert.equal(run.journal.hasNonce(WINDOW_NONCE), false, "a deferred window stays due");
  } finally {
    await rpc.close();
  }
});

// ---------------------------------------------------------------------------
// Finding. index.ts:71 wraps the ledger repair in withRpcBackoff, which
// retries every non-rate-limit error forever. A decode error is permanent, so
// `once` never exits and `run` never reaches a slot. The r1/r2 harness edits
// on this branch (a null ledger from the fake) hide exactly this case; main's
// harness surfaced it as five 30 s timeouts. Fails on this branch.
// ---------------------------------------------------------------------------
test("critic r1: once ends with a non-zero exit when the ledger account does not decode, instead of retrying forever", { timeout: 40_000 }, async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const rpc = await startFakeRpc({ owner: owner.publicKey, ledger: { kind: "bytes", data: Buffer.alloc(232) } });
  try {
    const run = await runOnce({ rpcUrl: rpc.url, owner, agent, timeoutMs: 12_000 });
    assert.equal(rpc.sends, 0, `sent against an undecodable ledger: stderr=${run.stderr}`);
    assert.equal(run.timedOut, false, `once retried a permanent decode error until killed: stderr=${run.stderr}`);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /not a Ledger/);
  } finally {
    await rpc.close();
  }
});

// ---------------------------------------------------------------------------
// Clock moves backwards across a cadence boundary in run mode, with the
// journal lost in between. The 18:00 Stockholm slot (16:00Z) is due, paid,
// then the clock steps back to 17:59:59 and forward again. dueSlots is the
// selector run mode uses; the journal is dropped before the third pass so
// only the chain read can stop the second send.
// ---------------------------------------------------------------------------
test("critic r1: a clock that moves backwards across a slot boundary pays that slot once even with the journal lost", async () => {
  const slotWindow: PriceWindow = { timeStart: "2026-09-22T16:00:00Z", timeEnd: "2026-09-22T16:15:00Z", sekPerKwh: "0.00892" };
  const feed: PriceFeed = { async getWindow() { return slotWindow; } };
  const submitted: bigint[] = [];
  const settled = { value: 0n };
  const paid = () => ({ decision: "paid" as const, reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig-1" });
  const pass = async (now: Date, journal: JsonlJournal) => {
    const results: string[] = [];
    for (const slot of dueSlots(now)) {
      if (slot.getTime() !== Date.parse("2026-09-22T16:00:00Z")) continue;
      const nonce = slot.getTime() / 1000;
      if (journal.hasNonce(BigInt(nonce))) continue;
      results.push(
        await processWindow({
          at: slot,
          feed,
          journal,
          submit: async (_amount, nonce) => {
            submitted.push(nonce);
            settled.value = nonce;
            return paid();
          },
          kwhMilli: 50_000n,
          mintDecimals: 6,
          log: () => {},
          feedAttempts: 1,
          feedRetryMs: 0,
          reader: {
            chainLastNonce: async () => settled.value,
            recoverSettled: async (nonce) => (nonce === settled.value ? { ...paid(), amount: 446_000n } : null),
            recordedCharge: async () => null,
          },
        }),
      );
    }
    return results;
  };
  const first = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-c118-clock-")), "d.jsonl"));
  assert.deepEqual(await pass(new Date("2026-09-22T16:00:01Z"), first), ["submitted"]);
  assert.deepEqual(await pass(new Date("2026-09-22T15:59:59Z"), first), []);
  const afterRestart = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-c118-clock2-")), "d.jsonl"));
  const third = await pass(new Date("2026-09-22T16:00:30Z"), afterRestart);
  assert.deepEqual(submitted, [1790092800n], `the slot was sent more than once: ${JSON.stringify(third)}`);
  assert.equal(afterRestart.hasNonce(1790092800n), true, "the recovered payment must land in the new journal");
});

// ---------------------------------------------------------------------------
// Overlapping windows from the feed, through the real windowContaining. Two
// windows that both start on the slot with different prices: one send, the
// slot nonce. A wider window listed first, with the slot window after it:
// the slot is paid once, under the slot nonce, at the slot window's price.
// ---------------------------------------------------------------------------
test("critic r1: overlapping feed windows cannot pay a slot twice or under a second nonce", async () => {
  const at = new Date("2026-09-22T16:00:00Z");
  const feedOf = (windows: PriceWindow[]): PriceFeed => ({ async getWindow(when) { return windowContaining(windows, when); } });
  const paid = () => ({ decision: "paid" as const, reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig-2" });
  const drive = async (windows: PriceWindow[]) => {
    const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-c118-overlap-")), "d.jsonl"));
    const submitted: bigint[] = [];
    const settled = { value: 0n };
    const results: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(
        await processWindow({
          at,
          feed: feedOf(windows),
          journal,
          submit: async (_amount, nonce) => {
            submitted.push(nonce);
            settled.value = nonce;
            return paid();
          },
          kwhMilli: 50_000n,
          mintDecimals: 6,
          log: () => {},
          feedAttempts: 1,
          feedRetryMs: 0,
          reader: {
            chainLastNonce: async () => settled.value,
            recoverSettled: async () => null,
            recordedCharge: async () => null,
          },
        }),
      );
    }
    return { results, submitted, journal };
  };
  const twoOnSlot = await drive([
    { timeStart: "2026-09-22T16:00:00Z", timeEnd: "2026-09-22T16:30:00Z", sekPerKwh: "0.5" },
    { timeStart: "2026-09-22T16:00:00Z", timeEnd: "2026-09-22T16:15:00Z", sekPerKwh: "0.00892" },
  ]);
  assert.deepEqual(twoOnSlot.submitted, [1790092800n]);
  assert.deepEqual(twoOnSlot.results, ["submitted", "skipped", "skipped"]);
  const widerFirst = await drive([
    { timeStart: "2026-09-22T15:45:00Z", timeEnd: "2026-09-22T16:15:00Z", sekPerKwh: "0.5" },
    { timeStart: "2026-09-22T16:00:00Z", timeEnd: "2026-09-22T16:15:00Z", sekPerKwh: "0.00892" },
  ]);
  assert.deepEqual(widerFirst.submitted, [1790092800n]);
  assert.deepEqual(widerFirst.results, ["submitted", "skipped", "skipped"]);
  const paidRows = widerFirst.journal.load().filter((r) => r.decision === "paid");
  assert.equal(paidRows.length, 1);
  assert.equal(paidRows[0]?.nonce, "1790092800");
  assert.equal(paidRows[0]?.sek_per_kwh, "0.00892");
  assert.equal(widerFirst.journal.load().filter((r) => r.decision === "gap").length, 0);
});
