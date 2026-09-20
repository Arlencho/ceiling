import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { amountBaseUnits, parseDecimalToScaled, PRICE_SCALE, sekPerKwhToScaled } from "./money.js";

test("parseDecimalToScaled reads the decimal string as an integer at the given scale", () => {
  const cases: Array<[string, number, bigint]> = [
    ["0", 8, 0n],
    ["0.0", 8, 0n],
    ["1", 8, 100_000_000n],
    ["0.00892", 8, 892_000n],
    ["0.00418", 8, 418_000n],
    ["0.01039", 8, 1_039_000n],
    ["0.12465", 8, 12_465_000n],
    ["-0.01", 8, -1_000_000n],
    ["1.2", 2, 120n],
  ];
  for (const [raw, scale, want] of cases) {
    assert.equal(parseDecimalToScaled(raw, scale), want, raw);
  }
});

test("parseDecimalToScaled rejects scientific notation", () => {
  assert.throws(() => parseDecimalToScaled("1e-3", 8));
});

test("amountBaseUnits converts 50 kWh at live SE3 prices into 6-decimal base units", () => {
  const kwhMilli = 50_000n;
  const cases: Array<[string, bigint]> = [
    ["0.00418", 209_000n],
    ["0.00892", 446_000n],
    ["0.01039", 519_500n],
    ["0.12465", 6_232_500n],
    ["0.00011", 5_500n],
    ["0", 0n],
  ];
  for (const [sek, want] of cases) {
    const got = amountBaseUnits({
      kwhMilli,
      sekPerKwhScaled: sekPerKwhToScaled(sek),
      mintDecimals: 6,
    });
    assert.equal(got, want, `${sek} SEK/kWh * 50 kWh`);
  }
});

test("amountBaseUnits rounds leftover subunits down", () => {
  // 1 millikWh * 1 scaled unit * 10^6 / (10^3 * 10^8) = 0 with integer division.
  const got = amountBaseUnits({
    kwhMilli: 1n,
    sekPerKwhScaled: 1n,
    mintDecimals: 6,
  });
  assert.equal(got, 0n);
});

test("money.ts contains no float arithmetic", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "money.ts"), "utf8");
  assert.equal(/parseFloat|Number\.parse|Math\.| \* 0\./.test(src), false);
  assert.equal(src.includes("PRICE_SCALE"), true);
  assert.equal(PRICE_SCALE, 8);
});
