import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PriceFeed } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import { processWindow } from "./run.js";
import { decodeMandateLastNonce, findPaidInLedgerBytes } from "./chain.js";

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

test("a rate limited cadence slot stays due afterwards", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-429-")), "d.jsonl"));
  const lines: string[] = [];
  let calls = 0;
  const args = {
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: (line: string) => lines.push(line),
    feedAttempts: 1,
    feedRetryMs: 0,
    submit: async () => {
      calls += 1;
      throw new Error("429 Too Many Requests");
    },
  };
  assert.equal(await processWindow(args), "deferred");
  assert.equal(calls, 1);
  assert.equal(journal.hasNonce(1789855200n), false, "the window is still owed a charge");
  assert.equal(journal.hasGap(1789855200n), true, "a rate limit is recorded as a retryable gap");
  assert.equal(journal.load()[0]?.reason, "rpc rate limited on all endpoints");
  assert.ok(lines.some((line) => /rate limited/.test(line)));
  assert.ok(!lines.some((line) => /rpc failure/.test(line)));

  let paid = 0;
  const retry = await processWindow({
    ...args,
    submit: async (amount, nonce) => {
      paid += 1;
      assert.equal(nonce, 1789855200n);
      assert.equal(amount, 446_000n);
      return {
        decision: "paid" as const,
        reason: "ok",
        reasonCode: 0,
        suggestedOverride: null,
        signature: "after-429-sig",
      };
    },
  });
  assert.equal(retry, "submitted");
  assert.equal(paid, 1);
  assert.equal(journal.load().at(-1)?.decision, "paid");
  assert.equal(journal.hasNonce(1789855200n), true);
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

test("a feed gap and a rate-limit gap stay distinguishable by reason", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-gap-kinds-")), "d.jsonl"));
  await processWindow({
    at: new Date(windowStart),
    feed: { async getWindow() { return null; } },
    journal,
    submit: async () => {
      throw new Error("should not submit");
    },
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  });
  const feedGap = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-rl-kinds-")), "d.jsonl"));
  await processWindow({
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal: feedGap,
    submit: async () => {
      throw new Error("429 Too Many Requests");
    },
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  });
  assert.equal(journal.load()[0]?.reason, "feed unavailable");
  assert.equal(feedGap.load()[0]?.reason, "rpc rate limited on all endpoints");
  assert.notEqual(journal.load()[0]?.reason, feedGap.load()[0]?.reason);
});

test("a chain lastNonce at this window is recovered instead of submitted", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-chain-settled-")), "d.jsonl"));
  let submits = 0;
  const result = await processWindow({
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    submit: async () => {
      submits += 1;
      throw new Error("should not submit");
    },
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    reader: {
      chainLastNonce: async () => 1789855200n,
      recoverSettled: async () => ({
        decision: "paid" as const,
        reason: "ok",
        reasonCode: 0,
        suggestedOverride: null,
        signature: "recovered-sig",
        amount: 446_000n,
      }),
      recordedCharge: async () => null,
    },
  });
  assert.equal(result, "submitted");
  assert.equal(submits, 0);
  assert.equal(journal.load()[0]?.decision, "paid");
  assert.equal(journal.load()[0]?.signature, "recovered-sig");
  assert.notEqual(journal.load()[0]?.decision, "refused");
});

test("decodeMandateLastNonce reads the u64 at the mandate last_nonce offset", () => {
  const data = Buffer.alloc(232);
  data.writeBigUInt64LE(1789855200n, 224);
  assert.equal(decodeMandateLastNonce(data), 1789855200n);
});

test("findPaidInLedgerBytes returns the paid ring entry for a nonce", () => {
  const disc = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
  const body = Buffer.alloc(40 + 72);
  body.writeUInt32LE(1, 32);
  const entry = body.subarray(40, 112);
  entry.writeBigUInt64LE(446_000n, 8);
  entry.writeBigUInt64LE(1789855200n, 48);
  entry[64] = 1;
  const data = Buffer.concat([disc, body]);
  const hit = findPaidInLedgerBytes(data, 1789855200n);
  assert.equal(hit?.amount, 446_000n);
});

