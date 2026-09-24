// Security critic, PR 211 round 1.
// S1, S2: anyone can list a mandate account in their own transactions. A page
// of such signatures carries no decision. The documented walk takes its cursor
// from the listing (oldestSignature, continue while pageFull) and still reaches
// the older decision. The attacker needs no key of the mandate, only the fee for
// pageSize transactions (5000 lamports each, 0.005 SOL at the default page).
// S3, S4, S5: controls on the override-aware nextNonce. The SDK sends the
// caller's amount and nonce unchanged, the program decides. A dead override
// (at or below last_nonce) is ignored, and a mandate account not owned by the
// program is refused before its override fields are read.
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, Transaction, type ConfirmedSignatureInfo, type TransactionError } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { decisionsForMandate } from "./read.js";
import { TOKEN_PROGRAM, framed, legacyChargeTx, paidLog, refusedLog, world, type World } from "./testkit.js";

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

function putPaid(w: World, signature: string, slot: number, nonce: bigint): void {
  w.fake.transactions.set(
    signature,
    legacyChargeTx({
      signature,
      slot,
      blockTime: slot * 10,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, nonce, nonce, nonce)]),
      amount: nonce,
      nonce,
      keys: chargeKeys(w),
    }),
  );
}

/** A stranger's memo transaction that lists the mandate account. No Veto frame, no decision. */
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

/** The walk sdk/README.md documents: before is the oldest listed signature, stop when the listing page is not full. */
async function walkPerReadme(w: World, pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize, before });
    seen.push(...rows.map(tag));
    if (!rows.pageFull || rows.oldestSignature === null) break;
    before = rows.oldestSignature;
  }
  return seen;
}

/** Four signatures no key of the mandate produced: two stranger memos, two failed transactions. */
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

test("S1 a stranger's page of non-decision signatures hides every older decision from the documented walk", async () => {
  const w = world();
  putPaid(w, "new", 60, 3n);
  putPaid(w, "old", 10, 1n);
  w.fake.signatures = [listed("new", 60), ...flood(w, 50), listed("old", 10)];

  const seen = await walkPerReadme(w, 4);
  assert.deepEqual(seen.sort(), ["new:3", "old:1"], "old:1 sits behind a page a stranger filled and is never reached");
});

test("S2 a stranger's page at the head of the history reads as a mandate with no decisions", async () => {
  const w = world();
  putPaid(w, "old", 10, 1n);
  w.fake.signatures = [...flood(w, 50), listed("old", 10)];

  const seen = await walkPerReadme(w, 4);
  assert.deepEqual(seen, ["old:1"], "the only decision on the mandate is reported as none");
});

test("S3 control: the SDK sends the caller's amount above the override unchanged and returns the program's refusal", async () => {
  const w = world({ lastNonce: 4n, perTxMax: 10n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const nonce = await veto.nextNonce();
  assert.equal(nonce, 9n);
  const amount = 12_001n;
  w.fake.signature = "sig-over";
  w.fake.transactions.set(
    "sig-over",
    legacyChargeTx({
      signature: "sig-over",
      slot: 70,
      blockTime: 700,
      logs: framed(PROGRAM_ID.toBase58(), [refusedLog(w.mandate, amount, nonce, 5, amount)]),
      amount,
      nonce,
      keys: chargeKeys(w),
    }),
  );
  const outcome = await veto.charge({ amount, nonce });
  const raw = w.fake.sent[0];
  assert.ok(raw);
  const ix = Transaction.from(raw).instructions[0];
  assert.ok(ix);
  assert.equal(ix.data.readBigUInt64LE(8), 12_001n, "amount on the wire is the caller's, not clamped to the override");
  assert.equal(ix.data.readBigUInt64LE(16), 9n);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.reasonCode, 5);
});

test("S4 control: an override at or below last_nonce is dead and nextNonce ignores it", async () => {
  const w = world({ lastNonce: 10n, overrideNonce: 9n, overrideAmount: 12_000n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  assert.equal(await veto.nextNonce(), 11n);
});

test("S5 control: a mandate account not owned by the program cannot steer nextNonce through its override fields", async () => {
  const w = world({ lastNonce: 4n, overrideNonce: 9n, overrideAmount: 12_000n });
  const stored = w.fake.accounts.get(w.mandate.toBase58());
  assert.ok(stored);
  w.fake.accounts.set(w.mandate.toBase58(), { ...stored, owner: Keypair.generate().publicKey });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  await assert.rejects(() => veto.nextNonce(), /is not owned by the Veto program/);
});
