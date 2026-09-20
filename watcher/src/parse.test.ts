import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChargeLogs } from "./parse.js";

test("parseChargeLogs reads a paid program log", () => {
  const got = parseChargeLogs([
    "Program log: VETO PAID amount=209000 spent=209000 of cap=100000000 remaining=99791000",
  ]);
  assert.equal(got.decision, "paid");
  assert.equal(got.reason, "ok");
  assert.equal(got.reasonCode, 0);
});

test("parseChargeLogs reads a refused program log as a success path", () => {
  const got = parseChargeLogs([
    "Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=519500 per_tx_max=500000 remaining=100000000 override_to_clear=519500",
  ]);
  assert.equal(got.decision, "refused");
  assert.equal(got.reason, "over per-payment maximum");
  assert.equal(got.reasonCode, 5);
  assert.equal(got.suggestedOverride, 519500n);
});
