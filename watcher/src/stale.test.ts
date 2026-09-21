import assert from "node:assert/strict";
import { test } from "node:test";
import { STALE_AFTER_MS } from "./cadence.js";
import type { JournalRow } from "./journal.js";
import { isJournalStale, lastDecisionAt } from "./stale.js";

const HOUR = 60 * 60 * 1000;

function row(ts: string): JournalRow {
  return {
    ts,
    window_start: ts,
    window_end: null,
    sek_per_kwh: "0.01",
    kwh_milli: "50000",
    amount: "1",
    nonce: "1",
    decision: "paid",
    reason: "ok",
    reason_code: 0,
    signature: "sig",
    suggested_override: null,
  };
}

test("a window and a half is nine hours", () => {
  assert.equal(STALE_AFTER_MS, 9 * HOUR);
});

test("isJournalStale is false when the last decision is inside a window and a half", () => {
  const now = new Date("2026-09-21T18:00:00Z");
  const rows = [row("2026-09-21T12:00:00.000Z")];
  assert.equal(isJournalStale({ rows, now, emptySince: null }), false);
});

test("isJournalStale is true when the last decision is older than a window and a half", () => {
  const now = new Date("2026-09-21T18:00:00Z");
  const rows = [row("2026-09-21T08:59:59.000Z")];
  assert.equal(isJournalStale({ rows, now, emptySince: null }), true);
});

test("isJournalStale at exactly a window and a half is still fresh", () => {
  const now = new Date("2026-09-21T18:00:00Z");
  const rows = [row("2026-09-21T09:00:00.000Z")];
  assert.equal(isJournalStale({ rows, now, emptySince: null }), false);
});

test("an empty journal is stale once the object itself is older than a window and a half", () => {
  const now = new Date("2026-09-21T18:00:00Z");
  assert.equal(
    isJournalStale({ rows: [], now, emptySince: new Date("2026-09-21T08:59:59.000Z") }),
    true,
  );
  assert.equal(
    isJournalStale({ rows: [], now, emptySince: new Date("2026-09-21T12:00:00.000Z") }),
    false,
  );
});

test("a missing journal with no object timestamp is stale", () => {
  const now = new Date("2026-09-21T18:00:00Z");
  assert.equal(isJournalStale({ rows: [], now, emptySince: null }), true);
});

test("lastDecisionAt returns the latest parseable ts", () => {
  const rows = [row("2026-09-21T00:00:00.000Z"), row("2026-09-21T06:00:00.000Z")];
  assert.equal(lastDecisionAt(rows)?.toISOString(), "2026-09-21T06:00:00.000Z");
});
