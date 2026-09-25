import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, Transaction, type PublicKey } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { isTradeAgentConfig, loadAgentConfig, type TradeAgentConfig } from "./config.js";
import { PROGRAM_ID, TRADE_RULE_DISCRIMINATOR } from "./idl.js";
import { TRADE_RULE_AGENT_OFFSET, decodeTradeRule, mandatePda, tradeLedgerPda, tradeRulePda } from "./layout.js";
import { tradeRulesForAgent } from "./read.js";
import {
  TOKEN_PROGRAM,
  decodeBase58,
  framed,
  mandateBytes,
  paidLog,
  tradeRefusedLog,
  tradeRuleBytes,
  tradeWorld,
  tradedLog,
  type TradeRuleFields,
  type TradeWorld,
} from "./testkit.js";

function agentFor(w: TradeWorld = tradeWorld()) {
  return {
    w,
    veto: new VetoAgent({ connection: w.connection, agent: w.agent, rule: w.rule }),
  };
}

function preload(w: TradeWorld, logs: string[], slot = 77): void {
  w.fake.signature = "sig-trade";
  w.fake.transactions.set("sig-trade", {
    slot,
    blockTime: 1_700_000_000,
    meta: { err: null, logMessages: logs },
    transaction: {
      signatures: ["sig-trade"],
      message: { accountKeys: [], instructions: [] },
    },
  });
}

function tradeConfig(w: TradeWorld, over: Record<string, unknown> = {}): TradeAgentConfig {
  const loaded = loadAgentConfig({
    kind: "trade",
    rule: w.rule.toBase58(),
    programId: PROGRAM_ID.toBase58(),
    agent: w.agent.publicKey.toBase58(),
    inMint: w.inMint.publicKey.toBase58(),
    inMintDecimals: 9,
    outMint: w.outMint.publicKey.toBase58(),
    outMintDecimals: 6,
    sourceTokenAccount: w.source.publicKey.toBase58(),
    destinationTokenAccount: w.destination.publicKey.toBase58(),
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    ...over,
  });
  if (!isTradeAgentConfig(loaded)) {
    throw new Error("test built a payment block");
  }
  return loaded;
}

test("trade refuses a signer that is not the rule's agent", async () => {
  const other = Keypair.generate();
  const w = tradeWorld({ agent: other.publicKey });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, rule: w.rule });
  await assert.rejects(
    () => veto.trade({ amountIn: 1n, minOut: 1n, nonce: 1n }),
    /signer is not the agent named in the rule/,
  );
  assert.equal(w.fake.sent.length, 0);
});

test("trade submits the thirteen accounts stored on the rule and no mints", async () => {
  const { w, veto } = agentFor();
  const amountIn = 5_000_000n;
  const minOut = 4_000_000n;
  const nonce = 3n;
  const decoy = Keypair.generate().publicKey;
  preload(w, framed(PROGRAM_ID.toBase58(), [tradedLog(w.rule, amountIn, 4_250_000n, nonce, amountIn)]));
  await veto.trade({ amountIn, minOut, nonce });
  const raw = w.fake.sent[0];
  assert.ok(raw);
  const ix = Transaction.from(raw).instructions[0];
  assert.ok(ix);
  const stored = decodeTradeRule(w.fake.accounts.get(w.rule.toBase58())!.data);
  const idl = JSON.parse(readFileSync(fileURLToPath(new URL("../idl/veto.json", import.meta.url)), "utf8")) as {
    instructions: { name: string; discriminator: number[]; accounts: { name: string; writable?: boolean; signer?: boolean }[] }[];
  };
  const spec = idl.instructions.find((item) => item.name === "trade");
  assert.ok(spec);
  assert.equal(ix.keys.length, 13);
  assert.equal(spec.accounts.length, 13);
  const expected = [
    w.agent.publicKey,
    w.rule,
    tradeLedgerPda(PROGRAM_ID, w.rule),
    stored.source,
    stored.destination,
    stored.exchangeProgram,
    stored.pool,
    stored.poolAuthority,
    stored.poolInVault,
    stored.poolOutVault,
    stored.poolMint,
    stored.poolFeeAccount,
    TOKEN_PROGRAM,
  ];
  spec.accounts.forEach((account, i) => {
    const meta = ix.keys[i];
    assert.ok(meta);
    assert.equal(meta.pubkey.toBase58(), expected[i]?.toBase58(), account.name);
    assert.equal(meta.isSigner, account.signer === true, `${account.name} signer`);
    if (i > 0) assert.equal(meta.isWritable, account.writable === true, `${account.name} writable`);
  });
  const pubs = ix.keys.map((meta) => meta.pubkey.toBase58());
  assert.equal(pubs.includes(stored.inMint.toBase58()), false);
  assert.equal(pubs.includes(stored.outMint.toBase58()), false);
  assert.equal(pubs.includes(decoy.toBase58()), false);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), Buffer.from(spec.discriminator));
  assert.equal(ix.data.readBigUInt64LE(8), amountIn);
  assert.equal(ix.data.readBigUInt64LE(16), minOut);
  assert.equal(ix.data.readBigUInt64LE(24), nonce);
});

