/** Critic round 1 fixture for PR 137. Pins the three sentences the README
 * now makes about GET /api/quote: a chargeable window off the cadence slot
 * answers 200 with nonce null; an on-slot window answers a decimal string
 * equal to the unix seconds of the window start; a down feed answers 503
 * with no amount, no nonce and no price.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { windowContaining, type PriceFeed, type PriceWindow } from "../../watcher/src/feed.js";
import { buildState, quoteResponse } from "./state.js";

const BASE = { kwhMilli: 50_000n, mintDecimals: 6 };
const ENDPOINTS = { mint: "Mint", mintDecimals: 6, merchantTokenAccount: "MerchantTokenAcct" };

const shifted: PriceWindow = { timeStart: "2026-09-22T15:59:57Z", timeEnd: "2026-09-22T16:14:57Z", sekPerKwh: "2.00000" };
const honest1600: PriceWindow = { timeStart: "2026-09-22T16:00:00Z", timeEnd: "2026-09-22T16:15:00Z", sekPerKwh: "2.00000" };

function feedOf(windows: PriceWindow[]): PriceFeed {
  return { async getWindow(at) { return windowContaining(windows, at); } };
}

test("critic r1 PR 137: README, chargeable window off the slot answers 200 with nonce null", async () => {
  const state = await buildState({ feed: feedOf([shifted]), at: new Date("2026-09-22T16:00:00Z"), ...BASE });
  const { status, body } = quoteResponse(state, ENDPOINTS);
  assert.equal(status, 200);
  assert.equal(body.nonce, null);
  assert.match(String(body.amount), /^[0-9]+$/);
});

test("critic r1 PR 137: README, on-slot nonce is the decimal unix seconds of window_start", async () => {
  const state = await buildState({ feed: feedOf([honest1600]), at: new Date("2026-09-22T16:05:00Z"), ...BASE });
  const { status, body } = quoteResponse(state, ENDPOINTS);
  assert.equal(status, 200);
  assert.equal(typeof body.nonce, "string");
  assert.match(String(body.nonce), /^[0-9]+$/);
  assert.equal(body.nonce, String(Date.parse(String(body.window_start)) / 1000));
});

test("critic r1 PR 137: README, feed down answers 503 with no amount, no nonce, no price", async () => {
  const down: PriceFeed = { async getWindow() { return null; } };
  const state = await buildState({ feed: down, at: new Date("2026-09-22T16:00:00Z"), ...BASE });
  const { status, body } = quoteResponse(state, ENDPOINTS);
  assert.equal(status, 503);
  assert.equal(typeof body.error, "string");
  assert.ok(!("amount" in body));
  assert.ok(!("nonce" in body));
  assert.ok(!("sek_per_kwh" in body));
});