// Critic fixtures, round 1. Each one goes RED on b23b9d3.

test("critic: a slot that only saw a rate limit leaves a retryable trace, so it survives the day boundary and shows in status", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-429-")), "d.jsonl"));
  const result = await processWindow({
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    submit: async () => {
      throw new Error("429 Too Many Requests");
    },
  });
  assert.notEqual(result, "submitted");
  // dueSlots (cadence.ts:72) only returns today's slots. With no row the
  // window is gone from every code path at midnight and `status` never counts
  // it. A gap row is not terminal (journal.ts:21-30), so recording the outage
  // keeps the window retryable and visible at no cost.
  assert.equal(journal.hasNonce(1789855200n), false, "the window must stay owed");
  assert.equal(journal.hasGap(1789855200n), true, "the outage must be on record");
  assert.equal(journal.counts().gap, 1);
});

test("critic: a 429 after the send landed must not turn a paid window into a refused row", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-landed-")), "d.jsonl"));
  // Fake chain: the first charge lands (last_nonce advances) but its
  // confirmation is throttled, which is what a 429 inside chain.ts:93-99
  // (confirmTransaction polling or getTransaction) looks like from here.
  // The retry carries a stale nonce and the program refuses it (lib.rs:381).
  let lastNonce = 0n;
  const submit = async (_amount: bigint, nonce: bigint) => {
    if (nonce <= lastNonce) {
      return {
        decision: "refused" as const,
        reason: "nonce already settled",
        reasonCode: 3,
        suggestedOverride: null,
        signature: "replay-sig",
      };
    }
    lastNonce = nonce;
    throw new Error("429 Too Many Requests");
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
  assert.equal(await processWindow(args), "deferred");
  await processWindow(args);
  const row = journal.load().find((r) => r.nonce === "1789855200");
  assert.ok(row, "the window must be on record");
  assert.notEqual(
    row?.decision,
    "refused",
    "the chain paid this window; a stale-nonce refusal on the resubmit is not its decision",
  );
});

// Critic fixtures, round 2. Each one goes RED on 1ea83b4.

test("critic r2: a transient non-429 failure on the pre-submit last_nonce read is retried, not thrown out of the run loop", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-r2-502-")), "d.jsonl"));
  let reads = 0;
  let submits = 0;
  const result = await processWindow({
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    reader: {
      chainLastNonce: async () => {
        reads += 1;
        if (reads === 1) throw new Error("502 Bad Gateway: Bad Gateway");
        return 0n;
      },
      recoverSettled: async () => null,
      recordedCharge: async () => null,
    },
    submit: async () => {
      submits += 1;
      return { decision: "paid" as const, reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig-after-blip" };
    },
  });
  // README.md:28 "An RPC failure backs off and retries the same window. The
  // thread is not dropped." On main the only chain call sat inside
  // withRpcBackoff. The new pre-submit read at run.ts:182-189 sits outside it,
  // so one 502 or ECONNRESET on getAccountInfo escapes processWindow,
  // processDue and cmdRun, and main().catch ends the run loop.
  assert.equal(result, "submitted");
  assert.equal(reads, 2);
  assert.equal(submits, 1);
  assert.equal(journal.load()[0]?.decision, "paid");
});

