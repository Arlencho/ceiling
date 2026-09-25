import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, Transaction } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { assertDevnet, assertPoolEnvironment, attempt, prepareStolenDestination } from "../examples/hacked-agent.js";
import { initializeData, quote, setupConnection } from "../examples/trade-demo-pool.js";
import { fetchTradeRule } from "./read.js";
import { PROGRAM_ID } from "./idl.js";
import { framed, tokenAccountData, tradeWorld, tradedLog, tradeRefusedLog } from "./testkit.js";
import { parseTradeArgs, runTradeOnce, assertExpected } from "../examples/trade-demo.js";

test("trade arguments accept config or rule and exact positive base units", () => {
  const w = tradeWorld();
  assert.deepEqual(parseTradeArgs(["agent.json", "config.json", "123"]), {
    keyFile: "agent.json", configFile: "config.json", amount: 123n,
  });
  assert.deepEqual(parseTradeArgs(["agent.json", "--rule", w.rule.toBase58(), "123"]), {
    keyFile: "agent.json", rule: w.rule.toBase58(), amount: 123n,
  });
  for (const args of [[], ["key", "config", "0"], ["key", "config", "-1"],
    ["key", "config", "1.5"], ["key", "config", "18446744073709551616"],
    ["key", "--rule", "bad", "1"], ["key", "config", "1", "extra"]]) {
    assert.throws(() => parseTradeArgs(args));
  }
});

for (const reason of [0, 5, 11, 12, 13, 14]) {
  test(`recorded reason ${reason} is printed and a different expected reason fails`, async () => {
    const w = tradeWorld({ lastNonce: 7n });
    w.fake.signature = "demo-signature";
    w.fake.transactions.set("demo-signature", {
      slot: 91, blockTime: 1_700_000_000,
      meta: { err: null, logMessages: framed(PROGRAM_ID.toBase58(), [reason === 0
        ? tradedLog(w.rule, 123n, 100n, 8n, 123n)
        : tradeRefusedLog(w.rule, 123n, 0n, 8n, reason, reason === 5 ? 123n : 0n)]) },
      transaction: { signatures: ["demo-signature"], message: { accountKeys: [], instructions: [] } },
    });
    const lines: string[] = [];
    const result = await runTradeOnce(new VetoAgent({ connection: w.connection, agent: w.agent, rule: w.rule }), 123n, line => lines.push(line));
    assert.equal(result.reasonCode, reason);
    assert.match(lines[0]!, /amount_in=123.*signature=demo-signature slot=91/);
    assert.match(lines[0]!, new RegExp(`reason=${reason} `));
    assertExpected(result, reason, reason === 5 ? 123n : 0n);
    assert.throws(() => assertExpected(result, reason === 0 ? 11 : 0), /expected/);
    if (reason === 5) assert.throws(() => assertExpected(result, 5, 124n), /override/);
    const ix = Transaction.from(w.fake.sent[0]!).instructions[0]!;
    assert.equal(ix.data.readBigUInt64LE(8), 123n);
    assert.equal(ix.data.readBigUInt64LE(16), 0n);
    assert.equal(ix.data.readBigUInt64LE(24), 8n);
  });
}