test("trade returns the traded decision, including the output that came back", async () => {
  const { w, veto } = agentFor();
  const amountIn = 5_000_000n;
  const nonce = 3n;
  preload(
    w,
    framed(PROGRAM_ID.toBase58(), [
      paidLog(w.rule, amountIn, nonce, amountIn),
      tradedLog(w.rule, amountIn, 4_250_000n, nonce, amountIn),
    ]),
    90,
  );
  const result = await veto.trade({ amountIn, minOut: 1n, nonce });
  assert.equal(result.kind, "traded");
  assert.equal(result.amountIn, amountIn);
  assert.equal(result.amountOut, 4_250_000n);
  assert.equal(result.reasonCode, 0);
  assert.equal(result.reasonText, "ok");
  assert.equal(result.suggestedOverride, 0n);
  assert.equal(result.signature, "sig-trade");
  assert.equal(result.slot, 90);
});

test("trade returns a refusal with no output and the reason text", async () => {
  const { w, veto } = agentFor();
  const amountIn = 5_000_000n;
  const nonce = 3n;
  preload(
    w,
    framed(PROGRAM_ID.toBase58(), [tradeRefusedLog(w.rule, amountIn, 9_000n, nonce, 14, 0n)]),
  );
  const result = await veto.trade({ amountIn, minOut: 9_000n, nonce });
  assert.equal(result.kind, "refused");
  assert.equal(result.amountIn, amountIn);
  assert.equal(result.amountOut, 0n);
  assert.equal(result.reasonCode, 14);
  assert.equal(result.reasonText, "quote below floor");
  assert.equal(result.suggestedOverride, 0n);
  assert.equal(result.signature, "sig-trade");
});

test("trade rejects a transaction that carries two trade decisions for the nonce", async () => {
  const { w, veto } = agentFor();
  const amountIn = 5n;
  const nonce = 1n;
  preload(
    w,
    framed(PROGRAM_ID.toBase58(), [
      tradedLog(w.rule, amountIn, 4n, nonce, amountIn),
      tradeRefusedLog(w.rule, amountIn, 1n, nonce, 13, 0n),
    ]),
  );
  await assert.rejects(() => veto.trade({ amountIn, minOut: 1n, nonce }), /2 Veto trade decisions/);
});

test("nextTradeNonce is the rule last_nonce plus one", async () => {
  const { veto } = agentFor(tradeWorld({ lastNonce: 7n }));
  assert.equal(await veto.nextTradeNonce(), 8n);
});

test("nextTradeNonce returns the pending override nonce when it is above last_nonce", async () => {
  const { veto } = agentFor(tradeWorld({ lastNonce: 4n, overrideNonce: 9n, overrideAmount: 12n }));
  assert.equal(await veto.nextTradeNonce(), 9n);
});

test("nextTradeNonce ignores an override that is not above last_nonce", async () => {
  const { veto } = agentFor(tradeWorld({ lastNonce: 5n, overrideNonce: 5n, overrideAmount: 12n }));
  assert.equal(await veto.nextTradeNonce(), 6n);
});

test("nextTradeNonce throws when last_nonce is the maximum u64", async () => {
  const { veto } = agentFor(tradeWorld({ lastNonce: (1n << 64n) - 1n }));
  await assert.rejects(() => veto.nextTradeNonce(), /last_nonce is the maximum u64/);
});

