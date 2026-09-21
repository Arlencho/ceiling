import assert from "node:assert/strict";
import test from "node:test";
import type { PriceFeed, PriceWindow } from "../../watcher/src/feed.js";
import { buildState, quoteResponse } from "./state.js";

const AT = new Date("2026-09-20T00:05:00+02:00");
const WINDOW: PriceWindow = {
  timeStart: "2026-09-20T00:00:00+02:00",
  timeEnd: "2026-09-20T00:15:00+02:00",
  sekPerKwh: "0.00892",
};

function feedWith(window: PriceWindow | null): PriceFeed {
  return { getWindow: async () => window };
}

const ENDPOINTS = { mint: "MintAddr", merchantTokenAccount: "MerchantTokenAcct", mintDecimals: 6 };

test("a reachable feed yields the real window, price, quote and nonce", async () => {
  const state = await buildState({ feed: feedWith(WINDOW), at: AT, kwhMilli: 50_000n, mintDecimals: 6 });
  assert.equal(state.feed, "ok");
  assert.ok(state.window !== null);
  assert.equal(state.window.sekPerKwh, "0.00892");
  assert.ok(state.quote !== null);
  assert.equal(state.quote.amount, 446000n);
  assert.equal(state.quote.nonce, BigInt(Date.parse(WINDOW.timeStart)) / 1000n);
  assert.equal(state.note, null);
  assert.match(state.sourceUrl, /^https:\/\/www\.elprisetjustnu\.se\/api\/v1\/prices\/2026\/09-20_SE3\.json$/);
});

test("an unreachable feed yields no price, no quote, and says so", async () => {
  const state = await buildState({ feed: feedWith(null), at: AT, kwhMilli: 50_000n, mintDecimals: 6 });
  assert.equal(state.feed, "unreachable");
  assert.equal(state.window, null);
  assert.equal(state.quote, null);
  assert.ok(state.note !== null && state.note.includes("could not be reached"));
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes("sekPerKwh"), "a down feed must not leak any price field");
});

test("a feed error is treated as unreachable, never as a stale price", async () => {
  const feed: PriceFeed = {
    getWindow: async () => {
      throw new Error("connection refused");
    },
  };
  const state = await buildState({ feed, at: AT, kwhMilli: 50_000n, mintDecimals: 6 });
  assert.equal(state.feed, "unreachable");
  assert.equal(state.quote, null);
});

test("quoteResponse exposes amount and nonce to the agent when the feed is up", async () => {
  const state = await buildState({ feed: feedWith(WINDOW), at: AT, kwhMilli: 50_000n, mintDecimals: 6 });
  const res = quoteResponse(state, ENDPOINTS);
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.amount, "446000");
  assert.equal(body.nonce, (BigInt(Date.parse(WINDOW.timeStart)) / 1000n).toString());
  assert.equal(body.merchant_token_account, "MerchantTokenAcct");
  assert.equal(body.mint_decimals, 6);
  assert.equal(body.sek_per_kwh, "0.00892");
  assert.equal(body.source, state.sourceUrl);
});

test("quoteResponse tells the agent the mint decimals so amount can be rendered", async () => {
  const state = await buildState({ feed: feedWith(WINDOW), at: AT, kwhMilli: 50_000n, mintDecimals: 6 });
  const res = quoteResponse(state, { ...ENDPOINTS, mintDecimals: 6 });
  assert.equal(res.status, 200);
  assert.equal(res.body.mint_decimals, 6);
  assert.equal(typeof res.body.mint_decimals, "number");
});

test("quoteResponse refuses with 503 and no price at all when the feed is down", async () => {
  const state = await buildState({ feed: feedWith(null), at: AT, kwhMilli: 50_000n, mintDecimals: 6 });
  const res = quoteResponse(state, ENDPOINTS);
  assert.equal(res.status, 503);
  const body = JSON.stringify(res.body);
  assert.ok(body.includes("unreachable"));
  assert.ok(!body.includes("amount"), "a down feed must not offer an amount");
  assert.ok(!body.includes("nonce"), "a down feed must not offer a nonce");
  assert.ok(!body.includes("0.00892"), "a down feed must not show a stale price");
});
