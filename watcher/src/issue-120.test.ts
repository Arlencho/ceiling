// Issue 120. The verification comment on issue 110 started the watcher with
// VETO_RPC=https://rpc.example.test/?api-key=SECRET123 and the first log line
// contained that key. A second URL with userinfo covers the same redaction.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeFailoverFetch } from "./rpc.js";

const WATCHER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const KEYED = "https://rpc.example.test/?api-key=SECRET123";
const WITH_USERINFO = "https://user:SECRET123@rpc.example.test/v1?api-key=SECRET123";

test("issue 120: a keyed RPC URL is logged without its query string or userinfo", async () => {
  const lines: string[] = [];
  let fetched = "";
  const failover = makeFailoverFetch([WITH_USERINFO], (line) => lines.push(line), {
    fetch: async (input) => {
      fetched = String(input);
      return new Response("no", { status: 429 });
    },
    sleep: async () => {},
    initialDelayMs: 0,
    maxPasses: 1,
  });
  await assert.rejects(() => failover(WITH_USERINFO, { method: "POST" }));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.equal(line.includes("SECRET123"), false, line);
    assert.equal(line.includes("user:"), false, line);
    assert.equal(line.includes("api-key"), false, line);
  }
  assert.match(lines.join("\n"), /https:\/\/rpc\.example\.test\/v1/);
  assert.equal(fetched.includes("SECRET123"), true, "the request itself still carries the key");

  const dir = mkdtempSync(join(tmpdir(), "veto-issue-120-"));
  const child = spawn(join(WATCHER_DIR, "node_modules", ".bin", "tsx"), ["src/index.ts", "run"], {
    cwd: WATCHER_DIR,
    env: {
      ...process.env,
      VETO_RPC: KEYED,
      VETO_PROGRAM_ID: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
      VETO_MINT: "2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU",
      VETO_OWNER: "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc",
      VETO_OWNER_TOKEN: "FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE",
      VETO_MERCHANT: "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG",
      VETO_MERCHANT_TOKEN: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
      VETO_AGENT: "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w",
      VETO_KEYS_DIR: dir,
      VETO_JOURNAL: join(dir, "decisions.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    err += chunk;
  });
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`watcher did not exit\nstdout:\n${out}\nstderr:\n${err}`));
    }, 20000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(status ?? -1);
    });
  });
  const start = out.split("\n").find((line) => line.includes("watcher start"));
  assert.ok(start, `no start line (exit ${code})\nstdout:\n${out}\nstderr:\n${err}`);
  assert.equal(start.includes("SECRET123"), false, start);
  assert.equal(start.includes("api-key"), false, start);
  assert.match(start, /watcher start rpc=https:\/\/rpc\.example\.test\b/);
});
