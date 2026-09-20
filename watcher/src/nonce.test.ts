import assert from "node:assert/strict";
import { test } from "node:test";
import { nonceFromWindowStart } from "./nonce.js";

test("nonce is the unix seconds of the window start and is stable", () => {
  const a = "2026-09-20T00:00:00+02:00";
  const b = "2026-09-19T22:00:00.000Z";
  const first = nonceFromWindowStart(a);
  const second = nonceFromWindowStart(a);
  assert.equal(first, second);
  assert.equal(first, nonceFromWindowStart(b));
  assert.equal(first, BigInt("1789855200"));
  const later = nonceFromWindowStart("2026-09-20T01:30:00+02:00");
  assert.equal(later > first, true);
  assert.equal(later, first + 90n * 60n);
});
