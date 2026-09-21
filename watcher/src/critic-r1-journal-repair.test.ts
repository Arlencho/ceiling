// Critic fixtures, PR 96 round 1, issue 93.
//
// F1 (RED on the branch): fetchChainDecisions runs on every Cloud Run start
// where a journal store is configured (index.ts:64-71), not only after a lost
// journal. On the branch it now lists every signature that ever touched the
// mandate and fetches every transaction, hourly, with results that
// repairJournalFromChain discards through hasNonce. One transaction per past
// decision per run, growing without bound. The caller must be able to say
// what it already has, and a walk with nothing to repair must read nothing.
// The parameter name below is a proposal; any shape that lets the call site
// in index.ts skip the walk when the journal already holds every ring nonce
// satisfies this pin.
//
// F2, F3 (green pins): a refused charge does not advance the nonce
// (programs/veto/src/lib.rs:379-383), so one nonce can carry an older refused
// transaction and a newer paid one. The rebuilt row must be the paid one,
// naming the paid signature, in the newest-first order the RPC returns.
// A ring row the walk cannot see keeps the placeholder while its neighbour
// that the walk did find names its own transaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { fetchChainDecisions, RECOVERED_SIGNATURE, chainDecisionToRow } from "./journalRepair.js";

const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
const CHARGE_DISC = Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]);

function ledgerBytes(entries: Array<{ kind: number; nonce: bigint; amount: bigint; ts: bigint; reason: number }>): Buffer {
  const data = Buffer.alloc(8 + 40 + 32 * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  data.writeUInt32LE(entries.length, 8 + 32);
  data.writeUInt16LE(entries.length, 8 + 36);
  for (let i = 0; i < entries.length; i++) {
    const off = 8 + 40 + i * 72;
    const e = entries[i]!;
    data.writeBigInt64LE(e.ts, off);
    data.writeBigUInt64LE(e.amount, off + 8);
    data.writeBigUInt64LE(e.nonce, off + 48);
    data[off + 64] = e.kind;
    data[off + 65] = e.reason;
  }
  return data;
}

function u64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function chargeTx(programId: PublicKey, amount: bigint, nonce: bigint, logs: string[], blockTime: number) {
  return {
    slot: 1,
    blockTime,
    transaction: {
      message: {
        staticAccountKeys: [PublicKey.default, PublicKey.default, programId],
        compiledInstructions: [
          { programIdIndex: 2, accountKeyIndexes: [] as number[], data: Buffer.concat([CHARGE_DISC, u64(amount), u64(nonce)]) },
        ],
      },
    },
    meta: { err: null, logMessages: logs, loadedAddresses: { writable: [] as PublicKey[], readonly: [] as PublicKey[] } },
  };
}

const programId = new PublicKey(Buffer.alloc(32, 9));
const owner = new PublicKey(Buffer.alloc(32, 10));
const N1 = 1789855200n;
const N2 = 1789858800n;

test("critic r1 F1: a run whose journal already holds every ring nonce reads no transaction", async () => {
  const calls = { sigs: 0, txs: 0 };
  const data = ledgerBytes([
    { kind: 1, nonce: N1, amount: 446000n, ts: 1789855205n, reason: 0 },
    { kind: 2, nonce: N2, amount: 6232500n, ts: 1789858805n, reason: 5 },
  ]);
  const entries = await fetchChainDecisions({
    connection: {
      async getAccountInfo() {
        return { data };
      },
      async getSignaturesForAddress() {
        calls.sigs += 1;
        return [{ signature: "paid-sig", err: null, blockTime: 1789855205 }];
      },
      async getTransaction() {
        calls.txs += 1;
        return chargeTx(programId, 446000n, N1, ["Program log: VETO PAID amount=446000"], 1789855205);
      },
    },
    programId,
    owner,
    mandateId: 1n,
    hasNonce: (nonce: bigint) => nonce === N1 || nonce === N2,
  } as Parameters<typeof fetchChainDecisions>[0]);
  assert.equal(entries.length, 2, "the ring rows are still returned; the caller dedupes them");
  assert.equal(calls.sigs, 0, "nothing to repair, so no signature listing");
  assert.equal(calls.txs, 0, "nothing to repair, so no transaction read");
});

test("critic r1 F2: a nonce refused then paid names the paid transaction, not the refusal", async () => {
  const data = ledgerBytes([
    { kind: 2, nonce: N1, amount: 900000n, ts: 1789855205n, reason: 5 },
    { kind: 1, nonce: N1, amount: 900000n, ts: 1789855805n, reason: 0 },
  ]);
  const txs: Record<string, ReturnType<typeof chargeTx>> = {
    "paid-later": chargeTx(programId, 900000n, N1, ["Program log: VETO PAID amount=900000"], 1789855805),
    "refused-first": chargeTx(
      programId,
      900000n,
      N1,
      ["Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=900000 per_tx_max=500000 remaining=1 override_to_clear=900000"],
      1789855205,
    ),
  };
  const entries = await fetchChainDecisions({
    connection: {
      async getAccountInfo() {
        return { data };
      },
      async getSignaturesForAddress() {
        // Newest first, as getSignaturesForAddress returns them.
        return [
          { signature: "paid-later", err: null, blockTime: 1789855805 },
          { signature: "refused-first", err: null, blockTime: 1789855205 },
        ];
      },
      async getTransaction(signature: string) {
        return txs[signature] ?? null;
      },
    },
    programId,
    owner,
    mandateId: 1n,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.decision, "paid");
  assert.equal(entries[0]?.signature, "paid-later");
  assert.equal(chainDecisionToRow(entries[0]!).signature, "paid-later");
});

test("critic r1 F3: a row the walk found names its transaction while a ring row it cannot see keeps the placeholder", async () => {
  const data = ledgerBytes([
    { kind: 2, nonce: N1, amount: 6232500n, ts: 1789855205n, reason: 5 },
    { kind: 1, nonce: N2, amount: 446000n, ts: 1789858805n, reason: 0 },
  ]);
  const entries = await fetchChainDecisions({
    connection: {
      async getAccountInfo() {
        return { data };
      },
      async getSignaturesForAddress() {
        return [
          { signature: "paid-n2", err: null, blockTime: 1789858805 },
          { signature: "failed-tx-n1", err: { InstructionError: [0, "Custom"] }, blockTime: 1789855205 },
        ];
      },
      async getTransaction(signature: string) {
        if (signature === "paid-n2") return chargeTx(programId, 446000n, N2, ["Program log: VETO PAID amount=446000"], 1789858805);
        throw new Error(`a failed transaction is never fetched: ${signature}`);
      },
    },
    programId,
    owner,
    mandateId: 1n,
  });
  const rows = entries.map(chainDecisionToRow);
  assert.deepEqual(
    rows.map((r) => [r.nonce, r.decision, r.signature]),
    [
      [N1.toString(), "refused", RECOVERED_SIGNATURE],
      [N2.toString(), "paid", "paid-n2"],
    ],
  );
});
