/** Critic round 3 fixture for PR 122. recordedCharge answers per nonce.
 * A refusal recorded for one slot does not skip the next slot, and the
 * function passed as recordedCharge is the row that closes the nonce.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PriceFeed } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import { processWindow } from "./run.js";

const BASE = { kwhMilli: 50_000n, mintDecimals: 6, log: () => {}, feedAttempts: 1, feedRetryMs: 0 };

function honestFeed(): PriceFeed {
  return {
    async getWindow(at) {
      const start = new Date(Math.floor(at.getTime() / 900_000) * 900_000);
      const end = new Date(start.getTime() + 900_000);
      return { timeStart: start.toISOString(), timeEnd: end.toISOString(), sekPerKwh: "1.00000" };
    },
  };
}

function freshJournal(): JsonlJournal {
  return new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-r3-")), "decisions.jsonl"));
}

const refused = {
  decision: "refused" as const,
  reason: "over per-payment maximum",
  reasonCode: 2,
  suggestedOverride: null,
  signature: "sig-refused",
};

test("critic r3 PR 122: a refusal recorded for one slot does not skip the next slot", async () => {
  const feed = honestFeed();
  const sent: bigint[] = [];
  const ledger = new Map<bigint, {
    decision: "refused";
    reason: string;
    reasonCode: number;
    suggestedOverride: null;
    signature: string;
    amount: bigint;
  }>();
  const reader = {
    chainLastNonce: async () => 0n,
    recoverSettled: async () => null,
    recordedCharge: async (nonce: bigint) => ledger.get(nonce) ?? null,
  };
  const first = await processWindow({
    at: new Date("2026-09-22T16:00:00Z"),
    feed,
    journal: freshJournal(),
    submit: async (amount, nonce) => {
      sent.push(nonce);
      ledger.set(nonce, { ...refused, amount });
      return refused;
    },
    ...BASE,
    reader,
  });
  assert.equal(first, "submitted");

  const again = await processWindow({
    at: new Date("2026-09-22T16:00:00Z"),
    feed,
    journal: freshJournal(),
    submit: async (_amount, nonce) => {
      sent.push(nonce);
      return refused;
    },
    ...BASE,
    reader,
  });
  assert.equal(again, "skipped");

  const next = await processWindow({
    at: new Date("2026-09-22T16:15:00Z"),
    feed,
    journal: freshJournal(),
    submit: async (_amount, nonce) => {
      sent.push(nonce);
      return { decision: "paid" as const, reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig-paid" };
    },
    ...BASE,
    reader,
  });
  assert.equal(next, "submitted");
  assert.deepEqual(sent, [1790092800n, 1790093700n]);
});

test("critic r3 PR 122: recordedCharge is what closes the nonce", async () => {
  const feed = honestFeed();
  const at = new Date("2026-09-22T16:30:00Z");
  const sent: bigint[] = [];
  const reads: bigint[] = [];
  const journal = freshJournal();
  const result = await processWindow({
    at,
    feed,
    journal,
    submit: async (_amount, nonce) => {
      sent.push(nonce);
      return refused;
    },
    ...BASE,
    reader: {
      chainLastNonce: async () => 0n,
      recoverSettled: async () => null,
      recordedCharge: async (nonce) => {
        reads.push(nonce);
        return { decision: "paid", reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig-chain", amount: 50_000_000n };
      },
    },
  });
  assert.deepEqual(reads, [1790094600n], "the chain reader was consulted");
  assert.equal(result, "submitted");
  assert.deepEqual(sent, [], "the paid row on the reader is not sent again");
  const rows = journal.load();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "paid");
  assert.equal(rows[0]?.signature, "sig-chain");
});
