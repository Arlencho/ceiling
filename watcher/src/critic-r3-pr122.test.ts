/** Critic round 3 fixture for PR 122. The in-process refusal memory that a
 * chain-backed call falls back to must stay behind the chain reader and must
 * stay keyed to its own nonce. A remembered refusal for one slot cannot skip
 * the next slot, and a passed ledger reader is read even when the process has
 * a refusal in memory for that nonce.
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

test("critic r3 PR 122: a refusal remembered for one slot does not skip the next slot", async () => {
  const feed = honestFeed();
  const sent: bigint[] = [];
  const first = await processWindow({
    at: new Date("2026-09-22T16:00:00Z"),
    feed,
    journal: freshJournal(),
    submit: async (_amount, nonce) => {
      sent.push(nonce);
      return refused;
    },
    ...BASE,
    chainLastNonce: async () => 0n,
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
    chainLastNonce: async () => 0n,
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
    chainLastNonce: async () => 0n,
  });
  assert.equal(next, "submitted");
  assert.deepEqual(sent, [1790092800n, 1790093700n]);
});

test("critic r3 PR 122: a passed ledger reader is read ahead of the refusal memory", async () => {
  const feed = honestFeed();
  const at = new Date("2026-09-22T16:30:00Z");
  const sent: bigint[] = [];
  const first = await processWindow({
    at,
    feed,
    journal: freshJournal(),
    submit: async (_amount, nonce) => {
      sent.push(nonce);
      return refused;
    },
    ...BASE,
    chainLastNonce: async () => 0n,
  });
  assert.equal(first, "submitted");
  assert.deepEqual(sent, [1790094600n]);

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
    chainLastNonce: async () => 0n,
    recordedCharge: async (nonce) => {
      reads.push(nonce);
      return { decision: "paid", reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig-chain", amount: 50_000_000n };
    },
  });
  assert.deepEqual(reads, [1790094600n], "the chain reader was consulted");
  assert.equal(result, "submitted");
  assert.deepEqual(sent, [1790094600n], "no second send");
  const rows = journal.load();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "paid");
  assert.equal(rows[0]?.signature, "sig-chain");
});
