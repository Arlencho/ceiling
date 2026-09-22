// Security fixture for issue #110, area 3 (the watcher).
//
// The nonce that identifies a window on chain is derived from the feed's own
// `time_start`, not from the cadence slot the watcher set out to pay
// (run.ts:101). A feed that answers the same slot with a shifting
// `time_start` therefore hands the watcher a fresh, strictly higher nonce each
// time, and every one of them is submitted as a new charge. The journal cannot
// stop it (it keys on the feed nonce) and the chain cannot stop it (each nonce
// is above last_nonce). The only bound left is the mandate itself.
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

test("finding: a feed that shifts time_start pays the same slot once per answer", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-")), "decisions.jsonl"));
  const submitted: bigint[] = [];
  const settled = { value: 0n };
  // Every window still contains the slot (start <= 16:00:00 < end), so
  // windowContaining accepts each one. The starts rise by one second, so each
  // nonce is above the chain's last_nonce and nothing refuses it.
  const feed = shiftingFeed([
    "2026-09-22T15:59:57Z",
    "2026-09-22T15:59:58Z",
    "2026-09-22T15:59:59Z",
    "2026-09-22T16:00:00Z",
  ]);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(await run(feed, journal, submitted, settled), "submitted");
  }
  assert.deepEqual(submitted, [1790092797n, 1790092798n, 1790092799n, 1790092800n]);
  const paidRows = journal.load().filter((row) => row.decision === "paid");
  assert.equal(paidRows.length, 4, "four paid rows for one cadence slot");
});

// Second, smaller point from the same area. A refusal does not advance
// last_nonce on chain, so the journal is the only thing that stops a refused
// window from being submitted again. With the local file gone and no object
// store configured (index.ts runs the ring repair only when a store exists),
// the same window is refused twice: two transactions, two ledger rows, no
// funds moved. A paid window is protected by the chain's last_nonce.
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
