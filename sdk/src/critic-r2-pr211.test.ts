// Backend critic, PR 211 round 2. Probes of the fix diff in read.ts (56abda1).
// N1: limit takes the newest decisions when the cut falls on a concurrency batch
//     boundary, and the limited-walk rule the README gives (continue from the
//     oldest decision of the limited result) covers the rest once, no gap, no dup.
// N2: a two-charge transaction in the middle of a fetch batch is kept whole
//     when limit lands on its first decision, and the transactions behind it on
//     that page are not returned.
// N3: regression check named for this round: a history that mixes a two-charge
//     transaction, a stranger's full page (memo and failed signatures) and a
//     grant_override, walked per the README at pageSize 1 and 4, yields every
//     decision exactly once.
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, type ConfirmedSignatureInfo, type TransactionError } from "@solana/web3.js";
import type { RpcTransaction } from "./events.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { DECISION_FETCH_CONCURRENCY, decisionsForMandate } from "./read.js";
import { TOKEN_PROGRAM, chargeData, encodeBase58, framed, legacyChargeTx, paidLog, world, type World } from "./testkit.js";

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function chargeKeys(w: World): string[] {
  return [
    w.agent.publicKey,
    w.mandate,
    ledgerPda(PROGRAM_ID, w.mandate),
    w.source.publicKey,
    w.destination.publicKey,
    w.mint.publicKey,
    TOKEN_PROGRAM,
    PROGRAM_ID,
  ].map((key) => key.toBase58());
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

/** One transaction carrying two charge instructions, nonces first and second. */
function putTwin(w: World, signature: string, slot: number, first: bigint, second: bigint): void {
  const keys = chargeKeys(w);
  const program = PROGRAM_ID.toBase58();
  const tx: RpcTransaction = {
    slot,
    blockTime: slot * 10,
    meta: {
      err: null,
      logMessages: [
        ...framed(program, [paidLog(w.mandate, first, first, first)]),
        ...framed(program, [paidLog(w.mandate, second, second, first + second)]),
      ],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys,
        instructions: [
          { programIdIndex: keys.indexOf(program), accounts: [0, 1, 2, 3, 4, 5, 6], data: encodeBase58(chargeData(first, first)) },
          { programIdIndex: keys.indexOf(program), accounts: [0, 1, 2, 3, 4, 5, 6], data: encodeBase58(chargeData(second, second)) },
        ],
      },
    },
  };
  w.fake.transactions.set(signature, tx);
}

/** A stranger's memo transaction listing the mandate. No Veto frame. */
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

/** An owner grant_override transaction: a Veto frame with no decision event. */
function putGrant(w: World, signature: string, slot: number): void {
  const keys = chargeKeys(w);
  const program = PROGRAM_ID.toBase58();
  w.fake.transactions.set(signature, {
    slot,
    blockTime: slot * 10,
    meta: { err: null, logMessages: framed(program, ["Program log: Instruction: GrantOverride"]) },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys,
        instructions: [{ programIdIndex: keys.indexOf(program), accounts: [0, 1, 2, 3, 6], data: encodeBase58(Buffer.from([225, 146, 123, 110, 56, 16, 99, 141])) }],
      },
    },
  });
}

function listed(signature: string, slot: number, err: TransactionError | null = null): ConfirmedSignatureInfo {
  return { signature, slot, err, memo: null, blockTime: slot * 10, confirmationStatus: "confirmed" };
}

const tag = (row: { signature: string; nonce: bigint }) => `${row.signature}:${row.nonce.toString()}`;

/** The walk sdk/README.md documents on the head: before is oldestSignature, continue while pageFull. */
async function walkPerReadme(w: World, pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 40; guard += 1) {
    const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize, before });
    seen.push(...rows.map(tag));
    if (!rows.pageFull || rows.oldestSignature === null) break;
    before = rows.oldestSignature;
  }
  return seen;
}

test("N1 a limit past one concurrency batch takes the newest decisions and the README limited walk covers the rest once", async () => {
  const w = world();
  const count = DECISION_FETCH_CONCURRENCY * 2;
  const rows: ConfirmedSignatureInfo[] = [];
  for (let i = count; i >= 1; i -= 1) {
    putPaid(w, `s${i}`, i * 10, BigInt(i));
    rows.push(listed(`s${i}`, i * 10));
  }
  w.fake.signatures = rows;
  const limit = DECISION_FETCH_CONCURRENCY + 1;

  const first = await decisionsForMandate(w.connection, w.mandate, { limit });
  const want = Array.from({ length: limit }, (_, i) => `s${count - limit + 1 + i}:${count - limit + 1 + i}`);
  assert.deepEqual(first.map(tag), want, "the newest limit decisions, ordered oldest first");
  assert.ok(first[0]);
  const rest = await decisionsForMandate(w.connection, w.mandate, { before: first[0].signature });
  const seen = [...rest.map(tag), ...first.map(tag)];
  const every = Array.from({ length: count }, (_, i) => `s${i + 1}:${i + 1}`);
  assert.deepEqual(seen, every, "no gap and no duplicate across the limited page and the rest");
});

test("N2 a two-charge transaction inside a fetch batch is kept whole when limit lands on its first decision", async () => {
  const w = world();
  putPaid(w, "n5", 50, 5n);
  putTwin(w, "twin", 40, 3n, 4n);
  putPaid(w, "n2", 20, 2n);
  putPaid(w, "n1", 10, 1n);
  w.fake.signatures = [listed("n5", 50), listed("twin", 40), listed("n2", 20), listed("n1", 10)];

  const first = await decisionsForMandate(w.connection, w.mandate, { limit: 2 });
  assert.deepEqual(first.map(tag), ["twin:3", "twin:4", "n5:5"], "twin is not split and n2, n1 are not taken");
  assert.ok(first[0]);
  const rest = await decisionsForMandate(w.connection, w.mandate, { before: first[0].signature });
  assert.deepEqual(rest.map(tag), ["n1:1", "n2:2"]);
});

test("N3 regression: twin, stranger page and grant_override walked per the README yield every decision once at pageSize 1 and 4", async () => {
  const w = world();
  putPaid(w, "n9", 90, 9n);
  putStrangerMemo(w, "memo-a", 80);
  putStrangerMemo(w, "memo-b", 79);
  putTwin(w, "twin", 60, 7n, 8n);
  putGrant(w, "grant", 50);
  putPaid(w, "n6", 40, 6n);
  putPaid(w, "n5", 30, 5n);
  w.fake.signatures = [
    listed("n9", 90),
    listed("memo-a", 80),
    listed("memo-b", 79),
    listed("fail-a", 78, { InstructionError: [0, "Custom"] }),
    listed("fail-b", 77, { InstructionError: [0, "Custom"] }),
    listed("twin", 60),
    listed("grant", 50),
    listed("n6", 40),
    listed("n5", 30),
  ];
  const every = ["n9:9", "twin:7", "twin:8", "n6:6", "n5:5"];

  for (const pageSize of [4, 1]) {
    const seen = await walkPerReadme(w, pageSize);
    assert.deepEqual([...seen].sort(), [...every].sort(), `pageSize ${pageSize}: every decision exactly once`);
  }
  assert.deepEqual(
    w.fake.opened.filter((s) => s.startsWith("fail")),
    [],
    "failed signatures are never fetched",
  );
});
