// Critic fixtures, PR 96 round 2, issue 93 (the walk after 93c8fcd).
//
// One ring of three nonces, one mandate history of three transactions, three
// runs. Each run counts the signature listings and the transactions read.
//
//   G1  journal holds every ring nonce      reads nothing
//   G2  journal misses the newest nonce     the walk runs, names the missing
//                                           row with its real signature, and
//                                           the count is reported (see the
//                                           round 2 review for what it was)
//   G3  journal holds nothing               every row is rebuilt and every
//                                           row names its own transaction
//   G4  no ledger account yet               nothing to repair, nothing read
//
// G2 asserts only what must hold. The number of transactions it reads is
// printed so the review can quote it; the fix walks the full history when a
// single nonce is missing, and whether that is acceptable is argued in the
// review, not pinned here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { chainDecisionToRow, fetchChainDecisions, RECOVERED_SIGNATURE } from "./journalRepair.js";

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
const N3 = 1789862400n;

const RING = ledgerBytes([
  { kind: 1, nonce: N1, amount: 446000n, ts: 1789855205n, reason: 0 },
  { kind: 2, nonce: N2, amount: 6232500n, ts: 1789858805n, reason: 5 },
  { kind: 1, nonce: N3, amount: 501000n, ts: 1789862405n, reason: 0 },
]);

const TXS: Record<string, ReturnType<typeof chargeTx>> = {
  "sig-n3-paid": chargeTx(programId, 501000n, N3, ["Program log: VETO PAID amount=501000"], 1789862405),
  "sig-n2-refused": chargeTx(
    programId,
    6232500n,
    N2,
    ["Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=6232500 per_tx_max=500000 remaining=1 override_to_clear=6232500"],
    1789858805,
  ),
  "sig-n1-paid": chargeTx(programId, 446000n, N1, ["Program log: VETO PAID amount=446000"], 1789855205),
};

function run(held: Set<bigint>, ledger: Buffer | null) {
  const calls = { sigs: 0, txs: 0, read: [] as string[] };
  const connection = {
    async getAccountInfo() {
      return ledger === null ? null : { data: ledger };
    },
    async getSignaturesForAddress() {
      calls.sigs += 1;
      // Newest first, as the RPC returns them.
      return [
        { signature: "sig-n3-paid", err: null, blockTime: 1789862405 },
        { signature: "sig-n2-refused", err: null, blockTime: 1789858805 },
        { signature: "sig-n1-paid", err: null, blockTime: 1789855205 },
      ];
    },
    async getTransaction(signature: string) {
      calls.txs += 1;
      calls.read.push(signature);
      return TXS[signature] ?? null;
    },
  };
  const entries = fetchChainDecisions({
    connection,
    programId,
    owner,
    mandateId: 1n,
    hasNonce: (nonce: bigint) => held.has(nonce),
  });
  return { calls, entries };
}

test("critic r2 G1: journal holds every ring nonce, the run reads no signature and no transaction", async () => {
  const { calls, entries } = run(new Set([N1, N2, N3]), RING);
  const rows = (await entries).map(chainDecisionToRow);
  assert.equal(calls.sigs, 0);
  assert.equal(calls.txs, 0);
  assert.deepEqual(
    rows.map((r) => [r.nonce, r.decision, r.signature]),
    [
      [N1.toString(), "paid", RECOVERED_SIGNATURE],
      [N2.toString(), "refused", RECOVERED_SIGNATURE],
      [N3.toString(), "paid", RECOVERED_SIGNATURE],
    ],
    "the ring rows come back unnamed; the caller drops them through hasNonce",
  );
});

test("critic r2 G2: journal misses one nonce, the walk runs and names that row with its real signature", async () => {
  const { calls, entries } = run(new Set([N1, N2]), RING);
  const rows = (await entries).map(chainDecisionToRow);
  const missing = rows.find((r) => r.nonce === N3.toString());
  assert.equal(calls.sigs >= 1, true, "a missing nonce must trigger the walk");
  assert.equal(missing?.decision, "paid");
  assert.equal(missing?.signature, "sig-n3-paid", "the missing row names the transaction that produced it");
  // Reported, not pinned: how many transactions the walk read to fill one gap.
  // The gap is the newest transaction, so one read would have sufficed.
  console.log(`critic r2 G2: transactions read to fill one missing nonce: ${calls.txs} of ${Object.keys(TXS).length} (${calls.read.join(", ")})`);
});

test("critic r2 G3: journal holds nothing, every row is rebuilt and names its own transaction", async () => {
  const { calls, entries } = run(new Set(), RING);
  const rows = (await entries).map(chainDecisionToRow);
  assert.equal(calls.sigs, 1, "one page of history");
  assert.equal(calls.txs, 3, "every transaction in the history is read once");
  assert.deepEqual(
    rows.map((r) => [r.nonce, r.decision, r.signature, r.amount]),
    [
      [N1.toString(), "paid", "sig-n1-paid", "446000"],
      [N2.toString(), "refused", "sig-n2-refused", "6232500"],
      [N3.toString(), "paid", "sig-n3-paid", "501000"],
    ],
  );
  assert.equal(rows.some((r) => r.signature === RECOVERED_SIGNATURE), false, "no placeholder when the walk saw everything");
});

test("critic r2 G4: no ledger account yet, nothing to repair and nothing read", async () => {
  const { calls, entries } = run(new Set(), null);
  assert.deepEqual(await entries, []);
  assert.equal(calls.sigs, 0);
  assert.equal(calls.txs, 0);
});
