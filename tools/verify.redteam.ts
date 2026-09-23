// Security fixture for tools/verify.ts (issue #110, area 1). Read-only.
//
// Takes one genuine single record and one genuine bulk bundle, both exported by
// export.ts, mutates one field at a time, and runs verify.ts on the result. A
// mutation "holds" when verify rejects it (exit 1). A mutation that verify
// confirms (exit 0) is a tampered record that verifies, and is printed as FAIL.
//
// Run:
//   VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature <tx> --out /tmp/single.json
//   VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --mandate <addr> --out /tmp/bulk.json
//   VETO_RPC=https://api.devnet.solana.com npx tsx verify.redteam.ts /tmp/single.json /tmp/bulk.json
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS_DIR } from "./lib.js";

type Json = Record<string, unknown>;

const OTHER_PUBKEY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const OTHER_TOKEN_ACCOUNT = "CFNBvHYNENESCc5JYymYJhm2p7agHRUYDbf1Uqj2GKc8";
const OTHER_MANDATE = "7Bns2EMrzw9T8apGLRGynean4mkFMwHsEWoXbeTGnNtj";

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Public devnet rate-limits a burst of getTransaction calls. A rate-limited run
// is neither a confirm nor a reject, so it is retried and, if it never settles,
// reported as INCONCLUSIVE rather than counted as a hold.
function runVerify(text: string, name: string, dir: string): { code: number; out: string; settled: boolean } {
  const path = join(dir, `${name}.txt`);
  writeFileSync(path, text);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const r = spawnSync("npx", ["tsx", join(TOOLS_DIR, "verify.ts"), path], {
      encoding: "utf8",
      env: process.env,
    });
    const out = `${r.stdout}${r.stderr}`;
    if (!/rate limited|429/.test(out)) return { code: r.status ?? -1, out, settled: true };
    sleep(15000 * (attempt + 1));
  }
  return { code: -1, out: "rate limited on every attempt", settled: false };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function main(): void {
  const [singlePath, bulkPath] = process.argv.slice(2);
  if (!singlePath || !bulkPath) throw new Error("usage: verify.redteam.ts <single.json> <bulk.json>");
  if (!process.env.VETO_RPC) throw new Error("set VETO_RPC");
  const dir = mkdtempSync(join(tmpdir(), "veto-verify-redteam-"));
  const singleText = readFileSync(singlePath, "utf8");
  const bulkText = readFileSync(bulkPath, "utf8");
  const single = JSON.parse(singleText) as Json;
  const bulk = JSON.parse(bulkText) as Json & { decisions: Json[]; scope: Json };
  const limits = single.limits as Json;

  const cases: Array<[string, () => string, "single" | "bulk"]> = [];
  const mut = (name: string, f: (r: Json) => void): void => {
    cases.push([name, () => { const r = clone(single); f(r); return `${JSON.stringify(r, null, 2)}\n`; }, "single"]);
  };

  mut("control: untouched record", () => {});
  mut("cluster -> mainnet-beta", (r) => { r.cluster = "mainnet-beta"; });
  mut("genesis_hash -> other", (r) => { r.genesis_hash = "5NrLCg7BRzhkDYxbiDy966tfYmVPfpprZamwXLALe3L5"; });
  mut("program_id -> other program", (r) => { r.program_id = OTHER_PUBKEY; });
  mut("mandate -> the second devnet mandate", (r) => { r.mandate = OTHER_MANDATE; });
  mut("limits.cap +1", (r) => { (r.limits as Json).cap = Number(limits.cap) + 1; });
  mut("limits.per_tx_max x10", (r) => { (r.limits as Json).per_tx_max = Number(limits.per_tx_max) * 10; });
  mut("limits.expires_at +1", (r) => { (r.limits as Json).expires_at = Number(limits.expires_at) + 1; });
  mut("limits.merchant -> other", (r) => { (r.limits as Json).merchant = OTHER_PUBKEY; });
  mut("limits.purpose -> other", (r) => { (r.limits as Json).purpose = "groceries"; });
  mut("kind flipped, nothing else", (r) => { r.kind = r.kind === "paid" ? "refused" : "paid"; });
  mut("kind flipped to paid with consistent reason fields", (r) => {
    r.kind = "paid"; r.reason_code = 0; r.reason_text = "ok"; r.suggested_override = 0;
  });
  mut("amount -> 1", (r) => { r.amount = 1; });
  mut("counterparty -> other token account", (r) => { r.counterparty = OTHER_TOKEN_ACCOUNT; });
  mut("timestamp +1", (r) => { r.timestamp = Number(single.timestamp) + 1; });
  mut("timestamp -> 0", (r) => { r.timestamp = 0; });
  mut("nonce +1", (r) => { r.nonce = Number(single.nonce) + 1; });
  mut("reason_code -> 6 with canonical text", (r) => { r.reason_code = 6; r.reason_text = "over remaining cap"; });
  mut("reason_code -> 6, text unchanged", (r) => { r.reason_code = 6; });
  mut("reason_text -> ok", (r) => { r.reason_text = "ok"; });
  mut("suggested_override -> 0", (r) => { r.suggested_override = 0; });
  mut("suggested_override -> 1", (r) => { r.suggested_override = 1; });
  mut("signature -> another genuine refusal on the same mandate", (r) => {
    r.signature = "5MJLtM92foysaWgfqs6x6oBYxyES2Ra2st8UK47dRX8h1F2wo43qQxJt4GFycEWiLSKJQjWbUBhotHMhkHymLoBU";
  });
  mut("signature -> not a transaction", (r) => { r.signature = "1".repeat(87); });
  mut("schema_version -> 2", (r) => { r.schema_version = 2; });
  cases.push(["file truncated at half", () => singleText.slice(0, Math.floor(singleText.length / 2)), "single"]);
  cases.push(["control: file with keys re-ordered", () => {
    const entries = Object.entries(single).reverse();
    return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
  }, "single"]);
  cases.push(["json with amount duplicated (last wins)", () => {
    return singleText.replace(/"amount": (\d+)/, '"amount": $1, "amount": 1');
  }, "single"]);

  const bmut = (name: string, f: (b: typeof bulk) => void): void => {
    cases.push([name, () => { const b = clone(bulk); f(b); return `${JSON.stringify(b, null, 2)}\n`; }, "bulk"]);
  };
  const paidIdx = bulk.decisions.findIndex((d) => d.kind === "paid");
  bmut("bulk control: untouched bundle", () => {});
  bmut("bulk: one paid row deleted", (b) => { if (paidIdx >= 0) b.decisions.splice(paidIdx, 1); });
  bmut("bulk: every row but one deleted", (b) => { b.decisions = b.decisions.slice(0, 1); });
  bmut("bulk control: rows re-ordered", (b) => { b.decisions.reverse(); });
  bmut("bulk: one row duplicated", (b) => { b.decisions.push(clone(b.decisions[0]!)); });
  bmut("bulk: scope.mandate relabelled to another mandate", (b) => { b.scope.mandate = OTHER_MANDATE; });
  bmut("bulk: envelope cluster -> mainnet-beta", (b) => { b.cluster = "mainnet-beta"; });
  bmut("bulk: envelope genesis_hash -> other", (b) => { b.genesis_hash = "5NrLCg7BRzhkDYxbiDy966tfYmVPfpprZamwXLALe3L5"; });
  bmut("bulk: envelope program_id -> other", (b) => { b.program_id = OTHER_PUBKEY; });
  bmut("bulk: completeness -> attempts", (b) => { b.completeness = "attempts"; });
  bmut("bulk: scope.type -> date_range covering nothing", (b) => { b.scope = { type: "date_range", mandate: null, from: 1, to: 2 }; });
  bmut("bulk: one row's amount -> 1", (b) => { b.decisions[0]!.amount = 1; });
  bmut("bulk: decisions emptied", (b) => { b.decisions = []; });
  cases.push(["bulk: file truncated at half", () => bulkText.slice(0, Math.floor(bulkText.length / 2)), "bulk"]);

  let tamperedConfirmed = 0;
  let inconclusive = 0;
  for (const [i, [name, make, kind]] of cases.entries()) {
    const isControl = name.startsWith("control") || name.startsWith("bulk control");
    const r = runVerify(make(), `case-${i}`, dir);
    sleep(3000);
    if (!r.settled) {
      inconclusive += 1;
      console.log(`INCONCLUSIVE  [${kind}] ${name}  ->  ${r.out}`);
      continue;
    }
    const confirmed = r.code === 0;
    const holds = isControl ? confirmed : !confirmed;
    if (!holds) tamperedConfirmed += 1;
    const verdictLine = r.out.split("\n").find((l) => l.startsWith("VERDICT") || l.startsWith("verify failed")) ?? `exit ${r.code}`;
    console.log(`${holds ? "HOLDS" : "FAIL "}  [${kind}] ${name}  ->  ${verdictLine} (exit ${r.code})`);
  }
  if (tamperedConfirmed > 0 || inconclusive > 0) {
    console.error(`${tamperedConfirmed} tampered file(s) verified or control failed, ${inconclusive} inconclusive`);
    process.exit(1);
  }
  console.log("every tampered file was rejected");
}

main();
