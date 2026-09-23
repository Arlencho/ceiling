// Issues 118 and 119.
//
// 118: the charge nonce is the cadence slot the watcher chose. A feed window
// whose start is a different instant is not a price for that slot.
// 119: a refusal lives on the chain ledger and does not move last_nonce.
// Repair reads it whether or not a remote journal is configured, and the
// pre-submit read refuses to send a nonce the ledger already refused.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordedFromLedgerBytes } from "./chain.js";
import type { PriceFeed, PriceWindow } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import { processWindow } from "./run.js";

const SLOT = new Date("2026-09-22T16:00:00Z");
const SLOT_NONCE = 1790092800n;
const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));

function windowAt(timeStart: string): PriceWindow {
  return { timeStart, timeEnd: "2026-09-22T16:15:00Z", sekPerKwh: "0.00892" };
}

function feedOf(starts: string[]): PriceFeed {
  let call = 0;
  return {
    async getWindow() {
      const timeStart = starts[Math.min(call, starts.length - 1)]!;
      call += 1;
      return windowAt(timeStart);
    },
  };
}

function paid() {
  return {
    decision: "paid" as const,
    reason: "ok",
    reasonCode: 0,
    suggestedOverride: null,
    signature: "paid-sig",
  };
}

test("a feed that shifts time_start is not charged once per answer", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-118-")), "d.jsonl"));
  const submitted: bigint[] = [];
  const feed = feedOf([
    "2026-09-22T15:59:57Z",
    "2026-09-22T15:59:58Z",
    "2026-09-22T15:59:59Z",
    "2026-09-22T16:00:00Z",
  ]);
  const results: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    results.push(
      await processWindow({
        at: SLOT,
        feed,
        journal,
        submit: async (_amount, nonce) => {
          submitted.push(nonce);
          return paid();
        },
        kwhMilli: 50_000n,
        mintDecimals: 6,
        log: () => {},
        feedAttempts: 1,
        feedRetryMs: 0,
        reader: {
          chainLastNonce: async () => 0n,
          recoverSettled: async () => null,
          recordedCharge: async () => null,
        },
      }),
    );
  }
  assert.deepEqual(results, ["gap", "gap", "gap", "submitted"]);
  assert.deepEqual(submitted, [SLOT_NONCE]);
  const rows = journal.load();
  assert.equal(rows.filter((row) => row.decision === "paid").length, 1);
  assert.equal(rows.find((row) => row.decision === "paid")?.nonce, SLOT_NONCE.toString());
  const gaps = rows.filter((row) => row.decision === "gap");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.reason, "window start does not match slot");
  assert.equal(gaps[0]?.nonce, SLOT_NONCE.toString());
});

test("a shifted window does not burn the slot: the matching window still pays", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-118-retry-")), "d.jsonl"));
  const submitted: bigint[] = [];
  const feed = feedOf(["2026-09-22T15:59:59Z", "2026-09-22T16:00:00Z"]);
  assert.equal(
    await processWindow({
      at: SLOT,
      feed,
      journal,
      submit: async (_amount, nonce) => {
        submitted.push(nonce);
        return paid();
      },
      kwhMilli: 50_000n,
      mintDecimals: 6,
      log: () => {},
      feedAttempts: 1,
      feedRetryMs: 0,
      reader: {
        chainLastNonce: async () => 0n,
        recoverSettled: async () => null,
        recordedCharge: async () => null,
      },
    }),
    "gap",
  );
  assert.deepEqual(submitted, []);
  assert.equal(
    await processWindow({
      at: SLOT,
      feed,
      journal,
      submit: async (_amount, nonce) => {
        submitted.push(nonce);
        return paid();
      },
      kwhMilli: 50_000n,
      mintDecimals: 6,
      log: () => {},
      feedAttempts: 1,
      feedRetryMs: 0,
      reader: {
        chainLastNonce: async () => 0n,
        recoverSettled: async () => null,
        recordedCharge: async () => null,
      },
    }),
    "submitted",
  );
  assert.deepEqual(submitted, [SLOT_NONCE]);
  assert.equal(journal.hasNonce(SLOT_NONCE), true);
});

test("a window overtaken by a later payment is skipped even when the feed start is shifted", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-118-over-")), "d.jsonl"));
  const later = SLOT_NONCE + 21_600n;
  journal.append({
    ts: "",
    window_start: "2026-09-22T22:00:00.000Z",
    window_end: null,
    sek_per_kwh: "0.001",
    kwh_milli: "50000",
    amount: "50",
    nonce: later.toString(),
    decision: "paid",
    reason: "ok",
    reason_code: 0,
    signature: "later-sig",
    suggested_override: null,
  });
  const submitted: bigint[] = [];
  const result = await processWindow({
    at: SLOT,
    feed: feedOf(["2026-09-22T15:59:57Z"]),
    journal,
    submit: async (_amount, nonce) => {
      submitted.push(nonce);
      return paid();
    },
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  });
  assert.equal(result, "skipped");
  assert.deepEqual(submitted, []);
  assert.equal(journal.load().at(-1)?.reason, "window overtaken by a later settled charge");
});

