import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { LOW_FEE_LAMPORTS, VetoAgent } from "./agent.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda, mandatePda } from "./layout.js";
import {
  TOKEN_PROGRAM,
  framed,
  legacyChargeTx,
  paidLog,
  refusedLog,
  tokenAccountData,
  world,
} from "./testkit.js";

function agentFor(w = world()) {
  return {
    w,
    veto: new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate }),
  };
}

function preload(
  w: ReturnType<typeof world>,
  logs: string[],
  amount: bigint,
  nonce: bigint,
  slot = 4242,
): void {
  w.fake.signature = "sig-charge";
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  w.fake.transactions.set(
    "sig-charge",
    legacyChargeTx({
      signature: "sig-charge",
      slot,
      blockTime: 1_700_000_000,
      logs,
      amount,
      nonce,
      keys: [
        w.agent.publicKey,
        w.mandate,
        ledger,
        w.source.publicKey,
        w.destination.publicKey,
        w.mint.publicKey,
        TOKEN_PROGRAM,
        PROGRAM_ID,
      ],
    }),
  );
}

test("constructing from an owner and mandate id uses the mandate PDA", () => {
  const w = world();
  const veto = new VetoAgent({
    connection: w.connection,
    agent: w.agent,
    owner: w.owner.publicKey,
    mandateId: w.mandateId,
  });
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(w.mandateId);
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), w.owner.publicKey.toBuffer(), le],
    PROGRAM_ID,
  );
  assert.equal(veto.mandate.toBase58(), expected.toBase58());
  assert.equal(veto.mandate.toBase58(), mandatePda(PROGRAM_ID, w.owner.publicKey, w.mandateId).toBase58());
});

test("VetoAgent requires a mandate address or an owner and mandate id", () => {
  const w = world();
  assert.throws(
    () => new VetoAgent({ connection: w.connection, agent: w.agent }),
    /pass a mandate address, or an owner and a mandate id/,
  );
});

test("charge submits the mandate's stored source, not the associated token account", async () => {
  const { w, veto } = agentFor();
  const amount = 10_000_001n;
  const nonce = 1n;
  preload(w, framed(PROGRAM_ID.toBase58(), [refusedLog(w.mandate, amount, nonce, 5, amount)]), amount, nonce);
  await veto.charge({ amount, nonce });
  const raw = w.fake.sent[0];
  assert.ok(raw);
  const ix = Transaction.from(raw).instructions[0];
  assert.ok(ix);
  const sourceAta = getAssociatedTokenAddressSync(w.mint.publicKey, w.owner.publicKey, false, TOKEN_PROGRAM);
  assert.notEqual(w.source.publicKey.toBase58(), sourceAta.toBase58());
  assert.equal(ix.keys[3]?.pubkey.toBase58(), w.source.publicKey.toBase58());
  assert.equal(ix.keys[4]?.pubkey.toBase58(), w.destination.publicKey.toBase58());
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58());
  const idl = JSON.parse(readFileSync(fileURLToPath(new URL("../idl/veto.json", import.meta.url)), "utf8")) as {
    instructions: { name: string; discriminator: number[] }[];
  };
  const disc = Buffer.from(idl.instructions.find((item) => item.name === "charge")?.discriminator ?? []);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc);
  assert.equal(ix.data.readBigUInt64LE(8), amount);
  assert.equal(ix.data.readBigUInt64LE(16), nonce);
  assert.equal(w.fake.lastTokenFilter?.mint?.toBase58(), w.mint.publicKey.toBase58());
});

test("charge returns the refused decision from the Veto event", async () => {
  const { w, veto } = agentFor();
  const amount = 10_000_001n;
  const nonce = 1n;
  preload(
    w,
    framed(PROGRAM_ID.toBase58(), [
      `Program ${TOKEN_PROGRAM.toBase58()} invoke [2]`,
      paidLog(w.mandate, amount, nonce, amount),
      `Program ${TOKEN_PROGRAM.toBase58()} success`,
      refusedLog(w.mandate, amount, nonce, 5, amount),
    ]),
    amount,
    nonce,
    501,
  );
  const outcome = await veto.charge({ amount, nonce });
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.reasonCode, 5);
  assert.equal(outcome.reasonText, "over per-payment maximum");
  assert.equal(outcome.suggestedOverride, amount);
  assert.equal(outcome.signature, "sig-charge");
  assert.equal(outcome.slot, 501);
});

test("charge returns a paid decision from the Veto event", async () => {
  const { w, veto } = agentFor();
  const amount = 500n;
  const nonce = 2n;
  preload(w, framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, amount, nonce, amount)]), amount, nonce, 90);
  const outcome = await veto.charge({ amount, nonce });
  assert.deepEqual(outcome, {
    kind: "paid",
    reasonCode: 0,
    reasonText: "ok",
    suggestedOverride: 0n,
    signature: "sig-charge",
    slot: 90,
  });
});

test("charge throws when the transaction carries no attributable Veto decision", async () => {
  const { w, veto } = agentFor();
  preload(w, framed(PROGRAM_ID.toBase58(), ["Program log: hello"]), 1n, 1n);
  await assert.rejects(() => veto.charge({ amount: 1n, nonce: 1n }), /no attributable Veto decision/);
  assert.equal(w.fake.sent.length, 1);
});