for (const reason of [11, 12]) {
  test(`hostile account substitution reaches the transaction and reads recorded reason ${reason}`, async () => {
    const w = tradeWorld();
    const veto = new VetoAgent({ connection: w.connection, agent: w.agent, rule: w.rule });
    const replacement = Keypair.generate().publicKey;
    const rule = await fetchTradeRule(w.connection, w.rule);
    w.fake.signature = "attack";
    w.fake.transactions.set("attack", {
      slot: 92, blockTime: 1_700_000_000,
      meta: { err: null, logMessages: framed(PROGRAM_ID.toBase58(), [tradeRefusedLog(w.rule, 123n, 0n, 9n, reason, 0n)]) },
      transaction: { signatures: ["attack"], message: { accountKeys: [], instructions: [] } },
    });
    const result = await attempt(veto, rule, 123n, 9n, reason === 11 ? { destination: replacement } : { pool: replacement });
    assertExpected(result, reason);
    assert.equal(result.signature, "attack");
    const ix = Transaction.from(w.fake.sent[0]!).instructions[0]!;
    assert.equal(ix.keys[reason === 11 ? 4 : 6]!.pubkey.toBase58(), replacement.toBase58());
    assert.equal(ix.data.readBigUInt64LE(24), 9n);
    assert.equal(ix.keys.length, 13);
    assert.equal(ix.keys.filter(k => k.isSigner).length, 1);
    assert.equal(ix.keys[0]!.pubkey.toBase58(), w.agent.publicKey.toBase58());
    assert.throws(() => assertExpected(result, reason === 11 ? 12 : 11), /expected/);
  });
}

test("hostile demo permits devnet and refuses another genesis before attempting trades", async () => {
  const w = tradeWorld();
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, rule: w.rule });
  await assertDevnet(veto);
  w.connection.getGenesisHash = async () => "other-genesis";
  await assert.rejects(() => assertDevnet(veto), /requires devnet/);
  assert.equal(w.fake.sent.length, 0);
});

test("pool environment must name exactly the live rule accounts", async () => {
  const w = tradeWorld();
  const rule = await fetchTradeRule(w.connection, w.rule);
  const env = { TOKEN_SWAP_POOL: rule.pool.toBase58(), TOKEN_SWAP_AUTHORITY: rule.poolAuthority.toBase58(),
    TOKEN_SWAP_WSOL_VAULT: rule.poolInVault.toBase58(), TOKEN_SWAP_USDC_VAULT: rule.poolOutVault.toBase58(),
    TOKEN_SWAP_POOL_MINT: rule.poolMint.toBase58(), TOKEN_SWAP_FEE_ACCOUNT: rule.poolFeeAccount.toBase58() };
  assertPoolEnvironment(rule, env);
  for (const name of Object.keys(env)) {
    assert.throws(() => assertPoolEnvironment(rule, { ...env, [name]: "" }), new RegExp(name));
  }
});

test("hostile pool initializes with the enforced v2 fee schedule and constant product curve", () => {
  const data = initializeData(254);
  assert.equal(data.length, 99);
  assert.deepEqual([...data.subarray(0, 2)], [0, 254]);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => data.readBigUInt64LE(2 + i * 8)),
    [25n, 10000n, 5n, 10000n, 0n, 0n, 20n, 100n]);
  assert.deepEqual(data.subarray(66), Buffer.alloc(33));
  assert.equal(quote(10000n, 1000000n, 1000000n), 9871n);
  assert.equal(quote(1n, 1000000n, 1000000n), 0n);
});

test("hostile destination reuses the funded agent account on every run", async () => {
  const w = tradeWorld();
  const rule = await fetchTradeRule(w.connection, w.rule);
  const address = getAssociatedTokenAddressSync(rule.outMint, w.agent.publicKey);
  const data = tokenAccountData(rule.outMint, w.agent.publicKey);
  data.writeBigUInt64LE(42n, 64);
  w.fake.accounts.set(address.toBase58(), { data, owner: TOKEN_PROGRAM_ID, lamports: 1 });
  w.connection.sendTransaction = async () => { throw new Error("already in use"); };
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, rule: w.rule });
  for (let i = 0; i < 2; i++) {
    assert.equal((await prepareStolenDestination(veto, rule)).toBase58(), address.toBase58());
    assert.equal(w.fake.accounts.get(address.toBase58())!.data.readBigUInt64LE(64), 42n);
  }
});

