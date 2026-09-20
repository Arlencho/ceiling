import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PriceFeed } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import { processWindow } from "./run.js";

const windowStart = "2026-09-20T00:00:00+02:00";

function feedWith(sek: string): PriceFeed {
  return {
    async getWindow() {
      return {
        timeStart: windowStart,
        timeEnd: "2026-09-20T00:15:00+02:00",
        sekPerKwh: sek,
      };
    },
  };
}

test("re-running the same window does not resubmit", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-")), "decisions.jsonl"));
  let calls = 0;
  const submit = async (amount: bigint, nonce: bigint) => {
    calls += 1;
    assert.equal(nonce, 1789855200n);
    assert.equal(amount, 446_000n);
    return {
      decision: "paid" as const,
      reason: "ok",
      reasonCode: 0,
      suggestedOverride: null,
      signature: "fake-sig",
    };
  };
  const args = {
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    submit,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  };
  assert.equal(await processWindow(args), "submitted");
  assert.equal(await processWindow(args), "skipped");
  assert.equal(calls, 1);
  const rows = journal.load();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "paid");
  assert.equal(rows[0]?.signature, "fake-sig");
  assert.equal(rows[0]?.amount, "446000");
});

test("a chain refusal is recorded as a success and does not throw", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-")), "decisions.jsonl"));
  const submit = async () => ({
    decision: "refused" as const,
    reason: "over per-payment maximum",
    reasonCode: 5,
    suggestedOverride: 519_500n,
    signature: "refuse-sig",
  });
  const result = await processWindow({
    at: new Date("2026-09-20T01:30:00+02:00"),
    feed: {
      async getWindow() {
        return {
          timeStart: "2026-09-20T01:30:00+02:00",
          timeEnd: "2026-09-20T01:45:00+02:00",
          sekPerKwh: "0.01039",
        };
      },
    },
    journal,
    submit,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  });
  assert.equal(result, "submitted");
  assert.equal(journal.load()[0]?.decision, "refused");
  assert.equal(journal.counts().refused, 1);
});

test("a down feed writes a gap instead of a fabricated price", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-")), "decisions.jsonl"));
  let calls = 0;
  const result = await processWindow({
    at: new Date(windowStart),
    feed: { async getWindow() { return null; } },
    journal,
    submit: async () => {
      calls += 1;
      throw new Error("should not submit");
    },
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  });
  assert.equal(result, "gap");
  assert.equal(calls, 0);
  assert.equal(journal.load()[0]?.decision, "gap");
});

// Regression: a transient feed failure used to burn the window permanently,
// because a gap counted as a settled decision. Over an eighteen-day run each
// burned window is a row missing from the demo ledger.
test("a gap leaves the window due, and is recorded only once", () => {
  const dir = mkdtempSync(join(tmpdir(), "veto-gap-"));
  const journal = new JsonlJournal(join(dir, "decisions.jsonl"));
  const nonce = 1789898400n;

  journal.append({
    ts: new Date().toISOString(),
    window_start: "2026-09-20T10:00:00.000Z",
    window_end: null,
    sek_per_kwh: null,
    kwh_milli: "50000",
    amount: "0",
    nonce: nonce.toString(),
    decision: "gap",
    reason: "feed unavailable",
    reason_code: null,
    signature: null,
    suggested_override: null,
  });

  assert.equal(journal.hasNonce(nonce), false, "a gap must not settle the window");
  assert.equal(journal.hasGap(nonce), true, "but the outage is recorded");
  assert.equal(journal.maxSettledNonce(), 0n, "nothing settled on chain yet");
});

// A window below a settled nonce can never pay, because nonces only move
// forward on payment. Retrying it would add a meaningless replay refusal.
test("a window overtaken by a later settled charge is not retried", () => {
  const dir = mkdtempSync(join(tmpdir(), "veto-overtaken-"));
  const journal = new JsonlJournal(join(dir, "decisions.jsonl"));

  journal.append({
    ts: new Date().toISOString(),
    window_start: "2026-09-20T18:00:00+02:00",
    window_end: "2026-09-20T18:15:00+02:00",
    sek_per_kwh: "0.12465",
    kwh_milli: "50000",
    amount: "6232500",
    nonce: "1789927200",
    decision: "paid",
    reason: "ok",
    reason_code: 0,
    signature: "sig",
    suggested_override: null,
  });

  assert.equal(journal.maxSettledNonce(), 1789927200n);
  assert.ok(1789898400n <= journal.maxSettledNonce(), "the earlier window is overtaken");
});

