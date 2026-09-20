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