for (const flag of [undefined, "0", "1"]) {
  test(`honest trade refuses mainnet with a direct rule and devnet flag ${flag}`, async () => {
    const { runHonestTrade } = await import("../examples/trade-once.js");
    const prior = process.env.VETO_TRADE_DEMO_DEVNET;
    try {
      if (flag === undefined) delete process.env.VETO_TRADE_DEMO_DEVNET;
      else process.env.VETO_TRADE_DEMO_DEVNET = flag;
      const w = tradeWorld();
      w.fake.genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
      const veto = new VetoAgent({ connection: w.connection, agent: w.agent, rule: w.rule });
      await assert.rejects(() => runHonestTrade(veto, 123n), /requires devnet/);
      assert.equal(w.fake.sent.length, 0);
    } finally {
      if (prior === undefined) delete process.env.VETO_TRADE_DEMO_DEVNET;
      else process.env.VETO_TRADE_DEMO_DEVNET = prior;
    }
  });
}

for (const reason of [0, 5, 11, 12, 13, 14]) {
  test(`honest entry point ${reason === 0 ? "succeeds" : "fails"} for recorded reason ${reason}`, async () => {
    const { runHonestTrade } = await import("../examples/trade-once.js");
    const w = tradeWorld();
    w.fake.transactions.set(w.fake.signature, {
      slot: 91, blockTime: 1_700_000_000,
      meta: { err: null, logMessages: framed(PROGRAM_ID.toBase58(), [reason === 0
        ? tradedLog(w.rule, 123n, 100n, 1n, 123n)
        : tradeRefusedLog(w.rule, 123n, 0n, 1n, reason, reason === 5 ? 123n : 0n)]) },
      transaction: { signatures: [w.fake.signature], message: { accountKeys: [], instructions: [] } },
    });
    const veto = new VetoAgent({ connection: w.connection, agent: w.agent, rule: w.rule });
    if (reason === 0) assertExpected(await runHonestTrade(veto, 123n), 0);
    else await assert.rejects(() => runHonestTrade(veto, 123n), /expected reason 0/);
  });
}

test("refused honest CLI prints the decision and exits non-zero", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { runHonestTrade } from "./examples/trade-once.ts";
    import { mainIfDirect } from "./examples/trade-demo.ts";
    import { pathToFileURL } from "node:url";
    import { resolve } from "node:path";
    process.argv[1] = resolve("examples/trade-once.ts");
    const veto = {
      connection: { getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
      tradeStatus: async () => ({}),
      nextTradeNonce: async () => 1n,
      trade: async () => ({ kind: "refused", amountIn: 123n, amountOut: 0n,
        reasonCode: 13, reasonText: "over daily limit", suggestedOverride: 0n,
        signature: "refusal-signature", slot: 91 }),
    };
    mainIfDirect(pathToFileURL(process.argv[1]).href, () => runHonestTrade(veto, 123n));
  `], { cwd: new URL("../", import.meta.url), encoding: "utf8",
    env: { ...process.env, VETO_TRADE_DEMO_DEVNET: "0" } });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stdout, /refused .*reason=13 .*signature=refusal-signature/);
  assert.match(child.stderr, /expected reason 0, got refused reason 13/);
});

test("setup evidence prints each submitted signature without changing transaction results", async () => {
  const w = tradeWorld();
  const lines: string[] = [];
  let count = 0;
  w.connection.sendTransaction = async function () {
    assert.equal(this, w.connection);
    return `setup-signature-${++count}`;
  };
  const connection = setupConnection(w.connection, "bad_pool", line => lines.push(line));
  for (let i = 1; i <= 3; i++) {
    assert.equal(await connection.sendTransaction(new Transaction(), [w.agent]), `setup-signature-${i}`);
  }
  assert.deepEqual(lines, [1, 2, 3].map(i => `setup=bad_pool signature=setup-signature-${i}`));
  assert.equal(await connection.getGenesisHash(), w.fake.genesisHash);
  assert.equal(await w.connection.sendTransaction(new Transaction(), [w.agent]), "setup-signature-4");
  assert.equal(lines.length, 3);
});