test("charge throws when the only program data belongs to a sibling program", async () => {
  const { w, veto } = agentFor();
  const logs = [
    `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
    `Program ${TOKEN_PROGRAM.toBase58()} invoke [2]`,
    paidLog(w.mandate, 4n, 1n, 4n),
    `Program ${TOKEN_PROGRAM.toBase58()} success`,
    `Program ${PROGRAM_ID.toBase58()} success`,
  ];
  preload(w, logs, 4n, 1n);
  await assert.rejects(() => veto.charge({ amount: 4n, nonce: 1n }), /no attributable Veto decision/);
});

test("charge throws when one transaction has two Veto decisions for the nonce", async () => {
  const { w, veto } = agentFor();
  const amount = 5n;
  const nonce = 1n;
  preload(
    w,
    framed(PROGRAM_ID.toBase58(), [
      refusedLog(w.mandate, amount, nonce, 5, amount),
      refusedLog(w.mandate, amount, nonce, 6, 0n),
    ]),
    amount,
    nonce,
  );
  await assert.rejects(
    () => veto.charge({ amount, nonce }),
    /carries 2 Veto decisions for nonce 1/,
  );
});

test("charge does not submit when the signer is not the agent on the mandate", async () => {
  const w = world();
  const stranger = Keypair.generate();
  const veto = new VetoAgent({ connection: w.connection, agent: stranger, mandate: w.mandate });
  await assert.rejects(() => veto.charge({ amount: 1n, nonce: 1n }), /signer is not the agent/);
  assert.equal(w.fake.sent.length, 0);
});

test("charge refuses to guess when the merchant has two token accounts for the mint", async () => {
  const w = world();
  const extra = Keypair.generate().publicKey;
  w.fake.tokenAccounts.push({
    owner: w.merchant.publicKey.toBase58(),
    mint: w.mint.publicKey.toBase58(),
    pubkey: extra,
    data: tokenAccountData(w.mint.publicKey, w.merchant.publicKey),
  });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  await assert.rejects(
    () => veto.charge({ amount: 1n, nonce: 1n }),
    new RegExp(`${w.destination.publicKey.toBase58()}.*${extra.toBase58()}|${extra.toBase58()}.*${w.destination.publicKey.toBase58()}`),
  );
  assert.equal(w.fake.sent.length, 0);
});

test("charge selects the token-2022 account whose mint matches", async () => {
  const w = world({ tokenProgram: TOKEN_2022_PROGRAM_ID });
  const otherMint = Keypair.generate();
  const wrong = Keypair.generate().publicKey;
  w.fake.tokenAccounts.push({
    owner: w.merchant.publicKey.toBase58(),
    mint: otherMint.publicKey.toBase58(),
    pubkey: wrong,
    data: tokenAccountData(otherMint.publicKey, w.merchant.publicKey),
  });
  const amount = 3n;
  const nonce = 1n;
  preload(w, framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, amount, nonce, amount)]), amount, nonce);
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  await veto.charge({ amount, nonce });
  assert.equal(w.fake.lastTokenFilter?.programId?.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  const ix = Transaction.from(w.fake.sent[0]!).instructions[0];
  assert.equal(ix?.keys[4]?.pubkey.toBase58(), w.destination.publicKey.toBase58());
  assert.equal(ix?.keys[6]?.pubkey.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
});

test("nextNonce is the mandate last_nonce plus one", async () => {
  const w = world({ lastNonce: 7n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  assert.equal(await veto.nextNonce(), 8n);
});

test("nextNonce throws when last_nonce is the maximum u64", async () => {
  const w = world({ lastNonce: (1n << 64n) - 1n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  await assert.rejects(() => veto.nextNonce(), /last_nonce is the maximum u64/);
});

test("status reports limits, spent, counts, expiry, and the agent SOL balance", async () => {
  const w = world({
    cap: 30n,
    spent: 4n,
    perTxMax: 10n,
    expiresAt: 99n,
    spendCount: 2,
    refusalCount: 8,
    lastNonce: 6n,
    balance: Number(LOW_FEE_LAMPORTS),
  });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, owner: w.owner.publicKey, mandateId: 3 });
  const status = await veto.status();
  assert.equal(status.mandate, w.mandate.toBase58());
  assert.equal(status.cap, 30n);
  assert.equal(status.perTxMax, 10n);
  assert.equal(status.spent, 4n);
  assert.equal(status.remaining, 26n);
  assert.equal(status.expiresAt, 99n);
  assert.equal(status.spendCount, 2);
  assert.equal(status.refusalCount, 8);
  assert.equal(status.lastNonce, 6n);
  assert.equal(status.source, w.source.publicKey.toBase58());
  assert.equal(status.agentLamports, LOW_FEE_LAMPORTS);
  assert.equal(status.feeWarning, null);
});

test("status warns when the agent SOL balance is under 100000 lamports", async () => {
  assert.equal(LOW_FEE_LAMPORTS, 100_000n);
  const w = world({ balance: 99_999 });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const status = await veto.status();
  assert.equal(status.agentLamports, 99_999n);
  assert.equal(
    status.feeWarning,
    "agent SOL balance is 99999 lamports, under 100000 lamports (20 base fees of 5000). The agent pays the transaction fee.",
  );
});
