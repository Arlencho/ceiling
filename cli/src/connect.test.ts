import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseRuleRequest } from "@veto-hq/agent-sdk";
import { GENESIS } from "./cluster.js";
import { run } from "./commands.js";
import { agentFile, configFile, writeKeyFile } from "./files.js";
import { DEVNET_USDC_MINT, MCP_CONFIG_LINE } from "./money.js";
import { renderQr } from "./qr.js";
import {
  airdropsOf,
  chainOf,
  harness,
  openedWorld,
  output,
  plantForeignAgent,
  removeHome,
  retargetMint,
  tempHome,
} from "./testkit.js";
import { Keypair } from "./web3.js";

const EXPIRES = 1793750400n;
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function agentKey(home: string, secret: Uint8Array): Promise<string[]> {
  const keyFile = resolve(home, "agent.json");
  await writeKeyFile(keyFile, secret);
  return ["--key", keyFile];
}

test("connect prints the agent address and that the key stays on this machine", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const keyFile = resolve(home, "agent.json");
    await writeKeyFile(keyFile, w.agent.secretKey);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["connect", "--key", keyFile, "--rule", w.mandate.toBase58()], runtime);
    assert.equal(code, 0);
    const text = output(runtime);
    assert.ok(text.includes(`Agent ${w.agent.publicKey.toBase58()}`));
    assert.ok(text.includes("This key lives on your machine. Veto never holds it."));
  } finally {
    removeHome(home);
  }
});

test("connect writes the new key with mode 0600", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const payee = Keypair.generate().publicKey.toBase58();
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(
      ["connect", "--payee", payee, "--max", "1", "--cap", "2", "--days", "1", "--purpose", "fees"],
      runtime,
    );
    assert.equal(code, 1);
    assert.equal(statSync(agentFile(home)).mode & 0o777, 0o600);
    const body = readFileSync(agentFile(home), "utf8").trim();
    assert.equal(output(runtime).includes(body), false);
  } finally {
    removeHome(home);
  }
});

test("connect reuses --key and does not write a second secret", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const keyFile = resolve(home, "agent.json");
    await writeKeyFile(keyFile, w.agent.secretKey);
    const before = readFileSync(keyFile, "utf8");
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["connect", "--key", keyFile, "--rule", w.mandate.toBase58()], runtime);
    assert.equal(code, 0);
    assert.equal(readFileSync(keyFile, "utf8"), before);
    assert.equal(existsSync(agentFile(home)), false);
    const saved = JSON.parse(readFileSync(configFile(home), "utf8")) as { key: string };
    assert.equal(saved.key, keyFile);
    assert.ok(output(runtime).includes(`Agent ${w.agent.publicKey.toBase58()}`));
  } finally {
    removeHome(home);
  }
});

test("connect reuses the key already on this machine", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    await writeKeyFile(agentFile(home), w.agent.secretKey);
    const first = readFileSync(agentFile(home), "utf8");
    const runtime = harness(home, chainOf(w.fake));
    assert.equal(await run(["connect", "--rule", w.mandate.toBase58()], runtime), 0);
    const again = harness(home, chainOf(w.fake));
    assert.equal(await run(["connect", "--rule", w.mandate.toBase58()], again), 0);
    assert.equal(readFileSync(agentFile(home), "utf8"), first);
    assert.ok(output(again).includes(`Agent ${w.agent.publicKey.toBase58()}`));
  } finally {
    removeHome(home);
  }
});

test("connect requests an airdrop on devnet when the key holds under 20 base fees", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ balance: 0 });
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["connect", ...(await agentKey(home, w.agent.secretKey)), "--rule", w.mandate.toBase58()], runtime);
    assert.equal(code, 0);
    assert.deepEqual(airdropsOf(w.fake), [{ to: w.agent.publicKey.toBase58(), lamports: 1_000_000_000 }]);
    assert.ok(output(runtime).includes("Requested an airdrop. This devnet key held under 20 base fees of SOL."));
  } finally {
    removeHome(home);
  }
});

test("connect does not airdrop when the key already holds 20 base fees", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ balance: 100_000 });
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["connect", ...(await agentKey(home, w.agent.secretKey)), "--rule", w.mandate.toBase58()], runtime);
    assert.equal(code, 0);
    assert.deepEqual(airdropsOf(w.fake), []);
    assert.equal(output(runtime).includes("Requested an airdrop"), false);
  } finally {
    removeHome(home);
  }
});

