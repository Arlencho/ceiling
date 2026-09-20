import assert from "node:assert/strict";
import test from "node:test";
import { compareRingToHistory } from "./compare.js";
import { KIND_OPENED, KIND_PAID, KIND_REFUSED } from "./constants.js";
import type { Decision, RingEntry } from "./types.js";

function ring(partial: Partial<RingEntry> & Pick<RingEntry, "kind" | "amount" | "nonce">): RingEntry {
  return {
    ts: 10n,
    counterparty: "dest",
    suggestedOverride: 0n,
    kindName: partial.kind === KIND_PAID ? "paid" : partial.kind === KIND_REFUSED ? "refused" : "opened",
    reason: 0,
    reasonText: "ok",
    ...partial,
  };
}

function decision(partial: Partial<Decision> & Pick<Decision, "kind" | "amount" | "nonce">): Decision {
  return {
    signature: "sig",
    slot: 1,
    timestamp: 10,
    mandate: "man",
    counterparty: "dest",
    reason: 0,
    reasonText: "ok",
    suggestedOverride: 0n,
    ...partial,
  };
}

test("opened ring rows are not compared; paid and refused must match", () => {
  const cmp = compareRingToHistory(
    [
      ring({ kind: KIND_OPENED, amount: 100n, nonce: 0n }),
      ring({ kind: KIND_PAID, amount: 5n, nonce: 1n }),
      ring({ kind: KIND_REFUSED, amount: 9n, nonce: 2n, reason: 5, suggestedOverride: 9n, kindName: "refused", reasonText: "over per-payment maximum" }),
    ],
    [
      decision({ kind: "paid", amount: 5n, nonce: 1n, signature: "p" }),
      decision({
        kind: "refused",
        amount: 9n,
        nonce: 2n,
        reason: 5,
        suggestedOverride: 9n,
        signature: "r",
        reasonText: "over per-payment maximum",
      }),
    ],
  );
  assert.equal(cmp.ringDecisions, 2);
  assert.equal(cmp.matched, 2);
  assert.equal(cmp.ok, true);
  assert.equal(cmp.extraInIndexer.length, 0);
});

test("a ring paid/refused with no indexer row is a failure, not a synthesized fill", () => {
  const cmp = compareRingToHistory(
    [ring({ kind: KIND_PAID, amount: 5n, nonce: 1n })],
    [],
  );
  assert.equal(cmp.ok, false);
  assert.equal(cmp.matched, 0);
  assert.deepEqual(cmp.rows[0]?.diffs, ["missing from indexer"]);
});

test("indexer extras older than the ring occupancy are allowed", () => {
  const cmp = compareRingToHistory(
    [ring({ kind: KIND_PAID, amount: 5n, nonce: 2n })],
    [
      decision({ kind: "paid", amount: 1n, nonce: 1n, signature: "old" }),
      decision({ kind: "paid", amount: 5n, nonce: 2n, signature: "new" }),
    ],
  );
  assert.equal(cmp.ok, true);
  assert.equal(cmp.extraInIndexer.length, 1);
  assert.equal(cmp.extraInIndexer[0]?.signature, "old");
});

test("counterparty mismatch is a real miss", () => {
  const cmp = compareRingToHistory(
    [ring({ kind: KIND_PAID, amount: 5n, nonce: 1n, counterparty: "aaa" })],
    [decision({ kind: "paid", amount: 5n, nonce: 1n, counterparty: "bbb" })],
  );
  assert.equal(cmp.ok, false);
  assert.ok(cmp.rows[0]?.diffs.some((d) => d.startsWith("counterparty:")));
});
