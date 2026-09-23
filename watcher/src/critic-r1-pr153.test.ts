// Critic round 1 fixture for PR #153 (issue #148).
//
// The idle fixture in issues-123-126.test.ts seeds the journal at time t and
// the child computes dueSlots at a later time t2. The seed closes the cadence
// boundary only if every slot due at t2 has a row. This pins that property for
// the new seed (dueSlots(t) plus nextSlot(t)) and shows the old seed
// (dueSlots(t) alone) leaves a slot uncovered at every boundary, DST days and
// midnight included.
import assert from "node:assert/strict";
import test from "node:test";
import { CADENCE_HOURS, dueSlots, nextSlot } from "./cadence.js";

const STARTUP_MS = 15_000;
const DAYS = [
  "2026-01-15",
  "2026-03-28", // day before the spring DST change in Stockholm
  "2026-03-29", // spring DST change
  "2026-06-30",
  "2026-09-23",
  "2026-10-24", // day before the autumn DST change
  "2026-10-25", // autumn DST change
  "2026-12-31", // year boundary
];

function boundaries(): Date[] {
  const out: Date[] = [];
  for (const day of DAYS) {
    for (const hour of CADENCE_HOURS) {
      // Local Stockholm wall time; the offset does not matter here because the
      // seed time is taken one second before whatever instant the slot lands on.
      for (const offset of ["+01:00", "+02:00"]) {
        out.push(new Date(`${day}T${String(hour).padStart(2, "0")}:00:00${offset}`));
      }
    }
  }
  return out;
}

function covered(seed: Date[], later: Date): boolean {
  const keys = new Set(seed.map((s) => s.getTime()));
  return dueSlots(later).every((s) => keys.has(s.getTime()));
}

test("seeding dueSlots(t) plus nextSlot(t) covers every slot due within the child's startup window", () => {
  for (const boundary of boundaries()) {
    for (const before of [1, 1_000, STARTUP_MS - 1]) {
      const t = new Date(boundary.getTime() - before);
      const seed = [...dueSlots(t), nextSlot(t)];
      for (const after of [0, 1, 1_000, STARTUP_MS]) {
        const t2 = new Date(t.getTime() + after);
        assert.ok(covered(seed, t2), `uncovered due slot at t=${t.toISOString()} t2=${t2.toISOString()}`);
      }
    }
  }
});

test("seeding dueSlots(t) alone leaves the slot uncovered on every real cadence boundary", () => {
  let real = 0;
  for (const boundary of boundaries()) {
    const t = new Date(boundary.getTime() - 1);
    // Only instants that are actually a slot edge count; the offset sweep above
    // also produces instants an hour off the edge, which are not boundaries.
    if (nextSlot(t).getTime() !== boundary.getTime()) continue;
    real += 1;
    const seed = dueSlots(t);
    assert.equal(covered(seed, boundary), false, `old seed covered ${boundary.toISOString()}`);
  }
  assert.equal(real, DAYS.length * CADENCE_HOURS.length, "every day contributed each cadence edge");
});

test("nextSlot(t) is never already in dueSlots(t), so the extra row is one row", () => {
  for (const boundary of boundaries()) {
    for (const delta of [-STARTUP_MS, -1, 0, 1, STARTUP_MS]) {
      const t = new Date(boundary.getTime() + delta);
      const due = dueSlots(t).map((s) => s.getTime());
      assert.ok(!due.includes(nextSlot(t).getTime()), `duplicate at ${t.toISOString()}`);
    }
  }
});
