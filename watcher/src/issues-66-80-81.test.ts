import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { mandatePda, readLastNonce, recoverSettledCharge, submitCharge, u64Le } from "./chain.js";
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
const { Server: WsServer } = require("ws") as {
  Server: new (opts: { host: string; port: number }) => WsServer;
};

const windowStart = "2026-09-20T00:00:00+02:00";
const WINDOW_NONCE = 1789855200n;
const LATER_NONCE = WINDOW_NONCE + 21_600n;
const STALE_SIG = "stale-sig";
const RECOVERED_SIG = "recovered-sig";
const RUN_SRC = fileURLToPath(new URL("./run.ts", import.meta.url));

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
      return {
        timeStart: windowStart,
        timeEnd: "2026-09-20T00:15:00+02:00",
        sekPerKwh: sek,
      };
    },
  };
}

function r3Args(journal: JsonlJournal) {
  return {
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  };
}

const STALE = {
  decision: "refused" as const,
  reason: "nonce already settled",
  reasonCode: 3,
  suggestedOverride: null,
  signature: STALE_SIG,
};

test("a stale-nonce refusal carries its confirmed signature when a later payment overtook the window", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-80-overtaken-")), "d.jsonl"));
  let reads = 0;
  const result = await processWindow({
    ...r3Args(journal),
    reader: {
      chainLastNonce: async () => {
        reads += 1;
        return reads === 1 ? 0n : LATER_NONCE;
      },
      recoverSettled: async () => null,
      recordedCharge: async () => null,
    },
    submit: async () => STALE,
  });
  const row = journal.load().find((r) => r.nonce === WINDOW_NONCE.toString());
  assert.ok(row, "the window must be on record");
  assert.equal(row?.decision, "skipped");
  assert.equal(row?.reason, "window overtaken by a later settled charge");
  assert.equal(row?.signature, STALE_SIG);
  assert.notEqual(result, "submitted");
});

test("a stale-nonce refusal carries its confirmed signature when the chain did not confirm this window paid", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-80-gap-")), "d.jsonl"));
  const result = await processWindow({
    ...r3Args(journal),
    reader: {
      chainLastNonce: async () => 0n,
      recoverSettled: async () => null,
      recordedCharge: async () => null,
    },
    submit: async () => STALE,
  });
  const row = journal.load().find((r) => r.nonce === WINDOW_NONCE.toString());
  assert.ok(row, "the window must be on record");
  assert.equal(result, "gap");
  assert.equal(row?.decision, "gap");
  assert.equal(row?.reason, "stale nonce; chain did not confirm this window paid");
  assert.equal(row?.signature, STALE_SIG);
  assert.equal(journal.hasNonce(WINDOW_NONCE), false);
});

test("a recovered paid row keeps the paid signature when a stale-nonce refusal is also seen", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-80-paid-")), "d.jsonl"));
  let reads = 0;
  const result = await processWindow({
    ...r3Args(journal),
    reader: {
      chainLastNonce: async () => {
        reads += 1;
        return reads === 1 ? 0n : WINDOW_NONCE;
      },
      recoverSettled: async () => ({
        decision: "paid" as const,
        reason: "ok",
        reasonCode: 0,
        suggestedOverride: null,
        signature: RECOVERED_SIG,
        amount: 446_000n,
      }),
      recordedCharge: async () => null,
    },
    submit: async () => STALE,
  });
  const row = journal.load().find((r) => r.nonce === WINDOW_NONCE.toString());
  assert.equal(result, "submitted");
  assert.equal(row?.decision, "paid");
  assert.equal(row?.signature, RECOVERED_SIG);
});

test("closeAlreadySettled does not take an amount it never reads", () => {
  const src = readFileSync(RUN_SRC, "utf8");
  assert.equal(
    /closeAlreadySettled = async \(settled: bigint, amount: bigint\)/.test(src),
    false,
    "amount is an unused parameter",
  );
  assert.equal(/closeAlreadySettled\([^;]*0n\)/.test(src), false, "no caller should pass 0n to satisfy amount");
});

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params: unknown[] };

type WsSocket = {
  on(event: string, cb: (data: Buffer | string) => void): void;
  send(data: string): void;
};

