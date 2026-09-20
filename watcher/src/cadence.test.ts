import assert from "node:assert/strict";
import { test } from "node:test";
import { dueSlots, nextSlot, zonedLocalToDate } from "./cadence.js";

test("00:00 Stockholm on 2026-09-20 is 22:00 UTC the day before", () => {
  const d = zonedLocalToDate(2026, 9, 20, 0, 0);
  assert.equal(d.toISOString(), "2026-09-19T22:00:00.000Z");
});

test("dueSlots at 04:17 Stockholm includes only the 00:00 cadence tick", () => {
  const now = new Date("2026-09-20T04:17:00+02:00");
  const due = dueSlots(now);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.toISOString(), "2026-09-19T22:00:00.000Z");
});

test("nextSlot after 00:00 is 06:00 Stockholm", () => {
  const now = new Date("2026-09-20T00:01:00+02:00");
  assert.equal(nextSlot(now).toISOString(), "2026-09-20T04:00:00.000Z");
});