test("critic r2: a stale-nonce refusal on a window a later payment overtook is not journalled as paid", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-r2-overtaken-")), "d.jsonl"));
  let reads = 0;
  const later = 1789855200n + 21_600n;
  const result = await processWindow({
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    reader: {
      chainLastNonce: async () => {
        reads += 1;
        return reads === 1 ? 0n : later;
      },
      recoverSettled: async () => null,
      recordedCharge: async () => null,
    },
    submit: async () => ({
      decision: "refused" as const,
      reason: "nonce already settled",
      reasonCode: 3,
      suggestedOverride: null,
      signature: "replay-sig",
    }),
  });
  // Between the pre-submit read and the send, last_nonce moved past this
  // window (a second submitter paid a later slot). The program refuses the
  // stale nonce. run.ts:284-297 then writes decision=paid with the attempted
  // amount and no signature for a window the chain never paid. The pre-submit
  // branch already closes this honestly (closeAlreadySettled: nonce < settled
  // is "window overtaken by a later settled charge"); the post-refusal branch
  // has to re-read last_nonce and reuse it instead of assuming paid.
  const row = journal.load().find((r) => r.nonce === "1789855200");
  assert.ok(row, "the window must be on record");
  assert.notEqual(row?.decision, "refused");
  assert.notEqual(row?.decision, "paid", "the chain paid a later window, not this one");
  assert.notEqual(result, "submitted");
});

test("critic r2: a feed gap already on record does not hide a later rate limit on the same window", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-r2-gapkinds-")), "d.jsonl"));
  await processWindow({
    at: new Date(windowStart),
    feed: { async getWindow() { return null; } },
    journal,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    submit: async () => {
      throw new Error("should not submit");
    },
  });
  const result = await processWindow({
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    submit: async () => {
      throw new Error("429 Too Many Requests");
    },
  });
  assert.equal(result, "deferred");
  // run.ts:107 dedupes on hasGap(nonce), which is per window, not per kind.
  // The feed came back and the RPC throttled for the rest of the day, but the
  // only row for this window says "feed unavailable". One row per outage kind
  // keeps both facts on record; the window stays retryable either way.
  const reasons = journal.load().filter((r) => r.nonce === "1789855200").map((r) => r.reason);
  assert.ok(reasons.includes("feed unavailable"));
  assert.ok(reasons.includes("rpc rate limited on all endpoints"), `journal reasons: ${reasons.join(", ")}`);
  assert.equal(journal.hasNonce(1789855200n), false, "the window is still owed a charge");
});

// Critic fixtures, round 3. Each one confirms a round 2 finding by execution
// on 4867104 and goes RED on e03cbc3.

const R3_NONCE = 1789855200n;
const R3_LATER = R3_NONCE + 21_600n;
const R3_STALE = {
  decision: "refused" as const,
  reason: "nonce already settled",
  reasonCode: 3,
  suggestedOverride: null,
  signature: "stale-sig",
};
const R3_PAID_RECOVERED = {
  decision: "paid" as const,
  reason: "ok",
  reasonCode: 0,
  suggestedOverride: null,
  signature: "recovered-sig",
  amount: 446_000n,
};

function r3Args(journal: JsonlJournal) {
  return {
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  };
}

