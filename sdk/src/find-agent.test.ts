import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { MANDATE_DISCRIMINATOR, PROGRAM_ID } from "./idl.js";
import { MANDATE_AGENT_OFFSET, mandatePda } from "./layout.js";
import { mandatesForAgent } from "./read.js";
import { decodeBase58, mandateBytes, world, type MandateFields, type World } from "./testkit.js";

function addRule(
  w: World,
  fields: Pick<MandateFields, "owner" | "agent" | "mandateId"> & Partial<Pick<MandateFields, "status">>,
): PublicKey {
  const address = mandatePda(PROGRAM_ID, fields.owner, fields.mandateId);
  w.fake.accounts.set(address.toBase58(), {
    data: mandateBytes({
      owner: fields.owner,
      agent: fields.agent,
      mint: w.mint.publicKey,
      source: w.source.publicKey,
      merchant: w.merchant.publicKey,
      mandateId: fields.mandateId,
      cap: 300_000_000n,
      spent: 0n,
      perTxMax: 10_000_000n,
      expiresAt: 1_797_805_739n,
      overrideAmount: 0n,
      overrideNonce: 0n,
      lastNonce: 0n,
      purpose: "Charging top-ups at the SE3 spot rate",
      status: fields.status ?? 0,
      spendCount: 0,
      refusalCount: 0,
      bump: 254,
    }),
    owner: PROGRAM_ID,
    lamports: 1,
  });
  return address;
}

function memcmpRaw(filter: { memcmp: { bytes: string; encoding?: "base58" | "base64" } }): Buffer {
  if (filter.memcmp.encoding === "base64") return Buffer.from(filter.memcmp.bytes, "base64");
  return decodeBase58(filter.memcmp.bytes);
}

test("mandatesForAgent finds only this agent's rules, newest first", async () => {
  const w = world();
  const other = Keypair.generate();
  const older = addRule(w, { owner: w.owner.publicKey, agent: w.agent.publicKey, mandateId: 1n });
  const revoked = addRule(w, {
    owner: w.owner.publicKey,
    agent: w.agent.publicKey,
    mandateId: 2n,
    status: 1,
  });
  const newer = addRule(w, { owner: w.owner.publicKey, agent: w.agent.publicKey, mandateId: 9n });
  addRule(w, { owner: w.owner.publicKey, agent: other.publicKey, mandateId: 100n });
  // Owner is this agent, but the rule names someone else. An owner-offset filter would return it.
  addRule(w, { owner: w.agent.publicKey, agent: other.publicKey, mandateId: 8n });
  const junk = Keypair.generate().publicKey;
  const junkData = Buffer.alloc(80);
  junkData.set(w.agent.publicKey.toBuffer(), MANDATE_AGENT_OFFSET);
  w.fake.accounts.set(junk.toBase58(), { data: junkData, owner: PROGRAM_ID, lamports: 1 });

  const found = await mandatesForAgent(w.connection, w.agent.publicKey);
  assert.deepEqual(
    found.map((rule) => rule.address.toBase58()),
    [newer.toBase58(), w.mandate.toBase58(), revoked.toBase58(), older.toBase58()],
  );
  assert.deepEqual(
    found.map((rule) => rule.mandateId),
    [9n, 3n, 2n, 1n],
  );
  for (const rule of found) {
    assert.equal(rule.agent.toBase58(), w.agent.publicKey.toBase58());
    assert.equal(rule.mint.toBase58(), w.mint.publicKey.toBase58());
    assert.equal(rule.source.toBase58(), w.source.publicKey.toBase58());
  }

  assert.equal(w.fake.programQueries.length, 1);
  const query = w.fake.programQueries[0];
  assert.ok(query);
  assert.equal(query.programId, PROGRAM_ID.toBase58());
  assert.equal(query.filters.length, 2);
  const discriminator = query.filters.find((filter) => "memcmp" in filter && filter.memcmp.offset === 0);
  const agentFilter = query.filters.find(
    (filter) => "memcmp" in filter && filter.memcmp.offset === MANDATE_AGENT_OFFSET,
  );
  assert.ok(discriminator && "memcmp" in discriminator);
  assert.ok(agentFilter && "memcmp" in agentFilter);
  assert.ok(memcmpRaw(discriminator).equals(MANDATE_DISCRIMINATOR));
  assert.ok(memcmpRaw(agentFilter).equals(w.agent.publicKey.toBuffer()));
});