test("tradeStatus reports the cap, the floor, and the pinned destination", async () => {
  const destination = Keypair.generate().publicKey;
  const { veto } = agentFor(
    tradeWorld({
      destination,
      cap: 1_000n,
      spent: 250n,
      perTradeMax: 40n,
      dailyLimit: 100n,
      windowSpent: 25n,
      floorNum: 9_500n,
      floorDen: 10_000n,
      expiresAt: 1_900_000_000n,
      status: 0,
      overrideAmount: 80n,
      overrideNonce: 4n,
      lastNonce: 3n,
    }),
  );
  const status = await veto.tradeStatus();
  assert.equal(status.cap, 1_000n);
  assert.equal(status.spent, 250n);
  assert.equal(status.remaining, 750n);
  assert.equal(status.perTradeMax, 40n);
  assert.equal(status.dailyLimit, 100n);
  assert.equal(status.remainingToday, 75n);
  assert.deepEqual(status.floor, { num: 9_500n, den: 10_000n });
  assert.equal(status.expiresAt, 1_900_000_000n);
  assert.equal(status.status, 0);
  assert.equal(status.overrideAmount, 80n);
  assert.equal(status.overrideNonce, 4n);
  assert.equal(status.lastNonce, 3n);
  assert.equal(status.destination, destination.toBase58());
});

test("tradeStatus treats a finished window as unused", async () => {
  const { veto } = agentFor(
    tradeWorld({
      dailyLimit: 100n,
      windowSpent: 100n,
      windowStart: 1n,
    }),
  );
  const status = await veto.tradeStatus();
  assert.equal(status.remainingToday, 100n);
});

test("fromTradeConfig accepts a block that matches the rule and the agent key", async () => {
  const w = tradeWorld();
  const config = tradeConfig(w);
  const veto = await VetoAgent.fromTradeConfig(config, w.agent, w.connection);
  assert.equal(veto.tradeRule?.toBase58(), w.rule.toBase58());
  assert.equal(veto.agent.publicKey.toBase58(), config.agent);
  const status = await veto.tradeStatus();
  assert.equal(status.destination, w.destination.publicKey.toBase58());
  assert.equal(status.cap, w.fields.cap);
});

test("fromConfig refuses a trade block", async () => {
  const w = tradeWorld();
  await assert.rejects(
    () => VetoAgent.fromConfig(tradeConfig(w), w.agent, w.connection),
    /Use fromTradeConfig/,
  );
});

test("fromTradeConfig rejects a rule the program does not own", async () => {
  const w = tradeWorld();
  const stored = w.fake.accounts.get(w.rule.toBase58());
  assert.ok(stored);
  w.fake.accounts.set(w.rule.toBase58(), {
    data: stored.data,
    owner: Keypair.generate().publicKey,
    lamports: stored.lamports,
  });
  await assert.rejects(
    () => VetoAgent.fromTradeConfig(tradeConfig(w), w.agent, w.connection),
    /not owned by program/,
  );
});

test("fromTradeConfig rejects an agent key the rule does not name", async () => {
  const other = Keypair.generate();
  const w = tradeWorld({ agent: other.publicKey });
  await assert.rejects(
    () => VetoAgent.fromTradeConfig(tradeConfig(w), w.agent, w.connection),
    /rule agent/,
  );
});

test("fromTradeConfig rejects a block whose agent is not the keypair", async () => {
  const w = tradeWorld();
  const config = tradeConfig(w, { agent: Keypair.generate().publicKey.toBase58() });
  await assert.rejects(() => VetoAgent.fromTradeConfig(config, w.agent, w.connection), /config agent/);
});

test("fromTradeConfig rejects an in mint that is not the rule in mint", async () => {
  const w = tradeWorld();
  const config = tradeConfig(w, { inMint: Keypair.generate().publicKey.toBase58() });
  await assert.rejects(() => VetoAgent.fromTradeConfig(config, w.agent, w.connection), /in mint/);
});

test("fromTradeConfig rejects an out mint that is not the rule out mint", async () => {
  const w = tradeWorld();
  const config = tradeConfig(w, { outMint: Keypair.generate().publicKey.toBase58() });
  await assert.rejects(() => VetoAgent.fromTradeConfig(config, w.agent, w.connection), /out mint/);
});

test("fromTradeConfig rejects in mint decimals that do not match the mint account", async () => {
  const w = tradeWorld();
  const stored = w.fake.accounts.get(w.inMint.publicKey.toBase58());
  assert.ok(stored);
  stored.data.writeUInt8(8, 44);
  await assert.rejects(
    () => VetoAgent.fromTradeConfig(tradeConfig(w), w.agent, w.connection),
    /in mint decimals/,
  );
});

test("fromTradeConfig rejects out mint decimals that do not match the mint account", async () => {
  const w = tradeWorld();
  const stored = w.fake.accounts.get(w.outMint.publicKey.toBase58());
  assert.ok(stored);
  stored.data.writeUInt8(9, 44);
  await assert.rejects(
    () => VetoAgent.fromTradeConfig(tradeConfig(w), w.agent, w.connection),
    /out mint decimals/,
  );
});