async function r3CaptureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string[] }> {
  const stderr: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

// N1. A non-429 transient on each of the four chain reads the branch added
// stays inside withRpcBackoff: processWindow returns instead of throwing, the
// retry lands, and the failure line goes to stderr. index.ts:62 and :119 have
// no catch, so a throw here is the end of the run loop.
const r3TransientCases: {
  name: string;
  label: string;
  failure: string;
  reads: () => bigint;
  recoveries: () => typeof R3_PAID_RECOVERED | null;
  submit: () => typeof R3_STALE | { decision: "paid"; reason: string; reasonCode: number; suggestedOverride: null; signature: string };
  expectResult: "submitted" | "skipped";
  expectDecision: "paid" | "skipped";
  expectSignature: string | null;
  expectSubmits: number;
}[] = [
  {
    name: "pre-submit last_nonce read",
    label: "chain last_nonce",
    failure: "fetch failed: ECONNRESET",
    reads: (() => {
      let n = 0;
      return () => {
        n += 1;
        if (n === 1) throw new Error("fetch failed: ECONNRESET");
        return 0n;
      };
    })(),
    recoveries: () => null,
    submit: () => ({ decision: "paid", reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig-after-blip" }),
    expectResult: "submitted",
    expectDecision: "paid",
    expectSignature: "sig-after-blip",
    expectSubmits: 1,
  },
  {
    name: "pre-submit recovery of an already settled window",
    label: "recover settled",
    failure: "503 Service Unavailable",
    reads: () => R3_NONCE,
    recoveries: (() => {
      let n = 0;
      return () => {
        n += 1;
        if (n === 1) throw new Error("503 Service Unavailable");
        return R3_PAID_RECOVERED;
      };
    })(),
    submit: () => {
      throw new Error("must not submit a window the chain already settled");
    },
    expectResult: "submitted",
    expectDecision: "paid",
    expectSignature: "recovered-sig",
    expectSubmits: 0,
  },
  {
    name: "post-refusal last_nonce re-read",
    label: "chain last_nonce",
    failure: "socket hang up",
    reads: (() => {
      let n = 0;
      return () => {
        n += 1;
        if (n === 1) return 0n;
        if (n === 2) throw new Error("socket hang up");
        return R3_LATER;
      };
    })(),
    recoveries: () => null,
    submit: () => R3_STALE,
    expectResult: "skipped",
    expectDecision: "skipped",
    expectSignature: "stale-sig",
    expectSubmits: 1,
  },
  {
    name: "post-refusal recovery",
    label: "recover settled",
    failure: "502 Bad Gateway: Bad Gateway",
    reads: (() => {
      let n = 0;
      return () => {
        n += 1;
        return n === 1 ? 0n : R3_NONCE;
      };
    })(),
    recoveries: (() => {
      let n = 0;
      return () => {
        n += 1;
        if (n === 1) throw new Error("502 Bad Gateway: Bad Gateway");
        return R3_PAID_RECOVERED;
      };
    })(),
    submit: () => R3_STALE,
    expectResult: "submitted",
    expectDecision: "paid",
    expectSignature: "recovered-sig",
    expectSubmits: 1,
  },
];

for (const c of r3TransientCases) {
  test(`critic r3: a transient non-429 failure on the ${c.name} is retried inside the run loop`, async () => {
    const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-r3-n1-")), "d.jsonl"));
    let submits = 0;
    const { value: result, stderr } = await r3CaptureStderr(() =>
      processWindow({
        ...r3Args(journal),
        reader: {
          chainLastNonce: async () => c.reads(),
          recoverSettled: async () => c.recoveries(),
          recordedCharge: async () => null,
        },
        submit: async () => {
          submits += 1;
          return c.submit();
        },
      }),
    );
    assert.equal(result, c.expectResult);
    assert.equal(submits, c.expectSubmits);
    const row = journal.load().find((r) => r.nonce === R3_NONCE.toString());
    assert.ok(row, "the window must be on record");
    assert.equal(row?.decision, c.expectDecision);
    assert.equal(row?.signature, c.expectSignature);
    assert.equal(journal.hasNonce(R3_NONCE), true, "the window must be closed after the retry");
    assert.ok(
      stderr.some((line) => line.includes(`${c.label}: rpc failure, retry in`) && line.includes(c.failure)),
      `the transient must be logged as a failure on stderr, got: ${stderr.join(" | ")}`,
    );
  });
}

// N2. The program refuses a stale nonce, recovery finds nothing, and the
// re-read of last_nonce says the row must only claim what the chain supports.
test("critic r3: stale refusal, recovery empty, re-read still below the window: journal says gap, not paid, not refused, window stays owed", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-r3-n2-lag-")), "d.jsonl"));
  let submits = 0;
  const args = {
    ...r3Args(journal),
    // The chain confirmed a stale refusal, so last_nonce >= nonce on the
    // leader. A read that still says 0 is a lagging node: nothing on the
    // chain we can see supports "paid".
    reader: {
      chainLastNonce: async () => 0n,
      recoverSettled: async () => null,
      recordedCharge: async () => null,
    },
    submit: async () => {
      submits += 1;
      return R3_STALE;
    },
  };
  const result = await processWindow(args);
  assert.equal(result, "gap");
  assert.equal(submits, 1);
  const rows = journal.load().filter((r) => r.nonce === R3_NONCE.toString());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "gap");
  assert.equal(rows[0]?.reason, "stale nonce; chain did not confirm this window paid");
  assert.equal(rows[0]?.signature, "stale-sig");
  assert.equal(rows[0]?.amount, "0");
  assert.equal(journal.hasNonce(R3_NONCE), false, "the window is still owed");
  // A second cycle under the same lag records nothing new for this window.
  await processWindow(args);
  assert.equal(journal.load().filter((r) => r.nonce === R3_NONCE.toString()).length, 1);
});

test("critic r3: stale refusal, recovery empty, re-read equals the window: journal says paid with no signature and zero amount, nothing more", async () => {
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-r3-n2-eq-")), "d.jsonl"));
  let reads = 0;
  const result = await processWindow({
    ...r3Args(journal),
    // last_nonce is written only on the paid path (lib.rs:187), so a re-read
    // equal to this nonce is the chain's own statement that this window paid.
    // The ring and history give nothing, so amount and signature stay unknown.
    reader: {
      chainLastNonce: async () => {
        reads += 1;
        return reads === 1 ? 0n : R3_NONCE;
      },
      recoverSettled: async () => null,
      recordedCharge: async () => null,
    },
    submit: async () => R3_STALE,
  });
  assert.equal(result, "submitted");
  const rows = journal.load().filter((r) => r.nonce === R3_NONCE.toString());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "paid");
  assert.equal(rows[0]?.reason, "chain shows this window paid; signature could not be recovered");
  assert.equal(rows[0]?.signature, null);
  assert.equal(rows[0]?.amount, "0");
  assert.equal(journal.hasNonce(R3_NONCE), true);
});

