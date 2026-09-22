// Critic round 1 fixtures for fix/watcher-crash-and-nits (issues 66, 80, 81).
//
// Each test names the property it pins. The fake RPC is a JSON-RPC server on
// 127.0.0.1 with a websocket on port+1, the same layout the watcher derives
// its websocket endpoint from.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ledgerPda, mandatePda, readLastNonce, recoverSettledCharge, submitCharge, u64Le } from "./chain.js";
import { loadConfig } from "./config.js";
import type { PriceFeed } from "./feed.js";
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
const AMOUNT = 446_000n;
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

function feedWith(sek: string): PriceFeed {
  return {
    async getWindow() {
      return { timeStart: WINDOW_START, timeEnd: WINDOW_END, sekPerKwh: sek };
    },
  };
}

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params: unknown[] };

/** Fake RPC. `statusAfterSend` says what getSignatureStatuses answers once a
 * send has been accepted: "throttle" is a 429, "pending" is a null status
 * (the transaction is not yet visible over HTTP). The websocket confirms the
 * subscription after `wsDelayMs`. */
async function startFakeRpc(args: {
  owner: PublicKey;
  agent: PublicKey;
  paidSig: string;
  statusAfterSend: "throttle" | "pending";
  wsDelayMs: number;
}): Promise<{
  url: string;
  readonly sends: number;
  readonly statusPolls: number;
  readonly wsSubscribes: number;
  close: () => Promise<void>;
}> {
  const programId = new PublicKey(PROGRAM_ID);
  let sends = 0;
  let statusPolls = 0;
  let wsSubscribes = 0;
  const mandate = mandatePda(programId, args.owner, 1n);
  const ledger = ledgerPda(programId, mandate);
  const account = {
    executable: false,
    owner: PROGRAM_ID,
    lamports: 1_000_000,
    data: [Buffer.alloc(232).toString("base64"), "base64"],
    rentEpoch: 0,
  };
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
              Buffer.concat([
                Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]),
                u64Le(AMOUNT),
                u64Le(WINDOW_NONCE),
              ]),
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
      case "getAccountInfo": {
        const asked = String(req.params[0] ?? "");
        if (asked === ledger.toBase58()) {
          return ok(req.id, { context: { slot: 1 }, value: null });
        }
        return ok(req.id, { context: { slot: 1 }, value: account });
      }
      case "sendTransaction":
        sends += 1;
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
          setTimeout(() => {
            if (socket.readyState !== 1) return;
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
      get wsSubscribes() {
        return wsSubscribes;
      },
      close: async () => {
        // A normal close (1000) from the server side. web3's rpc-websockets
        // client reconnects forever on any other code, which would keep the
        // test process alive after the test.
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

function watcherEnv(args: { rpcUrl: string; owner: Keypair; agent: Keypair; keysDir: string }): NodeJS.ProcessEnv {
  return {
    VETO_RPC: args.rpcUrl,
    VETO_PROGRAM_ID: PROGRAM_ID,
    VETO_MINT: Keypair.generate().publicKey.toBase58(),
    VETO_OWNER: args.owner.publicKey.toBase58(),
    VETO_OWNER_TOKEN: Keypair.generate().publicKey.toBase58(),
    VETO_MERCHANT: Keypair.generate().publicKey.toBase58(),
    VETO_MERCHANT_TOKEN: Keypair.generate().publicKey.toBase58(),
    VETO_AGENT: args.agent.publicKey.toBase58(),
    VETO_KEYS_DIR: args.keysDir,
    VETO_MANDATE_ID: "1",
  };
}

type ChildRun = { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean };

/** Run a script under tsx. Resolves when the child exits on its own, or
 * after `timeoutMs` with `timedOut: true` (the child is then killed). */
function runChild(args: {
  script: string;
  argv?: string[];
  preload?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<ChildRun> {
  const nodeArgs = ["--import", "tsx"];
  if (args.preload !== undefined) nodeArgs.push("--import", pathToFileURL(args.preload).href);
  nodeArgs.push(args.script, ...(args.argv ?? []));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: WATCHER_DIR,
      env: { ...process.env, ...(args.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      // Give the pipes a tick to drain.
      setTimeout(() => resolve({ code, signal, stdout, stderr, timedOut: false }), 50);
    });
  });
}

// ---------------------------------------------------------------------------
// Issue 66, the property the fix must not trade away.
//
// A send that the chain confirms over the websocket a little after the grace
// period is a paid charge. Before this branch web3 waited for the websocket
// until the blockhash expired. Passes on the parent commit.
// ---------------------------------------------------------------------------
test(
  "critic r1: a websocket confirmation that arrives after the grace period is a paid charge, not a rate limit",
  { timeout: 30_000 },
  async () => {
    const owner = Keypair.generate();
    const agent = Keypair.generate();
    const paidSig = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 11));
    const rpc = await startFakeRpc({
      owner: owner.publicKey,
      agent: agent.publicKey,
      paidSig,
      statusAfterSend: "pending",
      wsDelayMs: 3_000,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const logs: string[] = [];
    try {
      const keysDir = mkdtempSync(join(tmpdir(), "veto-c66-keys-"));
      const cfg = loadConfig(watcherEnv({ rpcUrl: rpc.url, owner, agent, keysDir }), { envFiles: [] });
      const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-c66-journal-")), "d.jsonl"));
      const result = await processWindow({
        at: new Date(WINDOW_START),
        feed: feedWith("0.00892"),
        journal,
        submit: (amount, nonce) => submitCharge({ cfg, agent, amount, nonce }),
        kwhMilli: 50_000n,
        mintDecimals: 6,
        log: (line) => logs.push(line),
        feedAttempts: 1,
        feedRetryMs: 0,
        chainLastNonce: () => readLastNonce({ cfg, agent }),
        recoverSettled: (nonce) => recoverSettledCharge({ cfg, agent, nonce }),
      });
      const rows = journal.load().filter((r) => r.nonce === WINDOW_NONCE.toString());
      assert.equal(rpc.sends, 1, "the charge must have been sent once");
      assert.equal(unhandled.length, 0);
      assert.equal(
        rows.some((r) => r.decision === "gap" && r.reason === "rpc rate limited on all endpoints"),
        false,
        `no endpoint was rate limited, yet the journal says so: ${JSON.stringify(rows)}; log: ${logs.join(" | ")}`,
      );
      assert.equal(result, "submitted", `log: ${logs.join(" | ")}`);
      assert.equal(rows[0]?.decision, "paid");
      assert.equal(rows[0]?.signature, paidSig);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await rpc.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Issue 66 under the once command, driven through index.ts with the price
// feed stubbed by a preload. The process must exit 0 with the paid row on
// disk and the leftover poll named on stderr. Fails on the parent commit
// (exit 1, unhandled RateLimitedError).
// ---------------------------------------------------------------------------
test(
  "critic r1: once survives a throttled status poll after the websocket confirm, records paid, exits 0",
  { timeout: 40_000 },
  async () => {
    const owner = Keypair.generate();
    const agent = Keypair.generate();
    const paidSig = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 23));
    const rpc = await startFakeRpc({
      owner: owner.publicKey,
      agent: agent.publicKey,
      paidSig,
      statusAfterSend: "throttle",
      wsDelayMs: 400,
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "veto-c66-once-"));
      writeFileSync(join(dir, "agent.json"), JSON.stringify(Array.from(agent.secretKey)));
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
      const run = await runChild({
        script: join(SRC_DIR, "index.ts"),
        argv: ["once", "--window", WINDOW_START],
        preload,
        env: { ...watcherEnv({ rpcUrl: rpc.url, owner, agent, keysDir: dir }), VETO_JOURNAL: journalPath },
        timeoutMs: 30_000,
      });
      const journal = new JsonlJournal(journalPath);
      const rows = journal.load().filter((r) => r.nonce === WINDOW_NONCE.toString());
      assert.equal(run.timedOut, false, `once did not exit: stderr=${run.stderr}`);
      assert.equal(rpc.sends, 1, "the charge must have been sent once");
      assert.ok(rpc.statusPolls >= 1, "the status poll must have run after the send");
      assert.equal(rows[0]?.decision, "paid", `row: ${JSON.stringify(rows)} stderr=${run.stderr}`);
      assert.equal(rows[0]?.signature, paidSig);
      assert.equal(run.code, 0, `once exit code lies about the outcome: stderr=${run.stderr}`);
      assert.doesNotMatch(run.stderr, /unhandled rejection/i);
      assert.match(run.stderr, /leftover status poll after .* was already confirmed/);
    } finally {
      await rpc.close();
    }
  },
);

// Guard that the file under review still reads as the parent did where it
// should: only signatures moved for issue 80, no decision or reason did.
test("critic r1: issue 80 changed only which signature a stale-nonce row carries", () => {
  const src = readFileSync(join(SRC_DIR, "run.ts"), "utf8");
  assert.match(src, /reason: "window overtaken by a later settled charge"/);
  assert.match(src, /const STALE_UNCONFIRMED_REASON = "stale nonce; chain did not confirm this window paid"/);
  assert.match(src, /closeAlreadySettled\(latest, receipt\.signature\)/);
  assert.equal(/closeAlreadySettled\([^)]*,\s*0n\)/.test(src), false, "issue 81: no caller passes an amount");
});