test("mandatesForAgent ignores rules that name another agent", async () => {
  const w = world();
  const other = Keypair.generate();
  const otherRule = addRule(w, { owner: w.owner.publicKey, agent: other.publicKey, mandateId: 4n });
  const found = await mandatesForAgent(w.connection, other.publicKey.toBase58());
  assert.deepEqual(
    found.map((rule) => rule.address.toBase58()),
    [otherRule.toBase58()],
  );
  assert.equal(found[0]?.agent.toBase58(), other.publicKey.toBase58());
  assert.equal(
    found.some((rule) => rule.address.equals(w.mandate)),
    false,
  );
});

test("fromMandate binds the keypair to the rule it reads from the chain", async () => {
  const w = world();
  const veto = await VetoAgent.fromMandate(w.connection, w.mandate, w.agent);
  assert.equal(veto.mandate.toBase58(), w.mandate.toBase58());
  assert.equal(veto.agent.publicKey.toBase58(), w.agent.publicKey.toBase58());
  assert.equal(veto.programId.toBase58(), PROGRAM_ID.toBase58());
  const status = await veto.status();
  assert.equal(status.mint, w.mint.publicKey.toBase58());
  assert.equal(status.source, w.source.publicKey.toBase58());
  assert.equal(status.agent, w.agent.publicKey.toBase58());
  assert.equal(status.merchant, w.merchant.publicKey.toBase58());
});

test("fromMandate refuses a keypair that is not the rule's agent", async () => {
  const w = world();
  const other = Keypair.generate();
  await assert.rejects(() => VetoAgent.fromMandate(w.connection, w.mandate, other), /mandate agent/);
});

test("fromMandate rejects a mandate owned by another program", async () => {
  const w = world();
  const stored = w.fake.accounts.get(w.mandate.toBase58());
  assert.ok(stored);
  w.fake.accounts.set(w.mandate.toBase58(), {
    data: stored.data,
    owner: Keypair.generate().publicKey,
    lamports: stored.lamports,
  });
  await assert.rejects(
    () => VetoAgent.fromMandate(w.connection, w.mandate.toBase58(), w.agent),
    /not owned by program/,
  );
});

test("fromMandate rejects a mandate account that is not on the chain", async () => {
  const w = world();
  await assert.rejects(
    () => VetoAgent.fromMandate(w.connection, Keypair.generate().publicKey, w.agent),
    /not found/,
  );
});

test("fromMandate rejects an account that is not a mandate", async () => {
  const w = world();
  const stored = w.fake.accounts.get(w.mandate.toBase58());
  assert.ok(stored);
  w.fake.accounts.set(w.mandate.toBase58(), {
    data: Buffer.alloc(80),
    owner: PROGRAM_ID,
    lamports: stored.lamports,
  });
  await assert.rejects(() => VetoAgent.fromMandate(w.connection, w.mandate, w.agent), /discriminator/);
});

test("fromMandate rejects a connection whose genesis hash is not a known cluster", async () => {
  const w = world();
  w.fake.genesisHash = "not-a-cluster-genesis";
  await assert.rejects(
    () => VetoAgent.fromMandate(w.connection, w.mandate, w.agent),
    /devnet, testnet, or mainnet-beta/,
  );
});

test("fromMandate rejects a connection that cannot report its genesis hash", async () => {
  const w = world();
  w.fake.genesisError = new Error("boom");
  await assert.rejects(
    () => VetoAgent.fromMandate(w.connection, w.mandate, w.agent),
    /genesis hash could not be read/,
  );
});

test("fromMandate rejects a rule whose source token account is missing", async () => {
  const w = world();
  w.fake.accounts.delete(w.source.publicKey.toBase58());
  await assert.rejects(
    () => VetoAgent.fromMandate(w.connection, w.mandate, w.agent),
    /source token account/,
  );
});

test("fromMandate rejects a rule whose mint account is missing", async () => {
  const w = world();
  w.fake.accounts.delete(w.mint.publicKey.toBase58());
  await assert.rejects(() => VetoAgent.fromMandate(w.connection, w.mandate, w.agent), /mint account/);
});

test("fromMandate rejects a mint the source token program does not own", async () => {
  const w = world();
  const stored = w.fake.accounts.get(w.mint.publicKey.toBase58());
  assert.ok(stored);
  w.fake.accounts.set(w.mint.publicKey.toBase58(), {
    data: stored.data,
    owner: Keypair.generate().publicKey,
    lamports: stored.lamports,
  });
  await assert.rejects(
    () => VetoAgent.fromMandate(w.connection, w.mandate, w.agent),
    /not owned by the source token program/,
  );
});

test("fromMandate rejects a rule whose payee token account cannot be resolved", async () => {
  const w = world();
  w.fake.tokenAccounts.length = 0;
  await assert.rejects(
    () => VetoAgent.fromMandate(w.connection, w.mandate, w.agent),
    /no token account/,
  );
});