test("a refusal already on the chain ledger is not submitted again from an empty journal", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-119-")), "d.jsonl"));
  const submitted: bigint[] = [];
  const result = await processWindow({
    at: SLOT,
    feed: feedOf(["2026-09-22T16:00:00Z"]),
    journal,
    submit: async (_amount, nonce) => {
      submitted.push(nonce);
      return paid();
    },
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    reader: {
      chainLastNonce: async () => 0n,
      recoverSettled: async () => null,
      recordedCharge: async () => ({
        decision: "refused",
        reason: "over per-payment maximum",
        reasonCode: 5,
        suggestedOverride: 446_000n,
        signature: "refuse-sig",
        amount: 446_000n,
      }),
    },
  });
  assert.equal(result, "skipped");
  assert.deepEqual(submitted, []);
  const row = journal.load()[0];
  assert.equal(row?.decision, "refused");
  assert.equal(row?.nonce, SLOT_NONCE.toString());
  assert.equal(row?.reason, "over per-payment maximum");
  assert.equal(row?.signature, "refuse-sig");
  assert.equal(journal.hasNonce(SLOT_NONCE), true);
  assert.equal(journal.maxSettledNonce(), 0n, "a refusal still settles nothing");
});

test("a refused ring row is recovered, and a later payment of that nonce wins", () => {
  const disc = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
  const body = Buffer.alloc(40 + 72 * 2);
  body.writeUInt32LE(2, 32);
  const refused = body.subarray(40, 112);
  refused.writeBigUInt64LE(446_000n, 8);
  refused.writeBigUInt64LE(SLOT_NONCE, 48);
  refused.writeBigUInt64LE(446_000n, 56);
  refused[64] = 2;
  refused[65] = 5;
  const paidRow = body.subarray(112, 184);
  paidRow.writeBigUInt64LE(400_000n, 8);
  paidRow.writeBigUInt64LE(SLOT_NONCE, 48);
  paidRow[64] = 1;
  const data = Buffer.concat([disc, body]);
  const hit = recordedFromLedgerBytes(data, SLOT_NONCE);
  assert.equal(hit?.decision, "paid");
  assert.equal(hit?.amount, 400_000n);
  const onlyRefused = Buffer.concat([disc, Buffer.alloc(40 + 72)]);
  disc.copy(onlyRefused, 0);
  onlyRefused.writeUInt32LE(1, 8 + 32);
  const row = onlyRefused.subarray(8 + 40, 8 + 40 + 72);
  row.writeBigUInt64LE(446_000n, 8);
  row.writeBigUInt64LE(SLOT_NONCE, 48);
  row.writeBigUInt64LE(446_000n, 56);
  row[64] = 2;
  row[65] = 5;
  const refusedHit = recordedFromLedgerBytes(onlyRefused, SLOT_NONCE);
  assert.equal(refusedHit?.decision, "refused");
  assert.equal(refusedHit?.reason, "over per-payment maximum");
  assert.equal(refusedHit?.reasonCode, 5);
  assert.equal(recordedFromLedgerBytes(Buffer.alloc(16), SLOT_NONCE), null);
});

test("index repairs from the chain ledger whether or not a remote journal is configured", () => {
  const text = readFileSync(INDEX, "utf8");
  const start = text.indexOf("async function withJournalAndFeed");
  const end = text.indexOf("async function lastAppendedAfter");
  assert.ok(start >= 0 && end > start);
  const fn = text.slice(start, end);
  const journalAt = fn.indexOf("new JsonlJournal");
  const fetchAt = fn.indexOf("fetchChainDecisions");
  assert.ok(journalAt >= 0 && fetchAt > journalAt);
  assert.equal(
    fn.slice(journalAt, fetchAt).includes("store !== null"),
    false,
    "the chain repair must run for a local journal too",
  );
  assert.match(fn, /recordedCharge/);
  const calls = fn.split("processWindow({").length - 1;
  assert.equal(calls, 0, "withJournalAndFeed wires the readers; the two call sites are outside it");
  const both = text.split("processWindow({").length - 1;
  assert.equal(both, 2);
  for (const block of text.split("processWindow({").slice(1)) {
    assert.match(block.slice(0, 500), /recordedCharge,/);
  }
});
