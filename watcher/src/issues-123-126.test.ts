/** Issues 123 and 126.
 *
 * A wider window listed first must not hide the window that starts on the
 * slot (covered in feed.test.ts and the widerFirst half of the 118/119 critic).
 * An idle pass of the 30 second loop must not read the ledger. A chain-backed
 * call passes one reader, and that reader's recorded charge is what stops a
 * second send.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { dueSlots } from "./cadence.js";
import { ledgerPda, mandatePda } from "./chain.js";
import type { PriceFeed } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import { nonceFromSlot } from "./nonce.js";
import { processWindow } from "./run.js";

const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));
const WATCHER_DIR = join(SRC_DIR, "..");
const PROGRAM_ID = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const WINDOW_START = "2026-09-20T00:00:00+02:00";
const WINDOW_NONCE = 1789855200n;
const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);

const BASE = { kwhMilli: 50_000n, mintDecimals: 6, log: () => {}, feedAttempts: 1, feedRetryMs: 0 };

function honestFeed(): PriceFeed {
  return {
    async getWindow(at) {
      const start = new Date(Math.floor(at.getTime() / 900_000) * 900_000);
      const end = new Date(start.getTime() + 900_000);
      return { timeStart: start.toISOString(), timeEnd: end.toISOString(), sekPerKwh: "1.00000" };
    },
  };
}

function freshJournal(): JsonlJournal {
  return new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-123-126-")), "decisions.jsonl"));
}

test("a chain reader records the paid ledger row and does not send that nonce", async () => {
  const journal = freshJournal();
  const sent: bigint[] = [];
  const result = await processWindow({
    at: new Date("2026-09-22T16:00:00Z"),
    feed: honestFeed(),
    journal,
    submit: async (_amount, nonce) => {
      sent.push(nonce);
      return { decision: "paid" as const, reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig-sent" };
    },
    ...BASE,
    reader: {
      chainLastNonce: async () => 0n,
      recoverSettled: async () => null,
      recordedCharge: async () => ({
        decision: "paid",
        reason: "ok",
        reasonCode: 0,
        suggestedOverride: null,
        signature: "sig-chain",
        amount: 50_000_000n,
      }),
    },
  });
  assert.deepEqual(sent, []);
  assert.equal(result, "submitted");
  const rows = journal.load();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "paid");
  assert.equal(rows[0]?.signature, "sig-chain");
});

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

function startRpc(args: {
  owner: PublicKey;
  ledger: Buffer | null;
}): Promise<{ url: string; readonly ledgerReads: number; readonly mandateReads: number; readonly methods: string[]; close: () => Promise<void> }> {
  const programId = new PublicKey(PROGRAM_ID);
  const mandate = mandatePda(programId, args.owner, 1n);
  const ledger = ledgerPda(programId, mandate);
  let ledgerReads = 0;
  let mandateReads = 0;
  const methods: string[] = [];
  const accountOf = (data: Buffer) => ({
    executable: false,
    owner: PROGRAM_ID,
    lamports: 1_000_000,
    data: [data.toString("base64"), "base64"],
    rentEpoch: 0,
  });
  const ok = (id: number | string, result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
  const handle = (req: RpcRequest): { status: number; body: unknown } => {
    methods.push(req.method);
    switch (req.method) {
      case "getAccountInfo": {
        const asked = String(req.params?.[0] ?? "");
        if (asked === ledger.toBase58()) {
          ledgerReads += 1;
          if (args.ledger === null) return ok(req.id, { context: { slot: 1 }, value: null });
          return ok(req.id, { context: { slot: 1 }, value: accountOf(args.ledger) });
        }
        if (asked === mandate.toBase58()) mandateReads += 1;
        return ok(req.id, { context: { slot: 1 }, value: accountOf(Buffer.alloc(232)) });
      }
      case "getLatestBlockhash":
      case "getRecentBlockhash":
        return ok(req.id, {
          context: { slot: 1 },
          value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10_000 },
        });
      case "getSignaturesForAddress":
        return ok(req.id, []);
      case "getTransaction":
        return ok(req.id, null);
      case "sendTransaction":
        return ok(req.id, "sig");
      case "getSignatureStatuses":
        return ok(req.id, { context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null, slot: 1 }] });
      default:
        return ok(req.id, null);
    }
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer | string) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      let parsed: RpcRequest | RpcRequest[];
      try {
        parsed = JSON.parse(raw) as RpcRequest | RpcRequest[];
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      const replies = (Array.isArray(parsed) ? parsed : [parsed]).map((item) => handle(item).body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        get ledgerReads() {
          return ledgerReads;
        },
        get mandateReads() {
          return mandateReads;
        },
        methods,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

function watcherEnv(args: { rpcUrl: string; owner: Keypair; agent: Keypair; journalPath: string; dir: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VETO_RPC: args.rpcUrl,
    VETO_PROGRAM_ID: PROGRAM_ID,
    VETO_MINT: Keypair.generate().publicKey.toBase58(),
    VETO_OWNER: args.owner.publicKey.toBase58(),
    VETO_OWNER_TOKEN: Keypair.generate().publicKey.toBase58(),
    VETO_MERCHANT: Keypair.generate().publicKey.toBase58(),
    VETO_MERCHANT_TOKEN: Keypair.generate().publicKey.toBase58(),
    VETO_AGENT: args.agent.publicKey.toBase58(),
    VETO_KEYS_DIR: args.dir,
    VETO_MANDATE_ID: "1",
    VETO_JOURNAL: args.journalPath,
    VETO_JOURNAL_GCS: "",
  };
}

function writeFeedStub(dir: string): string {
  const preload = join(dir, "stub-feed.mjs");
  const body = "[]";
  writeFileSync(
    preload,
    [
      `const FEED = "https://www.elprisetjustnu.se";`,
      `const body = ${JSON.stringify(body)};`,
      `const real = globalThis.fetch;`,
      `globalThis.fetch = (input, init) => {`,
      `  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;`,
      `  if (url.startsWith(FEED)) return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));`,
      `  return real(input, init);`,
      `};`,
      "",
    ].join("\n"),
  );
  return preload;
}

function paidRow(slot: Date): string {
  return JSON.stringify({
    ts: slot.toISOString(),
    window_start: slot.toISOString(),
    window_end: null,
    sek_per_kwh: "0.00892",
    kwh_milli: "50000",
    amount: "446000",
    nonce: nonceFromSlot(slot).toString(),
    decision: "paid",
    reason: "ok",
    reason_code: 0,
    signature: "already-paid",
    suggested_override: null,
  });
}

type ChildDone = { code: number | null; stdout: string; stderr: string };

function spawnWatcher(args: { dir: string; env: NodeJS.ProcessEnv; argv: string[]; stopOn?: string; timeoutMs: number }): Promise<ChildDone> {
  const preload = writeFeedStub(args.dir);
  const nodeArgs = ["--import", "tsx", "--import", pathToFileURL(preload).href, join(SRC_DIR, "index.ts"), ...args.argv];
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, nodeArgs, {
      cwd: WATCHER_DIR,
      env: args.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`watcher timed out\nstdout=${stdout}\nstderr=${stderr}`)));
    }, args.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (args.stopOn !== undefined && stdout.includes(args.stopOn)) {
        finish(() => resolve({ code: null, stdout, stderr }));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      finish(() => resolve({ code, stdout, stderr }));
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });
  });
}

test("an idle run cycle does not read the ledger when the journal already holds every due slot", { timeout: 20_000 }, async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const rpc = await startRpc({ owner: owner.publicKey, ledger: null });
  const dir = mkdtempSync(join(tmpdir(), "veto-123-idle-"));
  writeFileSync(join(dir, "agent.json"), JSON.stringify(Array.from(agent.secretKey)));
  const journalPath = join(dir, "decisions.jsonl");
  const now = new Date();
  const lines = dueSlots(now).map((slot) => paidRow(slot));
  writeFileSync(journalPath, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  try {
    const run = await spawnWatcher({
      dir,
      env: watcherEnv({ rpcUrl: rpc.url, owner, agent, journalPath, dir }),
      argv: ["run"],
      stopOn: "idle next=",
      timeoutMs: 15_000,
    });
    assert.equal(
      rpc.ledgerReads,
      0,
      `idle cycle read the ledger ${rpc.ledgerReads} time(s); methods=${rpc.methods.join(",")} stdout=${run.stdout} stderr=${run.stderr}`,
    );
    assert.match(run.stdout, /idle next=/);
  } finally {
    await rpc.close();
  }
});

test("once repairs a missing due slot from the ledger before it reads the mandate", { timeout: 20_000 }, async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const rpc = await startRpc({ owner: owner.publicKey, ledger: ledgerWithRefusal(WINDOW_NONCE) });
  const dir = mkdtempSync(join(tmpdir(), "veto-123-repair-"));
  writeFileSync(join(dir, "agent.json"), JSON.stringify(Array.from(agent.secretKey)));
  const journalPath = join(dir, "decisions.jsonl");
  try {
    const run = await spawnWatcher({
      dir,
      env: watcherEnv({ rpcUrl: rpc.url, owner, agent, journalPath, dir }),
      argv: ["once", "--window", WINDOW_START],
      timeoutMs: 15_000,
    });
    assert.equal(run.code, 0, `stderr=${run.stderr} stdout=${run.stdout}`);
    assert.ok(rpc.ledgerReads >= 1, "a missing due slot still reads the ledger");
    assert.equal(
      rpc.mandateReads,
      0,
      `the mandate was read ${rpc.mandateReads} time(s), so repair did not fill the journal first; methods=${rpc.methods.join(",")}`,
    );
    const journal = new JsonlJournal(journalPath);
    const rows = journal.load().filter((row) => row.nonce === WINDOW_NONCE.toString());
    assert.equal(rows.length, 1, JSON.stringify(journal.load()));
    assert.equal(rows[0]?.decision, "refused");
  } finally {
    await rpc.close();
  }
});