test("connect does not airdrop on mainnet", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ balance: 0 });
    w.fake.genesisHash = GENESIS["mainnet-beta"];
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(
      ["connect", ...(await agentKey(home, w.agent.secretKey)), "--cluster", "mainnet-beta", "--rule", w.mandate.toBase58()],
      runtime,
    );
    assert.equal(code, 0);
    assert.deepEqual(airdropsOf(w.fake), []);
    assert.equal(output(runtime).includes("Requested an airdrop"), false);
  } finally {
    removeHome(home);
  }
});

test("connect refuses an RPC whose genesis does not match the cluster", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ balance: 0 });
    w.fake.genesisHash = GENESIS["mainnet-beta"];
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["connect", "--rule", w.mandate.toBase58()], runtime);
    assert.equal(code, 1);
    assert.equal(runtime.errs.join("\n"), "This RPC does not match devnet.");
    assert.deepEqual(airdropsOf(w.fake), []);
    assert.equal(existsSync(configFile(home)), false);
  } finally {
    removeHome(home);
  }
});

test("connect asks for missing rule fields and defaults the mint to devnet USDC", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const payee = Keypair.generate().publicKey.toBase58();
    const runtime = harness(home, chainOf(w.fake), [payee, "500000", "20000000", "30", "API fees"]);
    const code = await run(["connect", ...(await agentKey(home, w.agent.secretKey))], runtime);
    assert.equal(code, 0);
    assert.deepEqual(runtime.prompts, [
      "Payee address",
      "Most per payment, in base units",
      "Total, in base units",
      "Days",
      "Purpose",
    ]);
    const url = runtime.lines.find((line) => line.startsWith("veto://rule-request?"));
    assert.ok(url);
    const parsed = parseRuleRequest(url);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.request.mint, DEVNET_USDC_MINT);
    assert.equal(parsed.request.payee, payee);
    assert.equal(parsed.request.cap, 20_000_000n);
    assert.equal(parsed.request.max, 500_000n);
    assert.equal(parsed.request.days, 30);
    assert.equal(parsed.request.purpose, "API fees");
    assert.equal(parsed.request.agent, w.agent.publicKey.toBase58());
  } finally {
    removeHome(home);
  }
});

test("connect asks for the mint on mainnet", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ balance: 0 });
    w.fake.genesisHash = GENESIS["mainnet-beta"];
    const payee = Keypair.generate().publicKey.toBase58();
    const runtime = harness(home, chainOf(w.fake), [MAINNET_USDC]);
    const code = await run(
      [
        "connect",
        ...(await agentKey(home, w.agent.secretKey)),
        "--cluster",
        "mainnet-beta",
        "--payee",
        payee,
        "--max",
        "500000",
        "--cap",
        "20000000",
        "--days",
        "30",
        "--purpose",
        "API fees",
      ],
      runtime,
    );
    assert.equal(code, 0);
    assert.deepEqual(runtime.prompts, ["Mint address"]);
    assert.deepEqual(airdropsOf(w.fake), []);
    const url = runtime.lines.find((line) => line.startsWith("veto://rule-request?"));
    assert.ok(url);
    const parsed = parseRuleRequest(url);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.request.mint, MAINNET_USDC);
  } finally {
    removeHome(home);
  }
});

test("connect prints the rule request, its QR, and the approved terms", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ cap: 20_000_000n, perTxMax: 500_000n, expiresAt: EXPIRES, balance: 1_000_000 });
    retargetMint(w, DEVNET_USDC_MINT);
    const payee = Keypair.generate().publicKey.toBase58();
    const runtime = harness(home, chainOf(w.fake));
    runtime.qr = renderQr;
    const code = await run(
      [
        "connect",
        ...(await agentKey(home, w.agent.secretKey)),
        "--payee",
        payee,
        "--max",
        "500000",
        "--cap",
        "20000000",
        "--days",
        "40",
        "--purpose",
        "API fees",
      ],
      runtime,
    );
    assert.equal(code, 0);
    assert.deepEqual(runtime.prompts, []);
    const url = runtime.lines.find((line) => line.startsWith("veto://rule-request?"));
    assert.ok(url);
    const parsed = parseRuleRequest(url);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.request.mint, DEVNET_USDC_MINT);
    const qr = runtime.lines.find((line) => line.includes("\u2588"));
    assert.ok(qr);
    assert.ok(qr.includes("\u2588"));
    const merchant = w.merchant.publicKey.toBase58();
    const short = `${merchant.slice(0, 4)}...${merchant.slice(-4)}`;
    assert.ok(
      runtime.lines.includes(
        `Rule approved. Total 20 USDC, most per payment 0.50 USDC, ends 2026-11-04, pays ${short}. Your agent can pay with: veto pay <amount>`,
      ),
    );
    assert.equal(runtime.lines.at(-1), MCP_CONFIG_LINE);
  } finally {
    removeHome(home);
  }
});

