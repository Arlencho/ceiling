// Security critic, PR 211 round 2.
// S6: a stranger flood that fills several pages in a row still leaves the
// older decision reachable by the documented walk, and every memo the stranger
// lands costs the reader one getTransaction while failed signatures cost none.
// S7: a failed transaction whose logs carry a Paid frame (the charge ran, a
// later instruction failed, state rolled back) is skipped without a fetch, is
// no decision, and still carries the cursor when it is the oldest listed.
// S8: a node that keeps rate limiting one signature of a batch makes the call
// throw after the retry ladder. It never resolves to a page missing that
// transaction, so a 429 cannot hide a decision behind a shorter result.
// S9, S10: guardPendingOverride refuses a different amount at the pending
// override nonce before anything reaches the wire, sends the exact amount,
// and leaves a charge at a nonce below the override alone.
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, Transaction, type ConfirmedSignatureInfo, type TransactionError } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { DECISION_FETCH_BACKOFF_MS, decisionsForMandate } from "./read.js";
import { TOKEN_PROGRAM, framed, legacyChargeTx, paidLog, world, type World } from "./testkit.js";

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function chargeKeys(w: World): PublicKey[] {
  return [
    w.agent.publicKey,
    w.mandate,
    ledgerPda(PROGRAM_ID, w.mandate),
    w.source.publicKey,
    w.destination.publicKey,
    w.mint.publicKey,
    TOKEN_PROGRAM,
    PROGRAM_ID,
  ];
}

function paidTx(w: World, signature: string, slot: number, nonce: bigint, err: unknown = null, amount: bigint = nonce) {
  return legacyChargeTx({
    signature,
    slot,
    blockTime: slot * 10,
    err,
    logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, amount, nonce, amount)]),
    amount,
    nonce,
    keys: chargeKeys(w),
  });
}

function putPaid(w: World, signature: string, slot: number, nonce: bigint): void {
  w.fake.transactions.set(signature, paidTx(w, signature, slot, nonce));
}

function putStrangerMemo(w: World, signature: string, slot: number): void {
  const keys = [Keypair.generate().publicKey.toBase58(), w.mandate.toBase58(), MEMO_PROGRAM];
  w.fake.transactions.set(signature, {
    slot,
    blockTime: slot * 10,
    meta: {
      err: null,
      logMessages: [`Program ${MEMO_PROGRAM} invoke [1]`, 'Program log: Memo (len 4): "veto"', `Program ${MEMO_PROGRAM} success`],
    },
    transaction: {
      signatures: [signature],
      message: { accountKeys: keys, instructions: [{ programIdIndex: 2, accounts: [0, 1], data: "" }] },
    },
  });
}

function listed(signature: string, slot: number, err: TransactionError | null = null): ConfirmedSignatureInfo {
  return { signature, slot, err, memo: null, blockTime: slot * 10, confirmationStatus: "confirmed" };
}

const tag = (row: { signature: string; nonce: bigint }) => `${row.signature}:${row.nonce.toString()}`;

/** The walk sdk/README.md:88-96 documents. */
async function walkPerReadme(w: World, pageSize: number): Promise<{ seen: string[]; pages: number }> {
  const seen: string[] = [];
  let pages = 0;
  let before: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize, before });
    pages += 1;
    seen.push(...rows.map(tag));
    if (!rows.pageFull || rows.oldestSignature === null) break;
    before = rows.oldestSignature;
  }
  return { seen, pages };
}

/** Two stranger memos and two failed transactions, newest first, at slots slot..slot-3. */
function flood(w: World, slot: number): ConfirmedSignatureInfo[] {
  putStrangerMemo(w, `memo-${slot}`, slot);
  putStrangerMemo(w, `memo-${slot - 1}`, slot - 1);
  return [
    listed(`memo-${slot}`, slot),
    listed(`memo-${slot - 1}`, slot - 1),
    listed(`failed-${slot - 2}`, slot - 2, { InstructionError: [0, "Custom"] }),
    listed(`failed-${slot - 3}`, slot - 3, { InstructionError: [0, "Custom"] }),
  ];
}

test("S6 a stranger flood across three full pages does not hide the older decision, and each memo costs the reader one fetch", async () => {
  const w = world();
  putPaid(w, "new", 90, 3n);
  putPaid(w, "old", 10, 1n);
  w.fake.signatures = [listed("new", 90), ...flood(w, 80), ...flood(w, 70), ...flood(w, 60), listed("old", 10)];

  const { seen, pages } = await walkPerReadme(w, 4);
  assert.deepEqual(seen.sort(), ["new:3", "old:1"], "old:1 sits behind twelve stranger signatures and is still reached");
  assert.equal(pages, 4, "one page per four listed signatures, the last page holds old:1 alone");
  const opened = w.fake.opened;
  assert.deepEqual(
    opened.filter((s) => s.startsWith("failed-")),
    [],
    "a failed signature is skipped from the listing and never fetched",
  );
  assert.equal(opened.filter((s) => s.startsWith("memo-")).length, 6, "every landed memo costs the reader one getTransaction");
});

