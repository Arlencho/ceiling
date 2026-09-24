// Security critic, PR 203 round 3 (second security round). After the round 1
// fix the block cannot name the program. These cases try the levers that are
// left: a chain that lies but reports the right genesis, the programId option,
// cluster names that are Object.prototype keys, and a mint under another program.
// A case that reaches assert.fail describes what the head lets through.
import assert from "node:assert/strict";
import test from "node:test";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { loadAgentConfig, type AgentConfig } from "./config.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import {
  chargeData,
  encodeBase58,
  framed,
  mandateBytes,
  paidLog,
  tokenAccountData,
  world,
  type World,
} from "./testkit.js";

function block(w: World, over: Partial<AgentConfig> = {}): AgentConfig {
  return loadAgentConfig({
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
  });
}

/** A chain that presents a Mandate-shaped account naming the agent, drawing from the agent's own ATA. */
function plantMandate(w: World, owner: PublicKey): { mandate: PublicKey; agentAta: PublicKey; attackerAta: PublicKey } {
  const attacker = Keypair.generate();
  const mandate = Keypair.generate().publicKey;
  const agentAta = getAssociatedTokenAddressSync(w.mint.publicKey, w.agent.publicKey, true, TOKEN_PROGRAM_ID);
  const attackerAta = getAssociatedTokenAddressSync(w.mint.publicKey, attacker.publicKey, true, TOKEN_PROGRAM_ID);
  w.fake.accounts.set(mandate.toBase58(), {
    data: mandateBytes({
      owner: attacker.publicKey,
      agent: w.agent.publicKey,
      mint: w.mint.publicKey,
      source: agentAta,
      merchant: attacker.publicKey,
      mandateId: 1n,
      cap: 1_000_000_000_000n,
      spent: 0n,
      perTxMax: 1_000_000_000_000n,
      expiresAt: 1_797_805_739n,
      overrideAmount: 0n,
      overrideNonce: 0n,
      lastNonce: 0n,
      purpose: "looks like a rule",
      status: 0,
      spendCount: 0,
      refusalCount: 0,
      bump: 255,
    }),
    owner,
    lamports: 2_225_040,
  });
  w.fake.accounts.set(agentAta.toBase58(), {
    data: tokenAccountData(w.mint.publicKey, w.agent.publicKey),
    owner: TOKEN_PROGRAM_ID,
    lamports: 1,
  });
  w.fake.accounts.set(attackerAta.toBase58(), {
    data: tokenAccountData(w.mint.publicKey, attacker.publicKey),
    owner: TOKEN_PROGRAM_ID,
    lamports: 1,
  });
  return { mandate, agentAta, attackerAta };
}

function registerPaid(w: World, program: PublicKey, mandate: PublicKey, keys: PublicKey[], amount: bigint, nonce: bigint): void {
  w.fake.signature = "sig-r3";
  w.fake.transactions.set("sig-r3", {
    slot: 91,
    blockTime: 1_700_000_000,
    meta: { err: null, logMessages: framed(program.toBase58(), [paidLog(mandate, amount, nonce, amount)]) },
    transaction: {
      signatures: ["sig-r3"],
      message: {
        accountKeys: keys.map((key) => key.toBase58()),
        instructions: [{ programIdIndex: 7, accounts: [0, 1, 2, 3, 4, 5, 6], data: encodeBase58(chargeData(amount, nonce)) }],
      },
    },
  });
}

