// Security critic, PR 203 round 1. A copied agent block is untrusted input.
// Each case builds the block the way an attacker would and asks the loader to
// refuse it. A case that reaches assert.fail describes what the head lets through.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { isTradeAgentConfig, loadAgentConfig, type AgentConfig } from "./config.js";
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

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

function block(w: World, over: Partial<AgentConfig> = {}): AgentConfig {
  const loaded = loadAgentConfig({
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
  if (isTradeAgentConfig(loaded)) {
    throw new Error("test built a trade block");
  }
  return loaded;
}

/** A mint account: 82 bytes, decimals at byte 44, owned by the token program. */
function mintAccount(decimals: number): { data: Buffer; owner: PublicKey; lamports: number } {
  const data = Buffer.alloc(82);
  data.writeUInt8(decimals, 44);
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 1 };
}

test("R1: a block naming another program is refused before the agent signs for it", async () => {
  const w = world();
  const attacker = Keypair.generate();
  const foreignProgram = Keypair.generate().publicKey;
  const foreignMandate = Keypair.generate().publicKey;
  // The victim agent holds a token account of its own for this mint.
  const agentAta = getAssociatedTokenAddressSync(w.mint.publicKey, w.agent.publicKey, true, TOKEN_PROGRAM_ID);
  const attackerAta = getAssociatedTokenAddressSync(w.mint.publicKey, attacker.publicKey, true, TOKEN_PROGRAM_ID);
  w.fake.accounts.set(foreignMandate.toBase58(), {
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
    owner: foreignProgram,
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
  const crafted = {
    mandate: foreignMandate.toBase58(),
    sourceTokenAccount: agentAta.toBase58(),
    payeeTokenAccount: attackerAta.toBase58(),
  };

  // Control: the same account under the Veto program id is refused, so the
  // ownership check exists. It is keyed on the block's own programId field.
  await assert.rejects(
    () => VetoAgent.fromConfig(block(w, crafted), w.agent, w.connection),
    /not owned by program/,
  );

  const config = block(w, { ...crafted, programId: foreignProgram.toBase58() });
  let veto: VetoAgent | undefined;
  try {
    veto = await VetoAgent.fromConfig(config, w.agent, w.connection);
  } catch (err) {
    assert.match(err instanceof Error ? err.message : String(err), /program/);
    return;
  }

  // The head accepted the block. Show what the agent then signs and reports.
  const amount = 5_000_000n;
  const nonce = 1n;
  const keys = [
    w.agent.publicKey,
    foreignMandate,
    ledgerPda(foreignProgram, foreignMandate),
    agentAta,
    attackerAta,
    w.mint.publicKey,
    TOKEN_PROGRAM_ID,
    foreignProgram,
  ].map((key) => key.toBase58());
  w.fake.signature = "sig-foreign";
  w.fake.transactions.set("sig-foreign", {
    slot: 77,
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      logMessages: framed(foreignProgram.toBase58(), [paidLog(foreignMandate, amount, nonce, amount)]),
    },
    transaction: {
      signatures: ["sig-foreign"],
      message: {
        accountKeys: keys,
        instructions: [
          {
            programIdIndex: 7,
            accounts: [0, 1, 2, 3, 4, 5, 6],
            data: encodeBase58(chargeData(amount, nonce)),
          },
        ],
      },
    },
  });
  const outcome = await veto.charge({ amount, nonce });
  const sent = w.fake.sent[0];
  assert.ok(sent, "charge() sent a transaction");
  const signed = Transaction.from(sent);
  const ix = signed.instructions[0];
  assert.ok(ix);
  const agentSigned = signed.signatures.some(
    (entry) => entry.publicKey.equals(w.agent.publicKey) && entry.signature !== null,
  );
  const agentAtaMeta = ix.keys.find((meta) => meta.pubkey.equals(agentAta));
  assert.fail(
    [
      "fromConfig accepted a block whose programId is not the Veto program.",
      `charge() signed (agent signature present: ${String(agentSigned)}) an instruction for program ${ix.programId.toBase58()}`,
      `(Veto is ${PROGRAM_ID.toBase58()}) with the agent's own token account ${agentAta.toBase58()} passed writable=${String(agentAtaMeta?.isWritable)}`,
      `and the agent ${w.agent.publicKey.toBase58()} passed as signer=${String(ix.keys[0]?.isSigner)},`,
      `then reported "${outcome.kind}" for ${outcome.signature} at slot ${String(outcome.slot)} from that program's own log.`,
    ].join(" "),
  );
});

test("R2: mintDecimals in the block is checked against the mint account", async () => {
  const w = world();
  w.fake.accounts.set(w.mint.publicKey.toBase58(), mintAccount(6));
  const config = block(w, { mintDecimals: 0 });
  await assert.rejects(() => VetoAgent.fromConfig(config, w.agent, w.connection), /decimals/);
});

test("R2: cluster in the block is checked against the genesis hash", async () => {
  const w = world();
  w.fake.accounts.set(w.mint.publicKey.toBase58(), mintAccount(6));
  Object.assign(w.fake, { getGenesisHash: async () => MAINNET_GENESIS });
  const config = block(w, { cluster: "devnet" });
  await assert.rejects(() => VetoAgent.fromConfig(config, w.agent, w.connection), /cluster/);
});

test("R3: a block rpcUrl that does not report the cluster genesis is refused, and a caller connection wins", async () => {
  const w = world();
  const seen: { method: string; address: string }[] = [];
  const stored = (address: string): { data: Buffer; owner: PublicKey; lamports: number } | null => {
    const hit = w.fake.accounts.get(address);
    if (hit) return hit;
    const row = w.fake.tokenAccounts.find((entry) => entry.pubkey.toBase58() === address);
    return row ? { data: row.data, owner: TOKEN_PROGRAM_ID, lamports: 1 } : null;
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const address = String(rpc.params[0]);
      seen.push({ method: rpc.method, address });
      const account = stored(address);
      const value = account
        ? {
            data: [account.data.toString("base64"), "base64"],
            executable: false,
            lamports: account.lamports,
            owner: account.owner.toBase58(),
            rentEpoch: 0,
            space: account.data.length,
          }
        : null;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    // The world's destination is the merchant's only token account, not the ATA,
    // so give the merchant an ATA the caller connection can answer directly.
    const ata = getAssociatedTokenAddressSync(w.mint.publicKey, w.merchant.publicKey, true, TOKEN_PROGRAM_ID);
    w.fake.accounts.set(ata.toBase58(), {
      data: tokenAccountData(w.mint.publicKey, w.merchant.publicKey),
      owner: TOKEN_PROGRAM_ID,
      lamports: 1,
    });
    const config = block(w, { payeeTokenAccount: ata.toBase58(), rpcUrl: `http://127.0.0.1:${String(port)}` });
    // The server answers account reads and does not report the devnet genesis.
    await assert.rejects(() => VetoAgent.fromConfig(config, w.agent), /cluster/);
    assert.ok(
      seen.some((entry) => entry.method === "getGenesisHash"),
      "the block rpcUrl was not asked for its genesis hash",
    );
    const asked = seen.length;
    const veto = await VetoAgent.fromConfig(config, w.agent, w.connection);
    assert.equal(veto.connection, w.connection);
    assert.equal(veto.mandate.toBase58(), config.mandate);
    assert.equal(seen.length, asked);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
