// Issue 186. The documented pipe is a slow writer (export talks to RPC
// before it prints) into verify with no path argument. Touching stdin and
// then readFileSync(0) throws EAGAIN on that pipe and verify prints a false
// REJECTED. This runs the real pipe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { mandatePda, parseRecord, reasonText, recordToJson } from "./lib.js";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

function recordFile(): string {
  const mandate = mandatePda(PROGRAM, OWNER, 186n);
  const record = parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: {
      cap: 1_000_000,
      per_tx_max: 500_000,
      expires_at: 1_797_713_870,
      merchant: MERCHANT.toBase58(),
      purpose: "pipe",
    },
    kind: "paid",
    amount: 10,
    counterparty: DEST.toBase58(),
    timestamp: 1_790_117_960,
    nonce: 1,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature: "5".repeat(87),
  });
  const dir = mkdtempSync(join(tmpdir(), "veto-issue-186-"));
  const file = join(dir, "record.json");
  writeFileSync(file, recordToJson(record));
  return file;
}

function listen(): Promise<{ server: Server; url: string; hits: () => number }> {
  let n = 0;
  const server = createServer((_req, res) => {
    n += 1;
    res.statusCode = 502;
    res.end("<html>502 Bad Gateway</html>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ server, url: `http://127.0.0.1:${address.port}`, hits: () => n });
    });
  });
}

test("a slow pipe into verify does not print a false REJECTED", async () => {
  const file = recordFile();
  const { server, url, hits } = await listen();
  const env = { ...process.env };
  delete env.VETO_RPC;
  delete env.VETO_PROGRAM_ID;
  try {
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      // sleep, then cat: the writer has not produced bytes when verify starts,
      // which is what export | verify does while export is still on RPC.
      const producer = spawn("sh", ["-c", 'sleep 1; cat "$1"', "sh", file]);
      const verify = spawn(process.execPath, ["--import", "tsx", "verify.ts", "--rpc", url], {
        cwd: TOOLS_DIR,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      producer.stdout.pipe(verify.stdin);
      producer.stderr.on("data", () => {});
      let stdout = "";
      let stderr = "";
      verify.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      verify.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        producer.kill("SIGKILL");
        verify.kill("SIGKILL");
      }, 20_000);
      verify.on("error", reject);
      producer.on("error", reject);
      verify.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
    const combined = `${run.stdout}\n${run.stderr}`;
    assert.equal(hits() > 0, true, `verify never reached RPC\n${combined}`);
    assert.doesNotMatch(combined, /EAGAIN/);
    assert.doesNotMatch(combined, /not valid schema/);
    assert.doesNotMatch(run.stdout, /VERDICT: REJECTED/);
    assert.equal(run.status, 3, combined);
  } finally {
    server.close();
  }
});
