import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { isTradeAgentConfig, loadAgentConfig, type AgentConfig, type TradeAgentConfig } from "./config.js";
import { PROGRAM_ID } from "./idl.js";
import { world, type World } from "./testkit.js";

function fields(w: World, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    mandate: w.mandate.toBase58(),
    programId: PROGRAM_ID.toBase58(),
    mint: w.mint.publicKey.toBase58(),
    mintDecimals: 6,
    sourceTokenAccount: w.source.publicKey.toBase58(),
    payeeTokenAccount: w.destination.publicKey.toBase58(),
    agent: w.agent.publicKey.toBase58(),
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    ...over,
  };
}

test("loadAgentConfig returns every field of the copied block", () => {
  const w = world();
  const input = fields(w);
  const loaded = loadAgentConfig(JSON.stringify(input));
  assert.deepEqual(loaded, input);
  assert.deepEqual(loadAgentConfig(input), input);
});

test("loadAgentConfig rejects a block that is not the documented object", () => {
  const w = world();
  const input = fields(w);
  assert.throws(() => loadAgentConfig("["), /JSON/);
  assert.throws(() => loadAgentConfig([input]), /JSON object/);
  const missing = { ...input } as Partial<AgentConfig>;
  delete missing.payeeTokenAccount;
  assert.throws(() => loadAgentConfig(missing), /documented shape/);
  assert.throws(() => loadAgentConfig({ ...input, extra: "no" }), /documented shape/);
});

test("loadAgentConfig rejects a field that is not a usable value", () => {
  const w = world();
  const input = fields(w);
  assert.throws(() => loadAgentConfig({ ...input, mintDecimals: 19 }), /mint decimals/);
  assert.throws(() => loadAgentConfig({ ...input, mintDecimals: "6" }), /mint decimals/);
  assert.throws(() => loadAgentConfig({ ...input, mint: "not-a-key" }), /mint/);
  assert.throws(() => loadAgentConfig({ ...input, cluster: "localnet" }), /cluster/);
  assert.throws(() => loadAgentConfig({ ...input, rpcUrl: "" }), /rpc url/);
});

test("fromConfig accepts a block that matches the mandate and the agent key", async () => {
  const w = world();
  const config = loadAgentConfig(fields(w));
  if (isTradeAgentConfig(config)) throw new Error("payment block");
  const veto = await VetoAgent.fromConfig(config, w.agent, w.connection);
  assert.equal(veto.mandate.toBase58(), config.mandate);
  assert.equal(veto.agent.publicKey.toBase58(), config.agent);
  assert.equal(veto.connection, w.connection);
});

test("fromConfig rejects a mandate the program does not own", async () => {
  const w = world();
  const stored = w.fake.accounts.get(w.mandate.toBase58());
  assert.ok(stored);
  w.fake.accounts.set(w.mandate.toBase58(), {
    data: stored.data,
    owner: Keypair.generate().publicKey,
    lamports: stored.lamports,
  });
  const config = loadAgentConfig(fields(w));
  await assert.rejects(
    () => VetoAgent.fromConfig(config, w.agent, w.connection),
    /not owned by program/,
  );
});

test("fromConfig rejects an agent key the mandate does not name", async () => {
  const w = world();
  const other = Keypair.generate();
  const config = loadAgentConfig(fields(w, { agent: other.publicKey.toBase58() }));
  await assert.rejects(() => VetoAgent.fromConfig(config, other, w.connection), /mandate agent/);
});

test("fromConfig rejects a block whose agent is not the keypair", async () => {
  const w = world();
  const config = loadAgentConfig(fields(w, { agent: Keypair.generate().publicKey.toBase58() }));
  await assert.rejects(() => VetoAgent.fromConfig(config, w.agent, w.connection), /config agent/);
});

test("fromConfig rejects a mint that is not the mandate mint", async () => {
  const w = world();
  const config = loadAgentConfig(fields(w, { mint: Keypair.generate().publicKey.toBase58() }));
  await assert.rejects(() => VetoAgent.fromConfig(config, w.agent, w.connection), /mint/);
});

test("fromConfig rejects a source that is not the mandate source", async () => {
  const w = world();
  const config = loadAgentConfig(
    fields(w, { sourceTokenAccount: Keypair.generate().publicKey.toBase58() }),
  );
  await assert.rejects(() => VetoAgent.fromConfig(config, w.agent, w.connection), /source/);
});

test("fromConfig rejects a payee token account the charge would not pay", async () => {
  const w = world();
  const config = loadAgentConfig(
    fields(w, { payeeTokenAccount: Keypair.generate().publicKey.toBase58() }),
  );
  await assert.rejects(() => VetoAgent.fromConfig(config, w.agent, w.connection), /payee/);
});

test("a payment block without kind still loads", () => {
  const w = world();
  const input = fields(w);
  const loaded = loadAgentConfig(input);
  assert.equal(isTradeAgentConfig(loaded), false);
  if (isTradeAgentConfig(loaded)) return;
  assert.equal(loaded.mandate, input.mandate);
  assert.equal("kind" in loaded, false);
});

test("loadAgentConfig reads a trade block and refuses a trade block with an extra key", () => {
  const rule = Keypair.generate().publicKey.toBase58();
  const agent = Keypair.generate().publicKey.toBase58();
  const inMint = Keypair.generate().publicKey.toBase58();
  const outMint = Keypair.generate().publicKey.toBase58();
  const source = Keypair.generate().publicKey.toBase58();
  const destination = Keypair.generate().publicKey.toBase58();
  const input: TradeAgentConfig = {
    kind: "trade",
    rule,
    programId: PROGRAM_ID.toBase58(),
    agent,
    inMint,
    inMintDecimals: 9,
    outMint,
    outMintDecimals: 6,
    sourceTokenAccount: source,
    destinationTokenAccount: destination,
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
  };
  const loaded = loadAgentConfig(JSON.stringify(input));
  assert.deepEqual(loaded, input);
  assert.throws(() => loadAgentConfig({ ...input, extra: "no" }), /documented shape/);
  const missing = { ...input } as Partial<TradeAgentConfig>;
  delete missing.rule;
  assert.throws(() => loadAgentConfig(missing), /documented shape/);
  assert.throws(() => loadAgentConfig({ ...input, kind: "payment" }), /kind must be trade/);
});

test("fromConfig refuses a block whose programId differs from the programId passed in code", async () => {
  const w = world();
  const pinned = Keypair.generate().publicKey;
  const config = loadAgentConfig(fields(w));
  await assert.rejects(
    () => VetoAgent.fromConfig(config, w.agent, w.connection, { programId: pinned }),
    /does not equal the Veto program/,
  );
});
