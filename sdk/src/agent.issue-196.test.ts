import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Transaction } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { TOKEN_PROGRAM, framed, legacyChargeTx, paidLog, world } from "./testkit.js";

test("nextNonce returns the pending override nonce when it is above last_nonce", async () => {
  const w = world({ lastNonce: 4n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  assert.equal(await veto.nextNonce(), 9n);
});

test("nextNonce stays on last_nonce plus one when the override nonce is not above last_nonce", async () => {
  const w = world({ lastNonce: 4n, overrideNonce: 4n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  assert.equal(await veto.nextNonce(), 5n);
});

test("status returns the override amount and nonce from the mandate", async () => {
  const w = world({ lastNonce: 4n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const status = await veto.status();
  assert.equal(status.overrideAmount, 12_000n);
  assert.equal(status.overrideNonce, 9n);
  assert.equal(status.lastNonce, 4n);
});

test("status returns zero override fields when no override is pending", async () => {
  const w = world({ lastNonce: 2n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const status = await veto.status();
  assert.equal(status.overrideAmount, 0n);
  assert.equal(status.overrideNonce, 0n);
});

test("a retry of a refused charge submits the pending override nonce", async () => {
  const amount = 12_000n;
  const w = world({ lastNonce: 4n, perTxMax: 10n, overrideNonce: 9n, overrideAmount: amount });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const nonce = await veto.nextNonce();
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  w.fake.signature = "sig-retry";
  w.fake.transactions.set(
    "sig-retry",
    legacyChargeTx({
      signature: "sig-retry",
      slot: 70,
      blockTime: 1_700_000_100,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, amount, nonce, amount)]),
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
  await veto.charge({ amount, nonce });
  const raw = w.fake.sent[0];
  assert.ok(raw);
  const ix = Transaction.from(raw).instructions[0];
  assert.ok(ix);
  assert.equal(ix.data.readBigUInt64LE(16), 9n);
});

test("the sdk README tells an agent how to retry after the owner grants an override", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.match(readme, /overrideNonce/);
  assert.match(readme, /overrideAmount/);
  assert.match(readme, /nextNonce\(\)/);
  assert.match(readme, /owner grants an override/i);
  assert.match(readme, /Any paid charge at that pending override nonce clears the override/);
  assert.match(readme, /sends the retry first/);
  assert.match(readme, /refusedAmount <= status\.overrideAmount/);
  assert.match(readme, /amount: refusedAmount/);
  assert.match(readme, /guardPendingOverride: true/);
});

function preloadPaid(w: ReturnType<typeof world>, amount: bigint, nonce: bigint): void {
  w.fake.signature = "sig-guard";
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  w.fake.transactions.set(
    "sig-guard",
    legacyChargeTx({
      signature: "sig-guard",
      slot: 80,
      blockTime: 1_700_000_200,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, amount, nonce, amount)]),
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

function wireAmountAndNonce(raw: Buffer): { amount: bigint; nonce: bigint } {
  const ix = Transaction.from(raw).instructions[0];
  assert.ok(ix);
  return { amount: ix.data.readBigUInt64LE(8), nonce: ix.data.readBigUInt64LE(16) };
}

test("guardPendingOverride refuses a different amount at a pending override nonce before sending", async () => {
  const w = world({ lastNonce: 4n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  await assert.rejects(
    () => veto.charge({ amount: 1_000n, nonce: 9n, guardPendingOverride: true }),
    /pending override for 12000 base units, refusing 1000/,
  );
  assert.equal(w.fake.sent.length, 0);
});

test("guardPendingOverride sends the refused amount when it equals the pending override", async () => {
  const amount = 12_000n;
  const w = world({ lastNonce: 4n, perTxMax: 10n, overrideNonce: 9n, overrideAmount: amount });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  preloadPaid(w, amount, 9n);
  await veto.charge({ amount, nonce: 9n, guardPendingOverride: true });
  const raw = w.fake.sent[0];
  assert.ok(raw);
  assert.deepEqual(wireAmountAndNonce(raw), { amount, nonce: 9n });
});

test("without guardPendingOverride a smaller charge at the pending override nonce is still sent", async () => {
  const w = world({ lastNonce: 4n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  preloadPaid(w, 1_000n, 9n);
  await veto.charge({ amount: 1_000n, nonce: 9n });
  const raw = w.fake.sent[0];
  assert.ok(raw);
  assert.deepEqual(wireAmountAndNonce(raw), { amount: 1_000n, nonce: 9n });
});

test("guardPendingOverride does not block a charge whose nonce is not the pending override", async () => {
  const w = world({ lastNonce: 4n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  preloadPaid(w, 1_000n, 5n);
  await veto.charge({ amount: 1_000n, nonce: 5n, guardPendingOverride: true });
  const raw = w.fake.sent[0];
  assert.ok(raw);
  assert.deepEqual(wireAmountAndNonce(raw), { amount: 1_000n, nonce: 5n });
});

test("guardPendingOverride ignores an override that is not above last_nonce", async () => {
  const w = world({ lastNonce: 10n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  preloadPaid(w, 1_000n, 9n);
  await veto.charge({ amount: 1_000n, nonce: 9n, guardPendingOverride: true });
  const raw = w.fake.sent[0];
  assert.ok(raw);
  assert.deepEqual(wireAmountAndNonce(raw), { amount: 1_000n, nonce: 9n });
});