test("R4: a chain that lies with the right genesis still gets a charge signed only for the Veto program", async () => {
  const w = world();
  const planted = plantMandate(w, PROGRAM_ID);
  const config = block(w, {
    mandate: planted.mandate.toBase58(),
    sourceTokenAccount: planted.agentAta.toBase58(),
    payeeTokenAccount: planted.attackerAta.toBase58(),
  });
  // The chain is the authority the direction accepted: it reports the devnet
  // genesis and an account it claims the Veto program owns. fromConfig accepts.
  const veto = await VetoAgent.fromConfig(config, w.agent, w.connection);
  const amount = 5_000_000n;
  const nonce = 1n;
  const keys = [
    w.agent.publicKey,
    planted.mandate,
    ledgerPda(PROGRAM_ID, planted.mandate),
    planted.agentAta,
    planted.attackerAta,
    w.mint.publicKey,
    TOKEN_PROGRAM_ID,
    PROGRAM_ID,
  ];
  registerPaid(w, PROGRAM_ID, planted.mandate, keys, amount, nonce);
  await veto.charge({ amount, nonce });
  const sent = w.fake.sent[0];
  assert.ok(sent, "charge() sent a transaction");
  const signed = Transaction.from(sent);
  assert.equal(signed.instructions.length, 1, "one instruction");
  const ix = signed.instructions[0];
  assert.ok(ix);
  // The program is pinned whatever the chain said, so the transfer authority
  // on chain is the mandate PDA re-derived under crate::ID: a planted account
  // at a random address fails that derivation, and a real one only spends a
  // source its owner delegated. The agent's own ATA is never that source.
  assert.ok(ix.programId.equals(PROGRAM_ID), `instruction program is ${ix.programId.toBase58()}`);
  assert.deepEqual(
    ix.keys.map((meta) => meta.pubkey.toBase58()),
    keys.slice(0, 7).map((key) => key.toBase58()),
    "account list is exactly the seven the Veto charge takes, in order",
  );
  // The fee payer is writable in every compiled message; the meta at agent.ts:214 is not the wire form.
  assert.ok(ix.keys[0]?.isSigner, "agent signs");
  assert.deepEqual(
    signed.signatures.filter((entry) => entry.signature !== null).map((entry) => entry.publicKey.toBase58()),
    [w.agent.publicKey.toBase58()],
    "the agent is the only signer",
  );
});

test("R5: the only way to another program is the programId option in code, never the block", async () => {
  const w = world();
  const foreign = Keypair.generate().publicKey;
  const planted = plantMandate(w, foreign);
  const crafted = {
    mandate: planted.mandate.toBase58(),
    sourceTokenAccount: planted.agentAta.toBase58(),
    payeeTokenAccount: planted.attackerAta.toBase58(),
  };
  // Block names the Veto program, chain says the account belongs to another: refused on ownership.
  await assert.rejects(
    () => VetoAgent.fromConfig(block(w, crafted), w.agent, w.connection),
    new RegExp(`is not owned by program ${PROGRAM_ID.toBase58()}`),
  );
  // Block names the foreign program: refused on the pin before any read.
  const reads = w.fake.accounts.size;
  await assert.rejects(
    () => VetoAgent.fromConfig(block(w, { ...crafted, programId: foreign.toBase58() }), w.agent, w.connection),
    /does not equal the Veto program/,
  );
  assert.equal(w.fake.accounts.size, reads);
  // Block names the foreign program and the operator passes the same id in code: accepted, signed for that id.
  const veto = await VetoAgent.fromConfig(
    block(w, { ...crafted, programId: foreign.toBase58() }),
    w.agent,
    w.connection,
    { programId: foreign },
  );
  const amount = 1n;
  const nonce = 1n;
  const keys = [
    w.agent.publicKey,
    planted.mandate,
    ledgerPda(foreign, planted.mandate),
    planted.agentAta,
    planted.attackerAta,
    w.mint.publicKey,
    TOKEN_PROGRAM_ID,
    foreign,
  ];
  registerPaid(w, foreign, planted.mandate, keys, amount, nonce);
  const outcome = await veto.charge({ amount, nonce });
  assert.equal(outcome.kind, "paid");
  const ix = Transaction.from(w.fake.sent[0] ?? Buffer.alloc(0)).instructions[0];
  assert.ok(ix?.programId.equals(foreign), "signed for the id the operator passed in code");
  // And the option does not let the block widen it: block says Veto, option says foreign.
  await assert.rejects(
    () => VetoAgent.fromConfig(block(w, crafted), w.agent, w.connection, { programId: foreign }),
    /does not equal the Veto program/,
  );
});

test("R6: cluster names that are Object.prototype keys or unknown are refused before any read", async () => {
  const w = world();
  for (const cluster of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "localnet", "", "Devnet"]) {
    // Built by hand: loadAgentConfig would already refuse these, fromConfig must too.
    const config: AgentConfig = { ...block(w), cluster };
    await assert.rejects(() => VetoAgent.fromConfig(config, w.agent, w.connection), /cluster/, `cluster ${JSON.stringify(cluster)}`);
  }
  assert.equal(w.fake.sent.length, 0);
});

