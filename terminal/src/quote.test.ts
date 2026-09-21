import assert from "node:assert/strict";
import test from "node:test";
import type { PriceWindow } from "../../watcher/src/feed.js";
import { formatBaseUnits, formatKwh, quoteForWindow } from "./quote.js";

const WINDOW: PriceWindow = {
  timeStart: "2026-09-20T00:00:00+02:00",
  timeEnd: "2026-09-20T00:15:00+02:00",
  sekPerKwh: "0.00892",
};

test("quoteForWindow quotes the documented 50 kWh example as integer base units", () => {
  // The watcher journal recorded this exact window on 2026-09-20: 50 kWh at
  // 0.00892 SEK/kWh is 0.446 tokens, which is 446000 base units at 6 decimals.
  const quote = quoteForWindow({ window: WINDOW, kwhMilli: 50_000n, mintDecimals: 6 });
  assert.ok(quote !== null);
  assert.equal(quote.amount, 446000n);
  assert.equal(typeof quote.amount, "bigint");
  assert.equal(quote.sekPerKwh, "0.00892");
  assert.equal(quote.windowStart, WINDOW.timeStart);
  assert.equal(quote.windowEnd, WINDOW.timeEnd);
  assert.equal(quote.kwhMilli, 50_000n);
});

test("quoteForWindow keeps the price text as the feed sent it, never a float", () => {
  const quote = quoteForWindow({
    window: { ...WINDOW, sekPerKwh: "1.23456789" },
    kwhMilli: 50_000n,
    mintDecimals: 6,
  });
  assert.ok(quote !== null);
  // 50 * 1.23456789 = 61.7283945 tokens, rounded down to base units.
  assert.equal(quote.amount, 61728394n);
  assert.equal(quote.sekPerKwh, "1.23456789");
});

test("quoteForWindow refuses a negative price instead of inventing a charge", () => {
  const quote = quoteForWindow({
    window: { ...WINDOW, sekPerKwh: "-0.5" },
    kwhMilli: 50_000n,
    mintDecimals: 6,
  });
  assert.equal(quote, null);
});

test("quoteForWindow refuses a zero amount", () => {
  const quote = quoteForWindow({
    window: { ...WINDOW, sekPerKwh: "0" },
    kwhMilli: 50_000n,
    mintDecimals: 6,
  });
  assert.equal(quote, null);
});

test("quoteForWindow propagates an unreadable price as an error, not a fallback", () => {
  assert.throws(() =>
    quoteForWindow({
      window: { ...WINDOW, sekPerKwh: "not-a-number" },
      kwhMilli: 50_000n,
      mintDecimals: 6,
    }),
  );
});

test("formatBaseUnits renders base units as a decimal string without floats", () => {
  assert.equal(formatBaseUnits(446000n, 6), "0.446");
  assert.equal(formatBaseUnits(1000000n, 6), "1");
  assert.equal(formatBaseUnits(1500000n, 6), "1.5");
  assert.equal(formatBaseUnits(1n, 6), "0.000001");
  assert.equal(formatBaseUnits(0n, 6), "0");
});

test("formatKwh renders millikWh as kWh", () => {
  assert.equal(formatKwh(50_000n), "50");
  assert.equal(formatKwh(1_500n), "1.5");
});