// N3. A feed outage and a rate limit on the same window, in either order and
// each repeated, leave exactly one row per outage kind and the window owed.
for (const order of [["feed", "rpc"], ["rpc", "feed"]] as const) {
  test(`critic r3: feed outage and rate limit on one window (${order.join(" then ")}) are both legible afterwards`, async () => {
    const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-r3-n3-")), "d.jsonl"));
    const step = async (kind: "feed" | "rpc") => {
      if (kind === "feed") {
        const result = await processWindow({
          ...r3Args(journal),
          feed: { async getWindow() { return null; } },
          submit: async () => {
            throw new Error("should not submit without a price");
          },
        });
        assert.equal(result, "gap");
        return;
      }
      const result = await processWindow({
        ...r3Args(journal),
        submit: async () => {
          throw new Error("429 Too Many Requests");
        },
      });
      assert.equal(result, "deferred");
    };
    await step(order[0]);
    await step(order[1]);
    await step(order[1]);
    await step(order[0]);
    const rows = journal.load().filter((r) => r.nonce === R3_NONCE.toString());
    assert.equal(rows.length, 2, `one row per outage kind, got: ${rows.map((r) => r.reason).join(" | ")}`);
    assert.deepEqual(
      new Set(rows.map((r) => r.reason)),
      new Set(["feed unavailable", "rpc rate limited on all endpoints"]),
    );
    assert.ok(rows.every((r) => r.decision === "gap"));
    assert.equal(journal.counts().gap, 2);
    assert.equal(journal.hasNonce(R3_NONCE), false, "the window is still owed a charge");
    // Feed back and RPC open: the window closes on top of both notes.
    const result = await processWindow({
      ...r3Args(journal),
      submit: async () => ({ decision: "paid" as const, reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "after-outages" }),
    });
    assert.equal(result, "submitted");
    assert.equal(journal.hasNonce(R3_NONCE), true);
    assert.equal(journal.load().filter((r) => r.nonce === R3_NONCE.toString()).length, 3);
  });
}