test("S7 a failed transaction carrying a Paid frame is skipped unfetched, is no decision, and still carries the cursor", async () => {
  const w = world();
  putPaid(w, "new", 60, 3n);
  // The charge instruction ran and logged Paid, a later instruction failed, the
  // whole transaction rolled back. The listing marks it with err. The fake
  // throws if this signature is ever fetched.
  w.fake.transactions.set("do-not-fetch", paidTx(w, "do-not-fetch", 50, 2n, { InstructionError: [1, "Custom"] }));
  w.fake.signatures = [listed("new", 60), listed("do-not-fetch", 50, { InstructionError: [1, "Custom"] })];

  const first = await decisionsForMandate(w.connection, w.mandate, { pageSize: 2 });
  assert.deepEqual(first.map(tag), ["new:3"], "the rolled-back Paid frame is not a decision");
  assert.equal(first.pageFull, true);
  assert.equal(first.oldestSignature, "do-not-fetch", "the failed signature is still the cursor");
  const next = await decisionsForMandate(w.connection, w.mandate, { pageSize: 2, before: "do-not-fetch" });
  assert.deepEqual(next.map(tag), []);
  assert.equal(next.pageFull, false);
  assert.equal(next.oldestSignature, null);
  assert.deepEqual(w.fake.opened, ["new"], "only the live signature was fetched");
});

test("S8 a node that keeps rate limiting one signature of a batch makes the call throw, never a page missing that transaction", async () => {
  const w = world();
  for (const [sig, slot, nonce] of [["a", 40, 4n], ["b", 30, 3n], ["c", 20, 2n], ["d", 10, 1n]] as const) {
    putPaid(w, sig, slot, nonce);
  }
  w.fake.signatures = [listed("a", 40), listed("b", 30), listed("c", 20), listed("d", 10)];
  const real = w.fake.getTransaction.bind(w.fake);
  let stuckCalls = 0;
  w.fake.getTransaction = async (signature: string) => {
    if (signature === "c") {
      stuckCalls += 1;
      throw new Error('429 : {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}}');
    }
    return real(signature);
  };
  const delays: number[] = [];
  await assert.rejects(
    () =>
      decisionsForMandate(w.connection, w.mandate, {
        pageSize: 4,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    /429/,
    "the page is not returned with c missing",
  );
  assert.equal(stuckCalls, 4, "the full retry ladder was spent on the stuck signature");
  assert.deepEqual(delays, [DECISION_FETCH_BACKOFF_MS, DECISION_FETCH_BACKOFF_MS * 2, DECISION_FETCH_BACKOFF_MS * 4]);
});

test("S9 guardPendingOverride refuses a different amount at the pending override nonce before anything reaches the wire", async () => {
  const w = world({ lastNonce: 4n, perTxMax: 10n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const nonce = await veto.nextNonce();
  assert.equal(nonce, 9n);
  await assert.rejects(
    () => veto.charge({ amount: 5n, nonce, guardPendingOverride: true }),
    /nonce 9 is a pending override for 12000 base units, refusing 5/,
  );
  await assert.rejects(
    () => veto.charge({ amount: 12_001n, nonce, guardPendingOverride: true }),
    /nonce 9 is a pending override for 12000 base units, refusing 12001/,
  );
  assert.equal(w.fake.sent.length, 0, "nothing was signed or sent");

  const amount = 12_000n;
  w.fake.signature = "sig-exact";
  w.fake.transactions.set("sig-exact", paidTx(w, "sig-exact", 70, nonce, null, amount));
  const outcome = await veto.charge({ amount, nonce, guardPendingOverride: true });
  assert.equal(outcome.kind, "paid");
  const raw = w.fake.sent[0];
  assert.ok(raw);
  const ix = Transaction.from(raw).instructions[0];
  assert.ok(ix);
  assert.equal(ix.data.readBigUInt64LE(8), 12_000n, "the exact override amount goes to the wire");
  assert.equal(ix.data.readBigUInt64LE(16), 9n);
});

test("S10 guardPendingOverride leaves a charge at a nonce below the pending override alone, so the override stays pending", async () => {
  const w = world({ lastNonce: 4n, perTxMax: 10n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const nonce = 5n;
  const amount = 7n;
  w.fake.signature = "sig-routine";
  w.fake.transactions.set("sig-routine", paidTx(w, "sig-routine", 71, nonce, null, amount));
  const outcome = await veto.charge({ amount, nonce, guardPendingOverride: true });
  assert.equal(outcome.kind, "paid");
  const raw = w.fake.sent[0];
  assert.ok(raw);
  const ix = Transaction.from(raw).instructions[0];
  assert.ok(ix);
  assert.equal(ix.data.readBigUInt64LE(16), 5n, "a nonce under override_nonce is not the override, the program keeps 9 pending");
});