test("connect finds only this agent's rule and saves that rule and the rpc", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const foreign = plantForeignAgent(w);
    const payee = Keypair.generate().publicKey.toBase58();
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(
      ["connect", ...(await agentKey(home, w.agent.secretKey)), "--payee", payee, "--max", "1", "--cap", "2", "--days", "1", "--purpose", "fees"],
      runtime,
    );
    assert.equal(code, 0);
    const saved = JSON.parse(readFileSync(configFile(home), "utf8")) as { rule: string; rpc: string };
    assert.equal(saved.rule, w.mandate.toBase58());
    assert.notEqual(saved.rule, foreign);
    assert.equal(saved.rpc, "https://api.devnet.solana.com");
  } finally {
    removeHome(home);
  }
});

test("connect waits five seconds and says it is waiting for approval", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const saved = w.fake.accounts.get(w.mandate.toBase58());
    assert.ok(saved);
    w.fake.accounts.delete(w.mandate.toBase58());
    const runtime = harness(home, chainOf(w.fake));
    let waits = 0;
    runtime.sleep = async (ms) => {
      assert.equal(ms, 5000);
      waits += 1;
      w.fake.accounts.set(w.mandate.toBase58(), saved);
    };
    const payee = Keypair.generate().publicKey.toBase58();
    const code = await run(
      ["connect", ...(await agentKey(home, w.agent.secretKey)), "--payee", payee, "--max", "1", "--cap", "2", "--days", "1", "--purpose", "fees"],
      runtime,
    );
    assert.equal(code, 0);
    assert.equal(waits, 1);
    assert.ok(output(runtime).includes("Waiting for you to approve on the phone."));
  } finally {
    removeHome(home);
  }
});

test("connect rejects a key that is not the rule's agent", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const keyFile = resolve(home, "other.json");
    await writeKeyFile(keyFile, Keypair.generate().secretKey);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["connect", "--key", keyFile, "--rule", w.mandate.toBase58()], runtime);
    assert.equal(code, 1);
    assert.equal(runtime.errs.join("\n"), "This key is not the rule's agent.");
    assert.equal(existsSync(configFile(home)), false);
    assert.equal(existsSync(agentFile(home)), false);
  } finally {
    removeHome(home);
  }
});

test("connect --rule skips the request and checks that rule", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ cap: 20_000_000n, perTxMax: 500_000n, expiresAt: EXPIRES });
    retargetMint(w, DEVNET_USDC_MINT);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(
      [
        "connect",
        ...(await agentKey(home, w.agent.secretKey)),
        "--rule",
        w.mandate.toBase58(),
        "--payee",
        Keypair.generate().publicKey.toBase58(),
        "--purpose",
        "should not be asked",
      ],
      runtime,
    );
    assert.equal(code, 0);
    assert.deepEqual(runtime.prompts, []);
    assert.equal(output(runtime).includes("veto://"), false);
    assert.equal(output(runtime).includes("Waiting for you to approve on the phone."), false);
    const saved = JSON.parse(readFileSync(configFile(home), "utf8")) as { rule: string };
    assert.equal(saved.rule, w.mandate.toBase58());
    assert.ok(output(runtime).includes("Rule approved. Total 20 USDC, most per payment 0.50 USDC"));
  } finally {
    removeHome(home);
  }
});

test("connect says when the RPC refuses getProgramAccounts filters", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    w.fake.getProgramAccounts = async () => {
      throw new Error("getProgramAccounts filters are not available on this RPC");
    };
    const payee = Keypair.generate().publicKey.toBase58();
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(
      ["connect", "--payee", payee, "--max", "1", "--cap", "2", "--days", "1", "--purpose", "fees"],
      runtime,
    );
    assert.equal(code, 1);
    assert.equal(runtime.errs.join("\n"), "The RPC refuses getProgramAccounts filters. Pass --rule <address>.");
    assert.equal(existsSync(configFile(home)), false);
  } finally {
    removeHome(home);
  }
});

test("connect --rule checks that rule when filters are refused", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    w.fake.getProgramAccounts = async () => {
      throw new Error("getProgramAccounts filters are not available on this RPC");
    };
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["connect", ...(await agentKey(home, w.agent.secretKey)), "--rule", w.mandate.toBase58()], runtime);
    assert.equal(code, 0);
    const saved = JSON.parse(readFileSync(configFile(home), "utf8")) as { rule: string };
    assert.equal(saved.rule, w.mandate.toBase58());
  } finally {
    removeHome(home);
  }
});
