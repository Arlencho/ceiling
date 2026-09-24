// Backend critic, PR 211 round 1. Paging through decisionsForMandate must reach
// every decision on the mandate with no gaps and no duplicates.
import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import type { RpcTransaction } from "./events.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { decisionsForMandate } from "./read.js";
import {
  TOKEN_PROGRAM,
  chargeData,
  encodeBase58,
  framed,
  legacyChargeTx,
  paidLog,
  world,
  type World,
} from "./testkit.js";

function chargeKeys(w: World) {
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

/** One transaction carrying two charge instructions, as the program allows (devnet 4EZrkEvp...). */
function putTwoCharges(w: World, signature: string, slot: number, first: bigint, second: bigint): void {
  const keys = chargeKeys(w).map((key) => key.toBase58());
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

/** An owner grant_override transaction: touches the mandate, carries no decision. */
function putOverrideGrant(w: World, signature: string, slot: number): void {
  const keys = [w.owner.publicKey, w.mandate, ledgerPda(PROGRAM_ID, w.mandate), w.source.publicKey, TOKEN_PROGRAM, PROGRAM_ID].map((key) =>
    key.toBase58(),
  );
  const program = PROGRAM_ID.toBase58();
  w.fake.transactions.set(signature, {
    slot,
    blockTime: slot * 10,
    meta: { err: null, logMessages: framed(program, ["Program log: VETO OVERRIDE amount=12000 nonce=9"]) },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys,
        instructions: [{ programIdIndex: keys.indexOf(program), accounts: [0, 1, 2, 3, 4], data: "" }],
      },
    },
  });
}

function listed(signature: string, slot: number): ConfirmedSignatureInfo {
  return { signature, slot, err: null, memo: null, blockTime: slot * 10, confirmationStatus: "confirmed" };
}

const tag = (row: { signature: string; nonce: bigint }) => `${row.signature}:${row.nonce.toString()}`;

/** The paging protocol sdk/README.md documents: before is the oldest signature of the previous page, stop on an empty page. */
async function walkPerReadme(w: World, pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize, before });
    if (rows.length === 0) break;
    seen.push(...rows.map(tag));
    before = rows[0]?.signature;
  }
  return seen;
}

test("R1 a limit that lands inside a two-charge transaction does not lose the other charge across pages", async () => {
  const w = world();
  putTwoCharges(w, "twin", 30, 3n, 4n);
  putPaid(w, "older", 10, 1n);
  w.fake.signatures = [listed("twin", 30), listed("older", 10)];

  const first = await decisionsForMandate(w.connection, w.mandate, { limit: 1 });
  assert.equal(first.length, 1);
  const oldest = first[0];
  assert.ok(oldest);
  const rest = await decisionsForMandate(w.connection, w.mandate, { before: oldest.signature });

  const seen = [...first, ...rest].map(tag).sort();
  assert.deepEqual(seen, ["older:1", "twin:3", "twin:4"], "nonce 3 or 4 was cut by limit and skipped by before");
});

test("R2 a page holding only a grant_override signature does not end the walk before older decisions", async () => {
  const w = world();
  putPaid(w, "new", 30, 2n);
  putOverrideGrant(w, "grant", 20);
  putPaid(w, "old", 10, 1n);
  w.fake.signatures = [listed("new", 30), listed("grant", 20), listed("old", 10)];

  const seen = await walkPerReadme(w, 1);
  assert.deepEqual(seen.sort(), ["new:2", "old:1"], "old:1 sits behind a page with no decision and is never reached");
});

test("R3 control: pages of size 2 over the same history cover every decision once", async () => {
  const w = world();
  putPaid(w, "new", 30, 2n);
  putOverrideGrant(w, "grant", 20);
  putPaid(w, "old", 10, 1n);
  w.fake.signatures = [listed("new", 30), listed("grant", 20), listed("old", 10)];

  const seen = await walkPerReadme(w, 2);
  assert.deepEqual(seen.sort(), ["new:2", "old:1"]);
  assert.equal(new Set(seen).size, seen.length);
});

test("R4 control: without limit a two-charge transaction yields both decisions in one page", async () => {
  const w = world();
  putTwoCharges(w, "twin", 30, 3n, 4n);
  w.fake.signatures = [listed("twin", 30)];
  const rows = await decisionsForMandate(w.connection, w.mandate);
  assert.deepEqual(rows.map((row) => row.nonce), [3n, 4n]);
});