test("fromTradeConfig rejects a source that is not the rule source", async () => {
  const w = tradeWorld();
  const config = tradeConfig(w, { sourceTokenAccount: Keypair.generate().publicKey.toBase58() });
  await assert.rejects(() => VetoAgent.fromTradeConfig(config, w.agent, w.connection), /source/);
});

test("fromTradeConfig rejects a destination that is not the pinned destination", async () => {
  const w = tradeWorld();
  const config = tradeConfig(w, { destinationTokenAccount: Keypair.generate().publicKey.toBase58() });
  await assert.rejects(() => VetoAgent.fromTradeConfig(config, w.agent, w.connection), /destination/);
});

test("fromTradeConfig rejects a cluster whose genesis hash does not match", async () => {
  const w = tradeWorld();
  const config = tradeConfig(w, { cluster: "mainnet-beta" });
  await assert.rejects(
    () => VetoAgent.fromTradeConfig(config, w.agent, w.connection),
    /does not match genesis hash/,
  );
});

test("fromTradeConfig refuses a block whose programId differs from the program passed in code", async () => {
  const w = tradeWorld();
  await assert.rejects(
    () => VetoAgent.fromTradeConfig(tradeConfig(w), w.agent, w.connection, { programId: Keypair.generate().publicKey }),
    /does not equal the Veto program/,
  );
});

test("tradeRulesForAgent finds only this agent's trade rules, newest first", async () => {
  const w = tradeWorld({ ruleId: 3n });
  const other = Keypair.generate();
  const older = addTrade(w, { owner: w.owner.publicKey, agent: w.agent.publicKey, ruleId: 1n });
  const newer = addTrade(w, { owner: w.owner.publicKey, agent: w.agent.publicKey, ruleId: 9n });
  addTrade(w, { owner: w.owner.publicKey, agent: other.publicKey, ruleId: 100n });
  const payer = Keypair.generate().publicKey;
  const mandate = mandatePda(PROGRAM_ID, payer, 4n);
  w.fake.accounts.set(mandate.toBase58(), {
    data: mandateBytes({
      owner: payer,
      agent: w.agent.publicKey,
      mint: w.inMint.publicKey,
      source: w.source.publicKey,
      merchant: w.destination.publicKey,
      mandateId: 4n,
      cap: 1n,
      spent: 0n,
      perTxMax: 1n,
      expiresAt: 1n,
      overrideAmount: 0n,
      overrideNonce: 0n,
      lastNonce: 0n,
      purpose: "pay",
      status: 0,
      spendCount: 0,
      refusalCount: 0,
      bump: 1,
    }),
    owner: PROGRAM_ID,
    lamports: 1,
  });
  const found = await tradeRulesForAgent(w.connection, w.agent.publicKey);
  assert.deepEqual(
    found.map((rule) => rule.address.toBase58()),
    [newer.toBase58(), w.rule.toBase58(), older.toBase58()],
  );
  assert.deepEqual(
    found.map((rule) => rule.ruleId),
    [9n, 3n, 1n],
  );
  for (const rule of found) {
    assert.equal(rule.agent.toBase58(), w.agent.publicKey.toBase58());
    assert.equal(rule.destination.toBase58(), w.destination.publicKey.toBase58());
  }
  assert.equal(w.fake.programQueries.length, 1);
  const query = w.fake.programQueries[0];
  assert.ok(query);
  const discriminator = query.filters.find((filter) => "memcmp" in filter && filter.memcmp.offset === 0);
  const agentFilter = query.filters.find(
    (filter) => "memcmp" in filter && filter.memcmp.offset === TRADE_RULE_AGENT_OFFSET,
  );
  assert.ok(discriminator && "memcmp" in discriminator);
  assert.ok(agentFilter && "memcmp" in agentFilter);
  const discBytes =
    discriminator.memcmp.encoding === "base64"
      ? Buffer.from(discriminator.memcmp.bytes, "base64")
      : decodeBase58(discriminator.memcmp.bytes);
  assert.ok(discBytes.equals(TRADE_RULE_DISCRIMINATOR));
  assert.ok(decodeBase58(agentFilter.memcmp.bytes).equals(w.agent.publicKey.toBuffer()));
});

function addTrade(
  w: TradeWorld,
  fields: Pick<TradeRuleFields, "owner" | "agent" | "ruleId">,
): PublicKey {
  const address = tradeRulePda(PROGRAM_ID, fields.owner, fields.ruleId);
  w.fake.accounts.set(address.toBase58(), {
    data: tradeRuleBytes({ ...w.fields, ...fields }),
    owner: PROGRAM_ID,
    lamports: 1,
  });
  return address;
}
