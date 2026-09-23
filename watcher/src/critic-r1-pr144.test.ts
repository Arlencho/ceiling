/** Critic round 1 fixture for PR 144 (issues 123 and 126).
 *
 * 1. A day file that lists a wider overlapping window ahead of the slot window
 *    pays the slot once, under the slot nonce, at the slot window's price. A
 *    restart with a fresh journal does not pay it again or under a second nonce.
 * 2. An idle pass of `run` with every due slot already in the journal makes no
 *    RPC request at all, not only no ledger read.
 * 3. A chain-backed processWindow call without recordedCharge must not
 *    type-check. The probes cover the literal flat shape, a reader missing
 *    recordedCharge, the full reader (must pass), and a non-literal legacy
 *    object, which escapes the excess-property check.
 * 4. Two `once --window` runs with fresh journals against a ledger holding a
 *    refusal for that nonce send nothing.
 *
 * Round 2 removed the legacy two-process probe: it pinned the behaviour of a
 * shape the parameter type forbids. critic-r2-pr144.test.ts holds the
 * replacement.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { dueSlots, nextSlot } from "./cadence.js";
import { ledgerPda, mandatePda, type RecoveredCharge } from "./chain.js";
import { EnergySpotFeed } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import { nonceFromSlot } from "./nonce.js";
import { REASON_OVER_PER_TX_MAX } from "./reasons.js";
import { processWindow } from "./run.js";

const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));
const WATCHER_DIR = join(SRC_DIR, "..");
const PROGRAM_ID = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
const WINDOW_START = "2026-09-20T00:00:00+02:00";
const WINDOW_NONCE = 1789855200n;

const BASE = { kwhMilli: 50_000n, mintDecimals: 6, log: () => {}, feedAttempts: 1, feedRetryMs: 0 };

function freshJournal(tag: string): JsonlJournal {
  return new JsonlJournal(join(mkdtempSync(join(tmpdir(), `veto-r1-144-${tag}-`)), "decisions.jsonl"));
}

// ---------------------------------------------------------------------------
// 1. Day file with the wider window listed first, through EnergySpotFeed.
// ---------------------------------------------------------------------------
const SLOT_UTC = "2026-09-22T16:00:00Z"; // 18:00 Stockholm, a cadence slot
const SLOT_NONCE = 1790092800n;
const DAY_FILE = JSON.stringify([
  { SEK_per_kWh: 0.5, EUR_per_kWh: 0.045, EXR: 11.1, time_start: "2026-09-22T17:45:00+02:00", time_end: "2026-09-22T18:15:00+02:00" },
  { SEK_per_kWh: 0.00892, EUR_per_kWh: 0.0008, EXR: 11.1, time_start: "2026-09-22T18:00:00+02:00", time_end: "2026-09-22T18:15:00+02:00" },
]);

function dayFileFeed(): EnergySpotFeed {
  const fetchImpl: typeof fetch = async () => new Response(DAY_FILE, { status: 200, headers: { "content-type": "application/json" } });
  return new EnergySpotFeed(fetchImpl);
}

test("critic r1 PR 144: a day file with a wider window listed first pays the slot once under the slot nonce", async () => {
  const feed = dayFileFeed();
  const journal = freshJournal("wider");
  const sent: bigint[] = [];
  // A fake chain: last_nonce and the ledger row follow what was sent.
  let lastNonce = 0n;
  const ledger = new Map<bigint, RecoveredCharge>();
  const reader = {
    chainLastNonce: async () => lastNonce,
    recoverSettled: async (nonce: bigint) => ledger.get(nonce) ?? null,
    recordedCharge: async (nonce: bigint) => ledger.get(nonce) ?? null,
  };
  const submit = async (amount: bigint, nonce: bigint) => {
    sent.push(nonce);
    lastNonce = nonce;
    const receipt = { decision: "paid" as const, reason: "ok", reasonCode: 0, suggestedOverride: null, signature: `sig-${nonce}` };
    ledger.set(nonce, { ...receipt, amount });
    return receipt;
  };
  const results: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    results.push(await processWindow({ at: new Date(SLOT_UTC), feed, journal, submit, ...BASE, reader }));
  }
  assert.deepEqual(results, ["submitted", "skipped", "skipped"]);
  assert.deepEqual(sent, [SLOT_NONCE]);
  const paid = journal.load().filter((r) => r.decision === "paid");
  assert.equal(paid.length, 1);
  assert.equal(paid[0]?.nonce, SLOT_NONCE.toString());
  assert.equal(paid[0]?.sek_per_kwh, "0.00892", "the slot window's price, not the wider window's");
  assert.equal(paid[0]?.window_start, "2026-09-22T18:00:00+02:00");
  assert.equal(journal.load().filter((r) => r.decision === "gap").length, 0);

  // Restart: a fresh journal against the same chain. No second send, no second nonce.
  const afterRestart = freshJournal("wider-restart");
  const again = await processWindow({ at: new Date(SLOT_UTC), feed, journal: afterRestart, submit, ...BASE, reader });
  assert.equal(again, "submitted", "recovered from chain counts as submitted");
  assert.deepEqual(sent, [SLOT_NONCE], "restart must not send again");
  const recovered = afterRestart.load();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.decision, "paid");
  assert.equal(recovered[0]?.nonce, SLOT_NONCE.toString());
  assert.equal(new Set(sent.map(String)).size, 1, "exactly one nonce for the slot");
});

// ---------------------------------------------------------------------------
// Fake RPC and watcher spawn helpers.
// ---------------------------------------------------------------------------
function ledgerWithRefusal(nonce: bigint): Buffer {
  const body = Buffer.alloc(40 + 72);
  body.writeUInt32LE(1, 32);
  const row = body.subarray(40, 112);
  row.writeBigInt64LE(1_789_855_210n, 0);
  row.writeBigUInt64LE(446_000n, 8);
  row.writeBigUInt64LE(nonce, 48);
  row.writeBigUInt64LE(446_000n, 56);
  row[64] = 2;
  row[65] = REASON_OVER_PER_TX_MAX;
  return Buffer.concat([LEDGER_DISCRIMINATOR, body]);
}

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params: unknown[] };

type FakeRpc = {
  url: string;
  readonly requests: number;
  readonly ledgerReads: number;
  readonly sends: number;
  readonly methods: string[];
  close: () => Promise<void>;
};

function startRpc(args: { owner: PublicKey; ledger: Buffer | null }): Promise<FakeRpc> {
  const programId = new PublicKey(PROGRAM_ID);
  const mandate = mandatePda(programId, args.owner, 1n);
  const ledger = ledgerPda(programId, mandate);
  let requests = 0;
  let ledgerReads = 0;
  let sends = 0;
  const methods: string[] = [];
  const accountOf = (data: Buffer) => ({
    executable: false,
    owner: PROGRAM_ID,
    lamports: 1_000_000,
    data: [data.toString("base64"), "base64"],
    rentEpoch: 0,
  });
  const ok = (id: number | string, result: unknown) => ({ jsonrpc: "2.0", id, result });
  const handle = (req: RpcRequest): unknown => {
    requests += 1;
    methods.push(req.method);
    switch (req.method) {
      case "getAccountInfo": {
        const asked = String(req.params?.[0] ?? "");
        if (asked === ledger.toBase58()) {
          ledgerReads += 1;
          if (args.ledger === null) return ok(req.id, { context: { slot: 1 }, value: null });
          return ok(req.id, { context: { slot: 1 }, value: accountOf(args.ledger) });
        }
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
        sends += 1;
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
      const replies = (Array.isArray(parsed) ? parsed : [parsed]).map((item) => handle(item));
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
        get requests() {
          return requests;
        },
        get ledgerReads() {
          return ledgerReads;
        },
        get sends() {
          return sends;
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
  writeFileSync(
    preload,
    [
      `const FEED = "https://www.elprisetjustnu.se";`,
      `const real = globalThis.fetch;`,
      `globalThis.fetch = (input, init) => {`,
      `  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;`,
      `  if (url.startsWith(FEED)) return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));`,
      `  return real(input, init);`,
      `};`,
      "",
    ].join("\n"),
  );
  return preload;
}

type ChildDone = { code: number | null; stdout: string; stderr: string };

function spawnNode(args: { cwd: string; env: NodeJS.ProcessEnv; nodeArgs: string[]; stopOn?: string; timeoutMs: number }): Promise<ChildDone> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, args.nodeArgs, {
      cwd: args.cwd,
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
      finish(() => reject(new Error(`child timed out\nstdout=${stdout}\nstderr=${stderr}`)));
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
    child.on("exit", (code) => finish(() => resolve({ code, stdout, stderr })));
    child.on("error", (err) => finish(() => reject(err)));
  });
}

function spawnWatcher(args: { dir: string; env: NodeJS.ProcessEnv; argv: string[]; stopOn?: string; timeoutMs: number }): Promise<ChildDone> {
  const preload = writeFeedStub(args.dir);
  return spawnNode({
    cwd: WATCHER_DIR,
    env: args.env,
    nodeArgs: ["--import", "tsx", "--import", pathToFileURL(preload).href, join(SRC_DIR, "index.ts"), ...args.argv],
    stopOn: args.stopOn,
    timeoutMs: args.timeoutMs,
  });
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

// ---------------------------------------------------------------------------
// 2. Idle run cycle: zero RPC requests of any kind.
// ---------------------------------------------------------------------------
test("critic r1 PR 144: an idle run cycle makes no RPC request at all", { timeout: 20_000 }, async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const rpc = await startRpc({ owner: owner.publicKey, ledger: null });
  const dir = mkdtempSync(join(tmpdir(), "veto-r1-144-idle-"));
  writeFileSync(join(dir, "agent.json"), JSON.stringify(Array.from(agent.secretKey)));
  const journalPath = join(dir, "decisions.jsonl");
  const now = new Date();
  // Every due slot, plus the next one so a slot boundary crossed while the
  // child starts does not turn this into a due cycle.
  const lines = [...dueSlots(now), nextSlot(now)].map((slot) => paidRow(slot));
  writeFileSync(journalPath, `${lines.join("\n")}\n`);
  try {
    const run = await spawnWatcher({
      dir,
      env: watcherEnv({ rpcUrl: rpc.url, owner, agent, journalPath, dir }),
      argv: ["run"],
      stopOn: "idle next=",
      timeoutMs: 15_000,
    });
    assert.match(run.stdout, /idle next=/);
    assert.equal(rpc.requests, 0, `idle cycle made ${rpc.requests} RPC request(s): ${rpc.methods.join(",")}\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  } finally {
    await rpc.close();
  }
});

// ---------------------------------------------------------------------------
// 3. tsc probes. Compiled in one tsc run in file mode with the project's
//    strictness; errors are attributed per probe file.
// ---------------------------------------------------------------------------
const PROBE_HEAD = [
  `import type { ChargeReceipt } from "./chain.js";`,
  `import type { PriceFeed } from "./feed.js";`,
  `import type { JsonlJournal } from "./journal.js";`,
  `import { processWindow } from "./run.js";`,
  `declare const feed: PriceFeed;`,
  `declare const journal: JsonlJournal;`,
  `declare const submit: (amount: bigint, nonce: bigint) => Promise<ChargeReceipt>;`,
  `const chainLastNonce = async (): Promise<bigint> => 0n;`,
  `const recoverSettled = async (_nonce: bigint) => null;`,
  `const recordedCharge = async (_nonce: bigint) => null;`,
  `const fields = { at: new Date(), feed, journal, submit, kwhMilli: 1n, mintDecimals: 6 };`,
].join("\n");

const PROBES: Record<string, { body: string; mustCompile: boolean }> = {
  "flat-literal": {
    body: `void processWindow({ ...fields, chainLastNonce, recoverSettled });`,
    mustCompile: false,
  },
  "reader-missing-recorded": {
    body: `void processWindow({ ...fields, reader: { chainLastNonce, recoverSettled } });`,
    mustCompile: false,
  },
  "reader-full": {
    body: `void processWindow({ ...fields, reader: { chainLastNonce, recoverSettled, recordedCharge } });`,
    mustCompile: true,
  },
  "flat-non-literal": {
    body: `const legacy = { ...fields, chainLastNonce, recoverSettled };\nvoid processWindow(legacy);`,
    mustCompile: false,
  },
};

function runTsc(names: string[]): Map<string, string[]> {
  const files = names.map((name) => {
    const file = `zz-critic-r1-pr144-probe-${name}.ts`;
    writeFileSync(join(SRC_DIR, file), `${PROBE_HEAD}\n${PROBES[name]?.body ?? ""}\n`);
    return file;
  });
  try {
    const out = spawnSync(
      join(WATCHER_DIR, "node_modules", ".bin", "tsc"),
      [
        "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--module", "NodeNext", "--moduleResolution", "NodeNext",
        "--target", "ES2022", "--types", "node", "--skipLibCheck", "--verbatimModuleSyntax", "--esModuleInterop",
        ...files.map((f) => join("src", f)),
      ],
      { cwd: WATCHER_DIR, encoding: "utf8", timeout: 120_000 },
    );
    const errors = new Map<string, string[]>();
    for (const name of names) errors.set(name, []);
    for (const line of `${out.stdout}\n${out.stderr}`.split("\n")) {
      const m = /zz-critic-r1-pr144-probe-([a-z-]+)\.ts\(\d+,\d+\): error (TS\d+: .*)$/.exec(line);
      if (m && m[1] !== undefined && m[2] !== undefined) errors.get(m[1])?.push(m[2]);
      else if (/error TS\d+/.test(line)) throw new Error(`unattributed tsc error: ${line}`);
    }
    return errors;
  } finally {
    for (const file of files) rmSync(join(SRC_DIR, file), { force: true });
  }
}

test("critic r1 PR 144: tsc rejects a chain-backed call without recordedCharge and accepts the full reader", { timeout: 120_000 }, () => {
  const names = ["flat-literal", "reader-missing-recorded", "reader-full"];
  const errors = runTsc(names);
  for (const name of names) {
    const found = errors.get(name) ?? [];
    if (PROBES[name]?.mustCompile) assert.deepEqual(found, [], `${name} must compile`);
    else assert.ok(found.length > 0, `${name} must not compile`);
  }
});

test("critic r1 PR 144: tsc rejects a non-literal legacy object carrying chainLastNonce without recordedCharge", { timeout: 120_000 }, () => {
  const errors = runTsc(["flat-non-literal"]);
  const found = errors.get("flat-non-literal") ?? [];
  assert.ok(found.length > 0, "a non-literal object escapes the excess-property check, so the shape still type-checks and run.ts:144 still reads it");
});

// ---------------------------------------------------------------------------
// 4. Restart with the production shape: a refused nonce is not resubmitted.
// ---------------------------------------------------------------------------
test("critic r1 PR 144: two once --window runs with fresh journals against a refusal ledger send nothing", { timeout: 40_000 }, async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const rpc = await startRpc({ owner: owner.publicKey, ledger: ledgerWithRefusal(WINDOW_NONCE) });
  try {
    for (const tag of ["first", "second"]) {
      const dir = mkdtempSync(join(tmpdir(), `veto-r1-144-restart-${tag}-`));
      writeFileSync(join(dir, "agent.json"), JSON.stringify(Array.from(agent.secretKey)));
      const journalPath = join(dir, "decisions.jsonl");
      const run = await spawnWatcher({
        dir,
        env: watcherEnv({ rpcUrl: rpc.url, owner, agent, journalPath, dir }),
        argv: ["once", "--window", WINDOW_START],
        timeoutMs: 15_000,
      });
      assert.equal(run.code, 0, `${tag}: stderr=${run.stderr} stdout=${run.stdout}`);
      const rows = new JsonlJournal(journalPath).load().filter((row) => row.nonce === WINDOW_NONCE.toString());
      assert.equal(rows.length, 1, `${tag}: ${JSON.stringify(rows)}`);
      assert.equal(rows[0]?.decision, "refused", tag);
    }
    assert.equal(rpc.sends, 0, `sendTransaction was called ${rpc.sends} time(s); methods=${rpc.methods.join(",")}`);
  } finally {
    await rpc.close();
  }
});