test(
  "R6: an Object.prototype name is refused on the unknown-cluster branch, not by the genesis comparison",
  { todo: "LOW on 78a3d0f: agent.ts:345 reads CLUSTER_GENESIS[cluster] through the prototype, so \"constructor\" is refused as a genesis mismatch" },
  async () => {
    const w = world();
    for (const cluster of ["constructor", "toString", "valueOf"]) {
      const config: AgentConfig = { ...block(w), cluster };
      await assert.rejects(
        () => VetoAgent.fromConfig(config, w.agent, w.connection),
        /must be devnet, testnet, or mainnet-beta/,
        `cluster ${JSON.stringify(cluster)}`,
      );
    }
  },
);

test("R6: a block cluster that is not the genesis of the endpoint in use is refused", async () => {
  const w = world();
  // The fake reports the devnet genesis. Every other named cluster must be refused.
  for (const cluster of ["testnet", "mainnet-beta"]) {
    await assert.rejects(
      () => VetoAgent.fromConfig(block(w, { cluster }), w.agent, w.connection),
      /does not match genesis hash/,
      cluster,
    );
  }
  // A genesis read that fails is a refusal, not a pass.
  Object.assign(w.fake, {
    getGenesisHash: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(() => VetoAgent.fromConfig(block(w), w.agent, w.connection), /genesis hash could not be read/);
});

test("R7: a mint the source token program does not own, or too short to carry decimals, is refused", async () => {
  const w = world();
  const other = Keypair.generate().publicKey;
  const data = Buffer.alloc(82);
  data.writeUInt8(6, 44);
  w.fake.accounts.set(w.mint.publicKey.toBase58(), { data, owner: other, lamports: 1 });
  await assert.rejects(
    () => VetoAgent.fromConfig(block(w), w.agent, w.connection),
    /is not owned by the source token program/,
  );
  w.fake.accounts.set(w.mint.publicKey.toBase58(), { data: Buffer.alloc(44), owner: TOKEN_PROGRAM_ID, lamports: 1 });
  await assert.rejects(() => VetoAgent.fromConfig(block(w), w.agent, w.connection), /too short to read decimals/);
  w.fake.accounts.delete(w.mint.publicKey.toBase58());
  await assert.rejects(() => VetoAgent.fromConfig(block(w), w.agent, w.connection), /mint account .* not found/);
});

test("R8: the block cannot move the payee or the source off what the mandate names", async () => {
  const w = world();
  const stranger = Keypair.generate();
  const strangerAta = getAssociatedTokenAddressSync(w.mint.publicKey, stranger.publicKey, true, TOKEN_PROGRAM_ID);
  w.fake.accounts.set(strangerAta.toBase58(), {
    data: tokenAccountData(w.mint.publicKey, stranger.publicKey),
    owner: TOKEN_PROGRAM_ID,
    lamports: 1,
  });
  await assert.rejects(
    () => VetoAgent.fromConfig(block(w, { payeeTokenAccount: strangerAta.toBase58() }), w.agent, w.connection),
    /payee token account .* does not equal the config payee/,
  );
  await assert.rejects(
    () => VetoAgent.fromConfig(block(w, { sourceTokenAccount: strangerAta.toBase58() }), w.agent, w.connection),
    /source token account .* does not equal the config source/,
  );
  // The control: the block that matches the chain loads and charges the payee the chain names.
  const veto = await VetoAgent.fromConfig(block(w), w.agent, w.connection);
  const amount = 1n;
  const nonce = 1n;
  const keys = [
    w.agent.publicKey,
    w.mandate,
    ledgerPda(PROGRAM_ID, w.mandate),
    w.source.publicKey,
    w.destination.publicKey,
    w.mint.publicKey,
    TOKEN_PROGRAM_ID,
    PROGRAM_ID,
  ];
  registerPaid(w, PROGRAM_ID, w.mandate, keys, amount, nonce);
  await veto.charge({ amount, nonce });
  const ix = Transaction.from(w.fake.sent[0] ?? Buffer.alloc(0)).instructions[0];
  assert.ok(ix?.keys[4]?.pubkey.equals(w.destination.publicKey), "destination is the chain's payee");
  assert.equal(w.fake.sent.length, 1);
});
