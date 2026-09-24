import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { DECISION_FETCH_BACKOFF_MS, DECISION_FETCH_CONCURRENCY, decisionsForMandate } from "./read.js";
import { TOKEN_PROGRAM, framed, legacyChargeTx, paidLog, world, type FakeConnection } from "./testkit.js";

function putPaid(fake: FakeConnection, w: ReturnType<typeof world>, signature: string, nonce: bigint): void {
  fake.transactions.set(
    signature,
    legacyChargeTx({
      signature,
      slot: Number(nonce),
      blockTime: Number(nonce) * 10,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, nonce, nonce, nonce)]),
      amount: nonce,
      nonce,
      keys: [
        w.agent.publicKey,
        w.mandate,
        ledgerPda(PROGRAM_ID, w.mandate),
        w.source.publicKey,
        w.destination.publicKey,
        w.mint.publicKey,
        TOKEN_PROGRAM,
        PROGRAM_ID,
      ],
    }),
  );
}

function listed(signature: string, slot: number): ConfirmedSignatureInfo {
  return { signature, slot, err: null, memo: null, blockTime: slot * 10, confirmationStatus: "confirmed" };
}

test("a page fetches transactions with a bounded number in flight", async () => {
  const w = world();
  const count = DECISION_FETCH_CONCURRENCY * 3;
  const signatures: ConfirmedSignatureInfo[] = [];
  for (let i = 0; i < count; i += 1) {
    const signature = `s${i}`;
    putPaid(w.fake, w, signature, BigInt(count - i));
    signatures.push(listed(signature, count - i));
  }
  w.fake.signatures = signatures;
  let inFlight = 0;
  let maxInFlight = 0;
  const real = w.fake.getTransaction.bind(w.fake);
  w.fake.getTransaction = async (signature: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      return await real(signature);
    } finally {
      inFlight -= 1;
    }
  };
  const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize: count });
  assert.equal(rows.length, count);
  assert.ok(DECISION_FETCH_CONCURRENCY > 1);
  assert.ok(DECISION_FETCH_CONCURRENCY < count);
  assert.equal(maxInFlight, DECISION_FETCH_CONCURRENCY);
});

test("a 429 on getTransaction is retried with backoff and then returns the decision", async () => {
  const w = world();
  putPaid(w.fake, w, "paid", 1n);
  w.fake.signatures = [listed("paid", 10)];
  let calls = 0;
  const delays: number[] = [];
  const real = w.fake.getTransaction.bind(w.fake);
  w.fake.getTransaction = async (signature: string) => {
    calls += 1;
    if (calls < 3) {
      throw new Error('429 : {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}}');
    }
    return real(signature);
  };
  const rows = await decisionsForMandate(w.connection, w.mandate, {
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(rows[0]?.signature, "paid");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [DECISION_FETCH_BACKOFF_MS, DECISION_FETCH_BACKOFF_MS * 2]);
});

test("a 429 that keeps coming is raised after the retry budget", async () => {
  const w = world();
  w.fake.signatures = [listed("paid", 10)];
  let calls = 0;
  const delays: number[] = [];
  w.fake.getTransaction = async () => {
    calls += 1;
    throw new Error("429 Too many requests");
  };
  await assert.rejects(
    () =>
      decisionsForMandate(w.connection, w.mandate, {
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    /429 Too many requests/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(delays, [DECISION_FETCH_BACKOFF_MS, DECISION_FETCH_BACKOFF_MS * 2, DECISION_FETCH_BACKOFF_MS * 4]);
});

test("an error that is not a 429 is not retried", async () => {
  const w = world();
  w.fake.signatures = [listed("paid", 10)];
  let calls = 0;
  w.fake.getTransaction = async () => {
    calls += 1;
    throw new Error("node down");
  };
  await assert.rejects(() => decisionsForMandate(w.connection, w.mandate, { sleep: async () => {} }), /node down/);
  assert.equal(calls, 1);
});
