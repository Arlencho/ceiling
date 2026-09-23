/** Critic round 2 fixture for PR 144 (issue 126).
 *
 * Round 1 asked that a refused nonce not be held in process state reachable
 * through a shape the type forbids. Head 8527a53 removed the in-process map
 * and replaced it with files under os.tmpdir()/veto-legacy-window-refusal,
 * keyed by a hash of process.argv and the nonce, written and read only when
 * the untyped argument carries a flat chainLastNonce.
 *
 * A. After a legacy flat call whose submit is refused, nothing may exist on
 *    the host for that process's argv scope. Refusal state belongs to the
 *    chain reader, not to a directory beside the entry script.
 * B. A key outside the parameter type must be inert. Two processes with the
 *    flat shape and two with the bare shape (no reader at all), same entry
 *    script, must send the same nonces. On head the second flat process
 *    sends nothing and journals a refused row with a signature it never
 *    received, while the second bare process submits.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REASON_OVER_PER_TX_MAX } from "./reasons.js";

const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));
const WATCHER_DIR = join(SRC_DIR, "..");
const SLOT_UTC = "2026-09-22T16:00:00Z";
const SLOT_NONCE = "1790092800";
const STORE = join(tmpdir(), "veto-legacy-window-refusal");

type Shape = "flat" | "bare";
type Out = { pid: number; argv: string[]; result: string; sent: string[]; rows: { decision: string; signature: string | null }[] };

function script(shape: Shape): string {
  const flat = shape === "flat" ? "chainLastNonce: async () => 0n," : "";
  return `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlJournal } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "journal.ts")).href)};
import { processWindow } from ${JSON.stringify(pathToFileURL(join(SRC_DIR, "run.ts")).href)};
const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-r2-144-${shape}-")), "decisions.jsonl"));
const sent = [];
const result = await processWindow({
  at: new Date(${JSON.stringify(SLOT_UTC)}),
  feed: { async getWindow(at) { return { timeStart: at.toISOString(), timeEnd: new Date(at.getTime() + 900000).toISOString(), sekPerKwh: "1.00000" }; } },
  journal,
  submit: async (_amount, nonce) => {
    sent.push(nonce.toString());
    return { decision: "refused", reason: "over per-payment maximum", reasonCode: ${REASON_OVER_PER_TX_MAX}, suggestedOverride: null, signature: "sig-from-submit-" + process.pid };
  },
  kwhMilli: 50000n, mintDecimals: 6, log: () => {}, feedAttempts: 1, feedRetryMs: 0,
  ${flat}
});
const rows = journal.load().map((r) => ({ decision: r.decision, signature: r.signature }));
process.stdout.write(JSON.stringify({ pid: process.pid, argv: process.argv, result, sent, rows }) + "\\n");
`;
}

function spawnScript(file: string): Promise<Out> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", file], { cwd: WATCHER_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child timed out\nstdout=${stdout}\nstderr=${stderr}`));
    }, 15_000);
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}\nstderr=${stderr}`));
      else resolve(JSON.parse(stdout.trim()) as Out);
    });
  });
}

// run.ts:92 hashes process.argv.slice(1) joined by NUL.
function scopeDir(argv: string[]): string {
  return join(STORE, createHash("sha256").update(argv.slice(1).join("\0")).digest("hex"));
}

test("critic r2 PR 144: a legacy flat refusal leaves no refusal state on the host", { timeout: 40_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "veto-r2-144-a-"));
  const file = join(dir, "flat.mjs");
  writeFileSync(file, script("flat"));
  const before = existsSync(STORE) ? readdirSync(STORE).length : 0;
  const out = await spawnScript(file);
  const scope = scopeDir(out.argv);
  try {
    assert.deepEqual(out.sent, [SLOT_NONCE]);
    const after = existsSync(STORE) ? readdirSync(STORE).length : 0;
    assert.equal(after, before, `${STORE} gained ${after - before} scope director(ies)`);
    assert.equal(existsSync(scope), false, `refusal state written outside the process: ${scope}/${SLOT_NONCE}.json`);
  } finally {
    rmSync(scope, { recursive: true, force: true });
  }
});

test("critic r2 PR 144: a key outside the parameter type is inert: flat and bare shapes send the same nonces", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "veto-r2-144-b-"));
  const sent: Record<Shape, string[][]> = { flat: [], bare: [] };
  const rows: Record<Shape, Out["rows"][]> = { flat: [], bare: [] };
  const scopes: string[] = [];
  try {
    for (const shape of ["flat", "bare"] as const) {
      const file = join(dir, `${shape}.mjs`);
      writeFileSync(file, script(shape));
      for (let i = 0; i < 2; i += 1) {
        const out = await spawnScript(file);
        scopes.push(scopeDir(out.argv));
        sent[shape].push(out.sent);
        rows[shape].push(out.rows);
      }
    }
    assert.deepEqual(sent.bare, [[SLOT_NONCE], [SLOT_NONCE]], "a caller with no reader submits from each fresh journal");
    assert.deepEqual(sent.flat, sent.bare, `the flat chainLastNonce key changed behaviour: flat=${JSON.stringify(sent.flat)} bare=${JSON.stringify(sent.bare)} rows=${JSON.stringify(rows.flat)}`);
  } finally {
    for (const scope of scopes) rmSync(scope, { recursive: true, force: true });
  }
});
