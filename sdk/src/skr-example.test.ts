import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Connection } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { world, type MandateFields } from "./testkit.js";

let runId = 0;
const cases = [
  { name: "prints the required environment precheck", missingEnv: true, message: /Set VETO_RPC/, count: 0 },
  { name: "rejects an inactive rule before charging", patch: { status: 1 }, message: /must be active/, count: 0 },
  { name: "rejects an expired rule before charging", patch: { expiresAt: 1n }, message: /expired/, count: 0 },
  { name: "rejects a rule at its expiry second", patch: { expiresAt: 1_700_000_000n }, message: /expired/, count: 0 },
  { name: "prints the mint mismatch precheck", wrongMint: true, message: /does not match VETO_MINT/, count: 0 },
  { name: "prints the limits precheck", patch: { perTxMax: 1n }, message: /needs room for 8/, count: 0 },
  { name: "rejects a paid decision with a nonzero reason", reasons: [5, 5], message: /expected decision/, count: 1 },
  { name: "rejects a refusal for a reason other than the payment limit", reasons: [0, 3], message: /expected decision/, count: 2 },
  { name: "suppresses RPC errors containing credentials", rpcError: true, message: /SKR example failed/, count: 0 },
  { name: "accepts payment reason zero and refusal reason five", reasons: [0, 5], count: 2 },
] satisfies Array<{
  name: string; patch?: Partial<MandateFields>; missingEnv?: boolean; wrongMint?: boolean;
  reasons?: number[]; rpcError?: boolean; message?: RegExp; count: number;
}>;

for (const scenario of cases) {
  test(scenario.name, async (t) => {
    const w = world({ perTxMax: 10_000_000n, cap: 100_000_000n, spent: 0n,
      expiresAt: 1_900_000_000n, ...scenario.patch });
    const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
    const dir = mkdtempSync(join(tmpdir(), "skr-example-"));
    const keyFile = join(dir, "agent.json");
    writeFileSync(keyFile, JSON.stringify([...w.agent.secretKey]));
    const env = { ...process.env };
    const exitCode = process.exitCode;
    const errors: string[] = [];
    const lines: string[] = [];
    const amounts: bigint[] = [];
    t.after(() => {
      process.env = env;
      process.exitCode = exitCode;
      rmSync(dir, { recursive: true, force: true });
    });
    process.env.VETO_RPC = "https://example.invalid/private-rpc-token";
    process.env.VETO_RULE = w.mandate.toBase58();
    process.env.VETO_AGENT_KEY = keyFile;
    process.env.VETO_MINT = scenario.wrongMint ? w.agent.publicKey.toBase58() : w.mint.publicKey.toBase58();
    if (scenario.missingEnv) delete process.env.VETO_RPC;
    process.exitCode = 0;
    t.mock.method(Date, "now", () => 1_700_000_000_000);
    t.mock.method(console, "error", (line: string) => errors.push(line));
    t.mock.method(console, "log", (line: string) => lines.push(line));
    t.mock.method(VetoAgent, "fromMandate", async () => {
      if (scenario.rpcError) throw new Error(process.env.VETO_RPC);
      return veto;
    });
    t.mock.method(Connection.prototype, "getAccountInfo", w.connection.getAccountInfo.bind(w.connection));
    t.mock.method(veto, "charge", async ({ amount }: { amount: bigint }) => {
      amounts.push(amount);
      return { kind: amounts.length === 1 ? "paid" : "refused",
        reasonCode: (scenario.reasons ?? [0, 5])[amounts.length - 1],
        reasonText: "decision", signature: "test-signature", slot: 91 };
    });
    await import(`../examples/skr-once.js?run=${runId++}`);
    assert.equal(process.exitCode, scenario.message ? 1 : 0);
    if (scenario.message) assert.match(errors.join("\n"), scenario.message);
    else {
      assert.deepEqual(errors, []);
      assert.match(lines[0]!, /8 SKR paid 0/);
      assert.match(lines[1]!, /25 SKR refused 5/);
    }
    assert.deepEqual(amounts, [8_000_000n, 25_000_000n].slice(0, scenario.count));
    assert.doesNotMatch([...errors, ...lines].join("\n"), /example\.invalid|private-rpc-token/);
  });
}