// A refusal must not strand an earlier window. Only a payment advances
// last_nonce on chain, so treating a refused row as settling the nonce would
// have skipped a window that could still pay, which is exactly what happened
// to the 12:00 slot on 2026-09-20.
test("a refusal does not strand an earlier window", () => {
  const dir = mkdtempSync(join(tmpdir(), "veto-refusal-"));
  const journal = new JsonlJournal(join(dir, "decisions.jsonl"));
  journal.append({
    ts: new Date().toISOString(),
    window_start: "2026-09-20T18:00:00+02:00",
    window_end: "2026-09-20T18:15:00+02:00",
    sek_per_kwh: "0.12465",
    kwh_milli: "50000",
    amount: "6232500",
    nonce: "1789920000",
    decision: "refused",
    reason: "over per-payment maximum",
    reason_code: 5,
    signature: "sig",
    suggested_override: "6232500",
  });
  assert.equal(journal.maxSettledNonce(), 0n, "a refusal settles no nonce");
});

// Issue 39 repro: the overtaken guard used to live only in the feed-down
// branch, so a recovered feed submitted the gapped window and the program
// recorded a nonce-already-settled refusal. Keep this test as the issue
// stated it; do not weaken the assertions.
test("a gapped window overtaken by a later payment is closed as skipped even when the feed is back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "veto-overtaken-live-"));
  const journal = new JsonlJournal(join(dir, "d.jsonl"));
  const six = new Date("2026-09-20T04:00:00.000Z"); // 06:00 Stockholm
  journal.append({ ts: "", window_start: six.toISOString(), window_end: null, sek_per_kwh: null, kwh_milli: "50000", amount: "0", nonce: "1789876800", decision: "gap", reason: "feed unavailable", reason_code: null, signature: null, suggested_override: null });
  journal.append({ ts: "", window_start: "2026-09-20T10:00:00.000Z", window_end: null, sek_per_kwh: "0.001", kwh_milli: "50000", amount: "50", nonce: "1789898400", decision: "paid", reason: "ok", reason_code: 0, signature: "sig", suggested_override: null });
  const feed: PriceFeed = { getWindow: async () => ({ timeStart: "2026-09-20T06:00:00+02:00", timeEnd: "2026-09-20T06:15:00+02:00", sekPerKwh: "0.001" }) };
  const submits: bigint[] = [];
  await processWindow({ at: six, feed, journal, kwhMilli: 50000n, mintDecimals: 6, log: () => {},
    submit: async (_a, nonce) => { submits.push(nonce); return { decision: "refused", reason: "nonce already settled", reasonCode: 3, suggestedOverride: 0n, signature: "replay-sig" }; } });
  assert.equal(submits.length, 0, "an overtaken window must not be submitted");
  assert.equal(journal.load().at(-1)?.decision, "skipped");
});

test("a gapped window overtaken while the feed is still down is closed as skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "veto-overtaken-down-"));
  const journal = new JsonlJournal(join(dir, "d.jsonl"));
  const six = new Date("2026-09-20T04:00:00.000Z");
  journal.append({
    ts: "",
    window_start: six.toISOString(),
    window_end: null,
    sek_per_kwh: null,
    kwh_milli: "50000",
    amount: "0",
    nonce: "1789876800",
    decision: "gap",
    reason: "feed unavailable",
    reason_code: null,
    signature: null,
    suggested_override: null,
  });
  journal.append({
    ts: "",
    window_start: "2026-09-20T10:00:00.000Z",
    window_end: null,
    sek_per_kwh: "0.001",
    kwh_milli: "50000",
    amount: "50",
    nonce: "1789898400",
    decision: "paid",
    reason: "ok",
    reason_code: 0,
    signature: "sig",
    suggested_override: null,
  });
  const submits: bigint[] = [];
  const result = await processWindow({
    at: six,
    feed: { async getWindow() { return null; } },
    journal,
    kwhMilli: 50000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    submit: async (_a, nonce) => {
      submits.push(nonce);
      throw new Error("should not submit");
    },
  });
  assert.equal(result, "skipped");
  assert.equal(submits.length, 0, "an overtaken window must not be submitted");
  assert.equal(journal.load().at(-1)?.decision, "skipped");
});

