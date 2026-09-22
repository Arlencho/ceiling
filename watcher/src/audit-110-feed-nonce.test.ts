// Security fixture for issue #110, area 3 (the watcher), closed by #118 and #119.
//
// The nonce that identifies a window on chain is the cadence slot the watcher
// chose (`at`), not the feed's `time_start`. A feed that answers the same slot
// with a shifting `time_start` is a gap (`window start does not match slot`)
// until an answer starts on that slot, and that slot is paid once.
//
// The control below is the honest feed: the same slot twice yields one submit.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PriceFeed, PriceWindow } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import { processWindow } from "./run.js";

const SLOT = new Date("2026-09-22T16:00:00Z");

function paidReceipt() {
  return {
    decision: "paid" as const,
    reason: "ok",
    reasonCode: 0,
    suggestedOverride: null,
    signature: "fake-sig",
  };
}

function shiftingFeed(startsIso: string[]): PriceFeed {
  let call = 0;
  return {
    async getWindow(): Promise<PriceWindow | null> {
      const timeStart = startsIso[Math.min(call, startsIso.length - 1)]!;
      call += 1;
      return { timeStart, timeEnd: "2026-09-22T16:15:00Z", sekPerKwh: "0.00892" };
    },
  };
}

async function run(feed: PriceFeed, journal: JsonlJournal, submitted: bigint[], settled: { value: bigint }) {
  return processWindow({
    at: SLOT,
    feed,
    journal,
    submit: async (_amount, nonce) => {
      submitted.push(nonce);
      settled.value = nonce;
      return paidReceipt();
    },
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    chainLastNonce: async () => settled.value,
  });
}

test("control: an honest feed pays one slot once", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-")), "decisions.jsonl"));
  const submitted: bigint[] = [];
  const settled = { value: 0n };
  const feed = shiftingFeed(["2026-09-22T16:00:00Z"]);
  assert.equal(await run(feed, journal, submitted, settled), "submitted");
  assert.equal(await run(feed, journal, submitted, settled), "skipped");
  assert.equal(await run(feed, journal, submitted, settled), "skipped");
  assert.deepEqual(submitted, [1790092800n]);
});

test("a feed that shifts time_start pays the cadence slot once", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-")), "decisions.jsonl"));
  const submitted: bigint[] = [];
  const settled = { value: 0n };
  // Every window still contains the slot (start <= 16:00:00 < end). The starts
  // rise by one second. Only the answer that starts on the slot is a charge,
  // and its nonce is the slot.
  const feed = shiftingFeed([
    "2026-09-22T15:59:57Z",
    "2026-09-22T15:59:58Z",
    "2026-09-22T15:59:59Z",
    "2026-09-22T16:00:00Z",
  ]);
  const results: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    results.push(await run(feed, journal, submitted, settled));
  }
  assert.deepEqual(results, ["gap", "gap", "gap", "submitted"]);
  assert.deepEqual(submitted, [1790092800n]);
  const paidRows = journal.load().filter((row) => row.decision === "paid");
  assert.equal(paidRows.length, 1, "one paid row for one cadence slot");
  assert.equal(paidRows[0]?.nonce, "1790092800");
});

// A refusal does not advance last_nonce. processWindow, given only that read
// and a fresh journal, still submits: nothing in this call can see the ledger.
// index.ts repairs paid and refused rows before it calls processWindow, with
// or without a remote journal, and passes recordedCharge so the pre-submit
// read sees the refusal. This case is the bare call, which has neither.
test("finding: a refused window is submitted again when the local journal is lost", async () => {
  const feed = shiftingFeed(["2026-09-22T16:00:00Z"]);
  const submitted: bigint[] = [];
  const refusedReceipt = () => ({
    decision: "refused" as const,
    reason: "over per-payment maximum",
    reasonCode: 5,
    suggestedOverride: 446_000n,
    signature: "fake-sig",
  });
  for (let restart = 0; restart < 2; restart += 1) {
    const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-")), "decisions.jsonl"));
    const result = await processWindow({
      at: SLOT,
      feed,
      journal,
      submit: async (_amount, nonce) => {
        submitted.push(nonce);
        return refusedReceipt();
      },
      kwhMilli: 50_000n,
      mintDecimals: 6,
      log: () => {},
      feedAttempts: 1,
      feedRetryMs: 0,
      chainLastNonce: async () => 0n,
    });
    assert.equal(result, "submitted");
  }
  assert.deepEqual(submitted, [1790092800n, 1790092800n]);
});
