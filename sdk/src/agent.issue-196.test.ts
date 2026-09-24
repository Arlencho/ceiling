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
});