test("a genuine gap is retried when the feed is back and nothing later has paid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "veto-gap-retry-"));
  const journal = new JsonlJournal(join(dir, "d.jsonl"));
  const six = new Date("2026-09-20T04:00:00.000Z");
  journal.append({
    ts: "",
    window_start: six.toISOString(),
    window_end: null,
    sek_per_kwh: null,
    kwh_milli: "50000",
    amount: "0",
    nonce: "1789876800",
    decision: "gap",
    reason: "feed unavailable",
    reason_code: null,
    signature: null,
    suggested_override: null,
  });
  const submits: bigint[] = [];
  const result = await processWindow({
    at: six,
    feed: {
      async getWindow() {
        return {
          timeStart: "2026-09-20T06:00:00+02:00",
          timeEnd: "2026-09-20T06:15:00+02:00",
          sekPerKwh: "0.001",
        };
      },
    },
    journal,
    kwhMilli: 50000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    submit: async (_a, nonce) => {
      submits.push(nonce);
      return {
        decision: "paid",
        reason: "ok",
        reasonCode: 0,
        suggestedOverride: null,
        signature: "pay-sig",
      };
    },
  });
  assert.equal(result, "submitted");
  assert.equal(submits.length, 1, "a genuine gap must stay retryable");
  assert.equal(journal.load().at(-1)?.decision, "paid");
});

test("a gapped window below a later refusal is still submitted when the feed is back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "veto-refusal-live-"));
  const journal = new JsonlJournal(join(dir, "d.jsonl"));
  const six = new Date("2026-09-20T04:00:00.000Z");
  journal.append({
    ts: "",
    window_start: six.toISOString(),
    window_end: null,
    sek_per_kwh: null,
    kwh_milli: "50000",
    amount: "0",
    nonce: "1789876800",
    decision: "gap",
    reason: "feed unavailable",
    reason_code: null,
    signature: null,
    suggested_override: null,
  });
  journal.append({
    ts: "",
    window_start: "2026-09-20T10:00:00.000Z",
    window_end: null,
    sek_per_kwh: "0.12465",
    kwh_milli: "50000",
    amount: "6232500",
    nonce: "1789898400",
    decision: "refused",
    reason: "over per-payment maximum",
    reason_code: 5,
    signature: "refuse-sig",
    suggested_override: "6232500",
  });
  const submits: bigint[] = [];
  const result = await processWindow({
    at: six,
    feed: {
      async getWindow() {
        return {
          timeStart: "2026-09-20T06:00:00+02:00",
          timeEnd: "2026-09-20T06:15:00+02:00",
          sekPerKwh: "0.001",
        };
      },
    },
    journal,
    kwhMilli: 50000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    submit: async (_a, nonce) => {
      submits.push(nonce);
      return {
        decision: "paid",
        reason: "ok",
        reasonCode: 0,
        suggestedOverride: null,
        signature: "pay-sig",
      };
    },
  });
  assert.equal(result, "submitted");
  assert.equal(submits.length, 1, "only a payment can overtake an earlier window");
  assert.equal(journal.load().at(-1)?.decision, "paid");
});

test("an unreadable price is recorded as a gap only once", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-unreadable-")), "d.jsonl"));
  let calls = 0;
  const args = {
    at: new Date(windowStart),
    feed: {
      async getWindow() {
        return {
          timeStart: windowStart,
          timeEnd: "2026-09-20T00:15:00+02:00",
          sekPerKwh: "1e",
        };
      },
    },
    journal,
    kwhMilli: 50000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    submit: async () => {
      calls += 1;
      throw new Error("should not submit");
    },
  };
  assert.equal(await processWindow(args), "gap");
  assert.equal(await processWindow(args), "gap");
  assert.equal(await processWindow(args), "gap");
  assert.equal(calls, 0);
  assert.equal(journal.load().length, 1);
  assert.equal(journal.load()[0]?.decision, "gap");
});