async function startConfirmRpc(args: {
  programId: PublicKey;
  owner: PublicKey;
  mandateId: bigint;
  agent: PublicKey;
  paidSig: string;
  amount: bigint;
  nonce: bigint;
}): Promise<{
  url: string;
  methods: string[];
  sends: number;
  statusPolls: number;
  wsSubscribes: number;
  close: () => Promise<void>;
}> {
  const methods: string[] = [];
  let sends = 0;
  let statusPolls = 0;
  let wsSubscribes = 0;
  const mandate = mandatePda(args.programId, args.owner, args.mandateId);
  const mandateData = Buffer.alloc(232);
  const account = {
    executable: false,
    owner: args.programId.toBase58(),
    lamports: 1_000_000,
    data: [mandateData.toString("base64"), "base64"],
    rentEpoch: 0,
  };
  const paidTx = {
    slot: 1,
    blockTime: 1,
    transaction: {
      signatures: [args.paidSig],
      message: {
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        accountKeys: [args.agent.toBase58(), mandate.toBase58(), args.programId.toBase58()],
        recentBlockhash: base58(new Uint8Array(32).fill(7)),
        instructions: [
          {
            programIdIndex: 2,
            accounts: [0, 1],
            data: base58(Buffer.concat([Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]), u64Le(args.amount), u64Le(args.nonce)])),
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
      logMessages: [`Program log: VETO PAID amount=${args.amount.toString()}`],
      preTokenBalances: [],
      postTokenBalances: [],
      loadedAddresses: { writable: [], readonly: [] },
      computeUnitsConsumed: 0,
    },
  };

  const handle = (req: RpcRequest): { status: number; body: unknown } => {
    methods.push(req.method);
    switch (req.method) {
      case "getLatestBlockhash":
      case "getRecentBlockhash":
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              context: { slot: 1 },
              value: { blockhash: base58(new Uint8Array(32).fill(9)), lastValidBlockHeight: 10_000 },
            },
          },
        };
      case "getBlockHeight":
        return { status: 200, body: { jsonrpc: "2.0", id: req.id, result: 1 } };
      case "getAccountInfo":
        return {
          status: 200,
          body: { jsonrpc: "2.0", id: req.id, result: { context: { slot: 1 }, value: account } },
        };
      case "sendTransaction":
        sends += 1;
        return { status: 200, body: { jsonrpc: "2.0", id: req.id, result: args.paidSig } };
      case "getSignatureStatuses":
        statusPolls += 1;
        if (sends > 0) {
          return { status: 429, body: "Too Many Requests" };
        }
        return {
          status: 200,
          body: { jsonrpc: "2.0", id: req.id, result: { context: { slot: 1 }, value: [null] } },
        };
      case "getTransaction":
        return {
          status: 200,
          body: { jsonrpc: "2.0", id: req.id, result: paidTx },
        };
      case "getSignaturesForAddress":
        return { status: 200, body: { jsonrpc: "2.0", id: req.id, result: [] } };
      default:
        return {
          status: 200,
          body: { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unexpected rpc method ${req.method}` } },
        };
    }
  };

  let lastBindError = "unknown bind error";
  const writeReply = (res: ServerResponse, status: number, body: unknown) => {
    if (status === 429) {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end(typeof body === "string" ? body : "Too Many Requests");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

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
            writeReply(res, 429, "Too Many Requests");
            return;
          }
          writeReply(
            res,
            200,
            replies.map((r) => r.body),
          );
          return;
        }
        const reply = handle(parsed);
        writeReply(res, reply.status, reply.body);
      });
    });

    const url = await new Promise<string>((resolve) => {
      http.listen(0, "127.0.0.1", () => {
        const address = http.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    const httpPort = Number(new URL(url).port);
    let wss: WsServer;
    try {
      wss = new WsServer({ host: "127.0.0.1", port: httpPort + 1 });
      if (wss.address() === null) {
        await new Promise<void>((resolve, reject) => {
          wss.once("listening", () => resolve());
          wss.once("error", ((err: unknown) => reject(err)) as (...args: never[]) => void);
        });
      }
    } catch (err) {
      await new Promise<void>((done) => http.close(() => done()));
      lastBindError = err instanceof Error ? err.message : String(err);
      continue;
    }

    wss.on("connection", ((socket: WsSocket) => {
      socket.on("message", (data: Buffer | string) => {
        let msg: { id?: number | string; method?: string; params?: unknown };
        try {
          msg = JSON.parse(String(data)) as { id?: number | string; method?: string; params?: unknown };
        } catch {
          return;
        }
        if (msg.method === "signatureSubscribe") {
          wsSubscribes += 1;
          const subId = wsSubscribes;
          if (msg.id !== undefined) {
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: subId }));
          }
          setTimeout(() => {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "signatureNotification",
                params: {
                  subscription: subId,
                  result: { context: { slot: 1 }, value: { err: null } },
                },
              }),
            );
          }, 400);
          return;
        }
        if (msg.id !== undefined) {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
        }
      });
    }) as (socket: never) => void);

    return {
      url,
      methods,
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
        await new Promise<void>((done) => wss.close(() => done()));
        await new Promise<void>((done) => http.close(() => done()));
      },
    };
  }
  throw new Error(`could not bind http rpc and websocket on port+1: ${lastBindError}`);
}

test(
  "a throttled confirm status poll after send and websocket confirm does not end the process, and the decision is recorded",
  { timeout: 20_000 },
  async () => {
    const owner = Keypair.generate();
    const agent = Keypair.generate();
    const paidSig = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 3));
    const rpc = await startConfirmRpc({
      programId: new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV"),
      owner: owner.publicKey,
      mandateId: 1n,
      agent: agent.publicKey,
      paidSig,
      amount: 446_000n,
      nonce: WINDOW_NONCE,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const cfg = loadConfig(
        {
          VETO_RPC: rpc.url,
          VETO_PROGRAM_ID: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
          VETO_MINT: Keypair.generate().publicKey.toBase58(),
          VETO_OWNER: owner.publicKey.toBase58(),
          VETO_OWNER_TOKEN: Keypair.generate().publicKey.toBase58(),
          VETO_MERCHANT: Keypair.generate().publicKey.toBase58(),
          VETO_MERCHANT_TOKEN: Keypair.generate().publicKey.toBase58(),
          VETO_AGENT: agent.publicKey.toBase58(),
          VETO_KEYS_DIR: mkdtempSync(join(tmpdir(), "veto-66-keys-")),
          VETO_MANDATE_ID: "1",
        },
        { envFiles: [] },
      );
      const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-66-journal-")), "d.jsonl"));
      const stderr: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let result: string;
      try {
        result = await processWindow({
          at: new Date(windowStart),
          feed: feedWith("0.00892"),
          journal,
          submit: (amount, nonce) => submitCharge({ cfg, agent, amount, nonce }),
          kwhMilli: 50_000n,
          mintDecimals: 6,
          log: () => {},
          feedAttempts: 1,
          feedRetryMs: 0,
          reader: {
            chainLastNonce: () => readLastNonce({ cfg, agent }),
            recoverSettled: (nonce) => recoverSettledCharge({ cfg, agent, nonce }),
            recordedCharge: async () => null,
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      } finally {
        process.stderr.write = originalWrite;
      }
      assert.equal(rpc.sends, 1, "the charge must have been sent");
      assert.ok(rpc.wsSubscribes >= 1, "the websocket must have confirmed the send");
      assert.ok(rpc.statusPolls >= 1, "the status poll must have run after the send");
      assert.equal(
        unhandled.length,
        0,
        `leftover status poll became an unhandled rejection: ${unhandled.map((e) => (e instanceof Error ? e.message : String(e))).join(" | ")}`,
      );
      const row = journal.load().find((r) => r.nonce === WINDOW_NONCE.toString());
      assert.ok(row, "a decision the watcher already took must be recorded before exit");
      assert.equal(result, "submitted");
      assert.equal(row?.decision, "paid");
      assert.equal(row?.signature, paidSig);
      assert.ok(
        stderr.some((line) => /leftover status poll after .* was already confirmed/.test(line)),
        `leftover poll must be reported, got: ${stderr.join(" | ")}`,
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await rpc.close();
    }
  },
);
