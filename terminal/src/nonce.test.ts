import assert from "node:assert/strict";
import test from "node:test";
import { quoteForWindow } from "./quote.js";

const base = { kwhMilli: 50_000n, mintDecimals: 6 };

function quoteAt(timeStart: string, timeEnd: string) {
  const quote = quoteForWindow({
    window: { timeStart, timeEnd, sekPerKwh: "0.01" },
    ...base,
  });
  assert.ok(quote !== null);
  return quote;
}

test("nonce advances strictly from one 15-minute window to the next", () => {
  const first = quoteAt("2026-09-20T00:00:00+02:00", "2026-09-20T00:15:00+02:00");
  const second = quoteAt("2026-09-20T00:15:00+02:00", "2026-09-20T00:30:00+02:00");
  assert.ok(second.nonce > first.nonce);
  assert.equal(second.nonce - first.nonce, 900n);
});

test("nonce is the unix seconds of the window start", () => {
  const quote = quoteAt("2026-09-20T00:00:00+02:00", "2026-09-20T00:15:00+02:00");
  assert.equal(quote.nonce, BigInt(Date.parse("2026-09-20T00:00:00+02:00")) / 1000n);
});

test("the same window always yields the same nonce, so a restart cannot double quote", () => {
  const a = quoteAt("2026-09-20T00:00:00+02:00", "2026-09-20T00:15:00+02:00");
  const b = quoteAt("2026-09-20T00:00:00+02:00", "2026-09-20T00:15:00+02:00");
  assert.equal(a.nonce, b.nonce);
});

test("a cheaper later window still carries a higher nonce", () => {
  const expensiveEarly = quoteForWindow({
    window: { timeStart: "2026-09-20T00:00:00+02:00", timeEnd: "2026-09-20T00:15:00+02:00", sekPerKwh: "5" },
    ...base,
  });
  const cheapLate = quoteForWindow({
    window: { timeStart: "2026-09-20T00:15:00+02:00", timeEnd: "2026-09-20T00:30:00+02:00", sekPerKwh: "0.001" },
    ...base,
  });
  assert.ok(expensiveEarly !== null && cheapLate !== null);
  assert.ok(cheapLate.nonce > expensiveEarly.nonce);
});
