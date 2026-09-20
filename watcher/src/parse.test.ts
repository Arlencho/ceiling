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

// Regression for the round 2 review of #37: reason 10 existed in the program
// before it existed in this package, so a frozen-account refusal logged on
// chain parsed to "unknown" here.
test("the REFUSED log line for a frozen account parses to reason 10", () => {
  const parsed = parseChargeLogs([
    "Program log: VETO REFUSED reason=10 (account frozen) amount=10000000 per_tx_max=60000000 remaining=500000000 override_to_clear=0",
  ]);
  assert.equal(parsed.decision, "refused");
  assert.equal(parsed.reasonCode, 10);
  assert.equal(parsed.reason, "account frozen");
});
