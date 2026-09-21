// Critic round 2 fixtures for fix/watcher-crash-and-nits (issues 66, 80, 81).
//
// Round 1 findings F1, F2 and F3 are re-checked by timing and by driving the
// real `once` command, not by reading confirm.ts. The fake RPC is the same
// layout as the round 1 file: JSON-RPC over HTTP on 127.0.0.1, websocket on
// port+1. The feed is stubbed by a preload, and the preload can also raise a
// rejection nobody awaits, keyed off the real sendTransaction request.
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
import { mandatePda, u64Le } from "./chain.js";
import { JsonlJournal } from "./journal.js";

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
const AMOUNT = 446_000n;
const DEFAULT_GRACE_MS = 2_000; // confirm.ts default; F1 is only proven if the websocket answers later than this
const RATE_LIMIT_GAP_REASON = "rpc rate limited on all endpoints";
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

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params: unknown[] };

/** Fake RPC. After a send, getSignatureStatuses answers either a 429
 * ("throttle") or a null status ("pending", not yet visible over HTTP). The
 * websocket confirms after `wsDelayMs`, or never when it is null. */
async function startFakeRpc(args: {
  owner: PublicKey;
  agent: PublicKey;
  paidSig: string;
  statusAfterSend: "throttle" | "pending";
  wsDelayMs: number | null;
}): Promise<{
  url: string;
  readonly sends: number;
  readonly statusPolls: number;
  readonly sentAt: number | null;
  readonly wsConfirmedAt: number | null;
  close: () => Promise<void>;
}> {
  const programId = new PublicKey(PROGRAM_ID);
  let sends = 0;
  let statusPolls = 0;
  let sentAt: number | null = null;
  let wsConfirmedAt: number | null = null;
  const mandate = mandatePda(programId, args.owner, 1n);
  const account = {
    executable: false,
    owner: PROGRAM_ID,
    lamports: 1_000_000,
    data: [Buffer.alloc(232).toString("base64"), "base64"],
    rentEpoch: 0,
  };
  // The paid transaction as the chain would return it after the confirm, so
  // that submitCharge can parse the PAID log the way it does on the real chain.
  const paidTx = {
    slot: 1,
    blockTime: 1,
    transaction: {
      signatures: [args.paidSig],
      message: {
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        accountKeys: [args.agent.toBase58(), mandate.toBase58(), PROGRAM_ID],
        recentBlockhash: base58(new Uint8Array(32).fill(7)),
        instructions: [
          {
            programIdIndex: 2,
            accounts: [0, 1],
            data: base58(
              Buffer.concat([Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]), u64Le(AMOUNT), u64Le(WINDOW_NONCE)]),
            ),
          },
        ],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [0, 0, 0],
      postBalances: [0, 0, 0],
      innerInstructions: [],
      logMessages: [`Program log: VETO PAID amount=${AMOUNT.toString()}`],
      preTokenBalances: [],
      postTokenBalances: [],
      loadedAddresses: { writable: [], readonly: [] },
      computeUnitsConsumed: 0,
    },
  };
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
      case "getAccountInfo":
        return ok(req.id, { context: { slot: 1 }, value: account });
      case "sendTransaction":
        sends += 1;
        sentAt = sentAt ?? Date.now();
        return ok(req.id, args.paidSig);
      case "getSignatureStatuses":
        statusPolls += 1;
        if (sends > 0 && args.statusAfterSend === "throttle") return { status: 429, body: "Too Many Requests" };
        return ok(req.id, { context: { slot: 1 }, value: [null] });
      case "getTransaction":
        return ok(req.id, paidTx);
      case "getSignaturesForAddress":
        return ok(req.id, []);
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
    let wsSubscribes = 0;
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
        if (msg.method === "signatureSubscribe") {
          wsSubscribes += 1;
          const subId = wsSubscribes;
          if (msg.id !== undefined) socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: subId }));
          if (args.wsDelayMs === null) return;
          setTimeout(() => {
            if (socket.readyState !== 1) return;
            wsConfirmedAt = Date.now();
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "signatureNotification",
                params: { subscription: subId, result: { context: { slot: 1 }, value: { err: null } } },
              }),
            );
          }, args.wsDelayMs);
          return;
        }
        if (msg.id !== undefined) socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
      });
    }) as (socket: never) => void);
    return {
      url,
      get sends() {
        return sends;
      },
      get statusPolls() {
        return statusPolls;
      },
      get sentAt() {
        return sentAt;
      },
      get wsConfirmedAt() {
        return wsConfirmedAt;
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

type ChildRun = { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean };

/** The real `once --window` through index.ts. The preload stubs the price
 * feed and, when `inject` is set, raises a rejection nobody awaits
 * `injectAfterSendMs` after the real sendTransaction request goes out. */
async function runOnce(args: {
  rpcUrl: string;
  owner: Keypair;
  agent: Keypair;
  inject?: { kind: "rate-limit" | "type-error"; afterSendMs: number };
  timeoutMs: number;
}): Promise<ChildRun & { journalPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "veto-c66-r2-"));
  writeFileSync(join(dir, "agent.json"), JSON.stringify(Array.from(args.agent.secretKey)));
  const journalPath = join(dir, "decisions.jsonl");
  const feedBody = JSON.stringify([
    { SEK_per_kWh: 0.00892, EUR_per_kWh: 0.0008, EXR: 11.1, time_start: WINDOW_START, time_end: WINDOW_END },
  ]);
  const rpcTs = pathToFileURL(join(SRC_DIR, "rpc.ts")).href;
  const injectExpr =
    args.inject === undefined
      ? "null"
      : args.inject.kind === "rate-limit"
        ? `new RateLimitedError("rpc rate limited on https://elsewhere.example")`
        : `new TypeError("journal.append is not a function")`;
  const preload = join(dir, "preload.mjs");
  writeFileSync(
    preload,
    [
      `import { RateLimitedError } from ${JSON.stringify(rpcTs)};`,
      `const FEED = "https://www.elprisetjustnu.se";`,
      `const body = ${JSON.stringify(feedBody)};`,
      `const real = globalThis.fetch;`,
      `let armed = false;`,
      `globalThis.fetch = (input, init) => {`,
      `  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;`,
      `  if (url.startsWith(FEED)) return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));`,
      `  const raw = init && typeof init.body === "string" ? init.body : "";`,
      `  if (!armed && raw.includes('"sendTransaction"')) {`,
      `    armed = true;`,
      `    const reason = ${injectExpr};`,
      `    if (reason !== null) setTimeout(() => { Promise.reject(reason); }, ${args.inject?.afterSendMs ?? 0});`,
      `  }`,
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
  const run = await new Promise<ChildRun>((resolve) => {
    const child = spawn(process.execPath, nodeArgs, { cwd: WATCHER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL", stdout, stderr, timedOut: true });
    }, args.timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      setTimeout(() => resolve({ code, signal, stdout, stderr, timedOut: false }), 50);
    });
  });
  return { ...run, journalPath };
}

function rowsFor(journalPath: string) {
  return new JsonlJournal(journalPath).load().filter((r) => r.nonce === WINDOW_NONCE.toString());
}

// ---------------------------------------------------------------------------
// F1 by timing. The HTTP status poll only ever says "not yet". The websocket
// answers 3 s after the send, later than the 2 s grace. The command must
// record paid and exit 0; nothing was throttled, so the journal must not say
// it was, and the poll must have kept going rather than giving up at the grace.
// ---------------------------------------------------------------------------
test(
  "critic r2 F1: once with a websocket answer after the grace records paid and exits 0, and never says rate limited",
  { timeout: 40_000 },
  async () => {
    const owner = Keypair.generate();
    const agent = Keypair.generate();
    const paidSig = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 31));
    const rpc = await startFakeRpc({
      owner: owner.publicKey,
      agent: agent.publicKey,
      paidSig,
      statusAfterSend: "pending",
      wsDelayMs: 3_000,
    });
    try {
      const run = await runOnce({ rpcUrl: rpc.url, owner, agent, timeoutMs: 30_000 });
      const rows = rowsFor(run.journalPath);
      assert.equal(run.timedOut, false, `once did not exit: stderr=${run.stderr}`);
      assert.equal(rpc.sends, 1, "the charge must have been sent once");
      assert.ok(rpc.sentAt !== null && rpc.wsConfirmedAt !== null, "send and websocket confirm must both have happened");
      const wsAfterSendMs = rpc.wsConfirmedAt - rpc.sentAt;
      assert.ok(
        wsAfterSendMs >= DEFAULT_GRACE_MS,
        `the websocket answered ${wsAfterSendMs}ms after the send, inside the ${DEFAULT_GRACE_MS}ms grace; this run proves nothing about F1`,
      );
      assert.ok(rpc.statusPolls >= 2, `the poll gave up after ${rpc.statusPolls} attempt(s) instead of waiting for the chain`);
      assert.equal(rows.length, 1, `rows: ${JSON.stringify(rows)}`);
      assert.equal(rows[0]?.decision, "paid", `row: ${JSON.stringify(rows)} stderr=${run.stderr}`);
      assert.equal(rows[0]?.signature, paidSig);
      assert.equal(run.code, 0, `once exit code lies about the outcome: stderr=${run.stderr}`);
      assert.doesNotMatch(run.stderr, /rate limit/i, `a slow chain was reported as a throttle: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /unhandled rejection/i);
    } finally {
      await rpc.close();
    }
  },
);

// ---------------------------------------------------------------------------
// The other direction of F1. A status poll that is genuinely 429'd and a
// websocket that never answers is a rate limit. The gap row and the exit
// code must still say so.
// ---------------------------------------------------------------------------
test(
  "critic r2 regression: once against a throttled status poll with no websocket answer records the rate-limited gap and exits 1",
  { timeout: 40_000 },
  async () => {
    const owner = Keypair.generate();
    const agent = Keypair.generate();
    const paidSig = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 41));
    const rpc = await startFakeRpc({
      owner: owner.publicKey,
      agent: agent.publicKey,
      paidSig,
      statusAfterSend: "throttle",
      wsDelayMs: null,
    });
    try {
      const run = await runOnce({ rpcUrl: rpc.url, owner, agent, timeoutMs: 30_000 });
      const rows = rowsFor(run.journalPath);
      assert.equal(run.timedOut, false, `once did not exit: stderr=${run.stderr}`);
      assert.equal(rpc.sends, 1, "the charge must have been sent once");
      assert.ok(rpc.statusPolls >= 1, "the status poll must have run after the send");
      assert.equal(rpc.wsConfirmedAt, null, "the websocket must not have answered in this run");
      assert.equal(
        rows.some((r) => r.decision === "paid"),
        false,
        `nothing confirmed, yet the journal says paid: ${JSON.stringify(rows)}`,
      );
      assert.equal(rows[0]?.decision, "gap", `row: ${JSON.stringify(rows)} stderr=${run.stderr}`);
      assert.equal(rows[0]?.reason, RATE_LIMIT_GAP_REASON);
      assert.equal(run.code, 1, `a throttled charge must not exit 0: stderr=${run.stderr}`);
      assert.match(run.stderr, /once: rpc rate limited on all endpoints/);
    } finally {
      await rpc.close();
    }
  },
);

// ---------------------------------------------------------------------------
// F2 in the real process. After a clean confirm (poll says not yet, websocket
// answers at 300 ms, nothing left over), something unrelated rejects with a
// rate-limit message and nobody awaits it. It must not be absorbed as a
// leftover poll and must not be turned into the deferred outcome: the paid
// row is already on disk, and the process ends on the rejection with its stack.
// ---------------------------------------------------------------------------
test(
  "critic r2 F2: an unrelated rate-limit rejection after a clean confirm inside once ends the process with its stack and is not absorbed",
  { timeout: 40_000 },
  async () => {
    const owner = Keypair.generate();
    const agent = Keypair.generate();
    const paidSig = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 51));
    const rpc = await startFakeRpc({
      owner: owner.publicKey,
      agent: agent.publicKey,
      paidSig,
      statusAfterSend: "pending",
      wsDelayMs: 300,
    });
    try {
      const run = await runOnce({
        rpcUrl: rpc.url,
        owner,
        agent,
        inject: { kind: "rate-limit", afterSendMs: 600 },
        timeoutMs: 30_000,
      });
      const rows = rowsFor(run.journalPath);
      assert.equal(run.timedOut, false, `process kept running after an unhandled rejection: stderr=${run.stderr}`);
      assert.equal(rpc.sends, 1);
      assert.equal(rows[0]?.decision, "paid", `the confirm was clean and must already be journaled: ${JSON.stringify(rows)} stderr=${run.stderr}`);
      assert.equal(rows[0]?.signature, paidSig);
      assert.doesNotMatch(run.stderr, /no longer needed this answer/, `absorbed as a leftover: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /leftover status poll/, `absorbed as a leftover: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /once: rpc rate limited on all endpoints/, `collapsed into the deferred outcome: ${run.stderr}`);
      assert.equal(run.code, 1, `process carried on as if nothing happened: stdout=${run.stdout} stderr=${run.stderr}`);
      assert.match(run.stderr, /RateLimitedError/, `no error name: ${run.stderr}`);
      assert.match(run.stderr, /rpc rate limited on https:\/\/elsewhere\.example/);
      assert.match(run.stderr, /^\s+at /m, `no stack frame to act on: ${run.stderr}`);
    } finally {
      await rpc.close();
    }
  },
);

// ---------------------------------------------------------------------------
// F3 in the real process. Same clean confirm, then a programming error in a
// promise nobody awaits. The process must end with the TypeError and a stack.
// ---------------------------------------------------------------------------
test(
  "critic r2 F3: a programming error after a clean confirm inside once ends the process with its stack",
  { timeout: 40_000 },
  async () => {
    const owner = Keypair.generate();
    const agent = Keypair.generate();
    const paidSig = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 61));
    const rpc = await startFakeRpc({
      owner: owner.publicKey,
      agent: agent.publicKey,
      paidSig,
      statusAfterSend: "pending",
      wsDelayMs: 300,
    });
    try {
      const run = await runOnce({
        rpcUrl: rpc.url,
        owner,
        agent,
        inject: { kind: "type-error", afterSendMs: 600 },
        timeoutMs: 30_000,
      });
      const rows = rowsFor(run.journalPath);
      assert.equal(run.timedOut, false, `process kept running after a programming error: stderr=${run.stderr}`);
      assert.equal(rows[0]?.decision, "paid", `the confirm was clean and must already be journaled: ${JSON.stringify(rows)} stderr=${run.stderr}`);
      assert.equal(run.code, 1, `process carried on as if nothing happened: stdout=${run.stdout} stderr=${run.stderr}`);
      assert.match(run.stderr, /TypeError: journal\.append is not a function/, `no error name: ${run.stderr}`);
      assert.match(run.stderr, /^\s+at /m, `no stack frame to act on: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /^\S+ unhandled rejection: journal\.append is not a function$/m, `reduced to one line without a stack: ${run.stderr}`);
    } finally {
      await rpc.close();
    }
  },
);
