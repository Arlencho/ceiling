import assert from "node:assert/strict";
import test from "node:test";
import { EnergySpotFeed, type PriceFeed, type PriceWindow } from "../../watcher/src/feed.js";
import { buildState, quoteResponse } from "./state.js";
import { formatBaseUnits } from "./quote.js";

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

// Round 1 critic fixtures for #72 and #74: the amount is integer math from the
// source text for every price shape, and the agent can render it from the
// response alone.

const AT_10_05 = new Date("2026-09-20T10:05:00+02:00");
const W10 = { start: "2026-09-20T10:00:00+02:00", end: "2026-09-20T10:15:00+02:00" };

test("amount is exact bigint math from the source text for every price shape", async () => {
  const rows: Array<{ name: string; body: string; sek: string; amount: string; rendered: string }> = [
    {
      name: "documented order",
      body: `[{"SEK_per_kWh":0.30722,"EUR_per_kWh":0.027,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      sek: "0.30722",
      amount: "15361000",
      rendered: "15.361",
    },
    {
      name: "reordered body",
      body: `[{"time_start":"${W10.start}","time_end":"${W10.end}","SEK_per_kWh":0.30722,"EUR_per_kWh":0.027,"EXR":11.17}]`,
      sek: "0.30722",
      amount: "15361000",
      rendered: "15.361",
    },
    {
      name: "quoted price",
      body: `[{"SEK_per_kWh":"0.30722","time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      sek: "0.30722",
      amount: "15361000",
      rendered: "15.361",
    },
    {
      name: "scientific price, unquoted",
      body: `[{"SEK_per_kWh":1e-05,"EUR_per_kWh":1e-06,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      sek: "1e-05",
      amount: "500",
      rendered: "0.0005",
    },
    {
      name: "integer price",
      body: `[{"SEK_per_kWh":1,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      sek: "1",
      amount: "50000000",
      rendered: "50",
    },
    {
      name: "price with more digits than a double keeps",
      body: `[{"SEK_per_kWh":0.123456789012345678901234,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      sek: "0.123456789012345678901234",
      amount: "6172839",
      rendered: "6.172839",
    },
  ];
  for (const row of rows) {
    const feed = new EnergySpotFeed(async () => new Response(row.body, { status: 200 }));
    const state = await buildState({ feed, at: AT_10_05, kwhMilli: 50_000n, mintDecimals: 6 });
    const res = quoteResponse(state, ENDPOINTS);
    assert.equal(res.status, 200, row.name);
    assert.equal(res.body.sek_per_kwh, row.sek, row.name);
    assert.equal(res.body.amount, row.amount, row.name);
    // The agent has only the body. Render from it and nothing else.
    const body = JSON.parse(JSON.stringify(res.body)) as Record<string, unknown>;
    assert.equal(typeof body.amount, "string", row.name);
    assert.equal(typeof body.mint_decimals, "number", row.name);
    assert.equal(formatBaseUnits(BigInt(body.amount as string), body.mint_decimals as number), row.rendered, row.name);
  }
});

// Round 2 critic fixture for F1, money end to end: the amount for every price
// shape is unchanged when a skipped entry, a nested copy of the key, or a
// string carrying the key sits next to the window. The decoy 0.9 would price
// 50 kWh at 45000000 base units; none of these rows may produce it.

const PREV_START = "2026-09-20T09:45:00+02:00";
const DECOYS: Array<{ name: string; entry: string }> = [
  { name: "skipped neighbour with a numeric price", entry: `{"SEK_per_kWh":0.9,"time_start":"${PREV_START}"}` },
  { name: "skipped neighbour claiming the same slot", entry: `{"SEK_per_kWh":null,"time_start":"${W10.start}","time_end":"${W10.end}"}` },
  { name: "neighbour with the key nested only", entry: `{"meta":{"SEK_per_kWh":0.9},"time_start":"${PREV_START}","time_end":"${W10.start}"}` },
  { name: "neighbour with the key inside a string", entry: `{"note":"\\"SEK_per_kWh\\":0.9","time_start":"${PREV_START}","time_end":"${W10.start}"}` },
];

test("round 2: the amount is unchanged for every price shape next to a decoy entry", async () => {
  const shapes: Array<{ name: string; own: string; sek: string; amount: string }> = [
    { name: "documented order", own: `{"SEK_per_kWh":0.30722,"EUR_per_kWh":0.027,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"}`, sek: "0.30722", amount: "15361000" },
    { name: "reordered body", own: `{"time_start":"${W10.start}","time_end":"${W10.end}","SEK_per_kWh":0.30722,"EUR_per_kWh":0.027,"EXR":11.17}`, sek: "0.30722", amount: "15361000" },
    { name: "quoted price", own: `{"SEK_per_kWh":"0.30722","time_start":"${W10.start}","time_end":"${W10.end}"}`, sek: "0.30722", amount: "15361000" },
    { name: "scientific price, unquoted", own: `{"SEK_per_kWh":1e-05,"EUR_per_kWh":1e-06,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"}`, sek: "1e-05", amount: "500" },
    { name: "integer price", own: `{"SEK_per_kWh":1,"time_start":"${W10.start}","time_end":"${W10.end}"}`, sek: "1", amount: "50000000" },
    { name: "price with more digits than a double keeps", own: `{"SEK_per_kWh":0.123456789012345678901234,"time_start":"${W10.start}","time_end":"${W10.end}"}`, sek: "0.123456789012345678901234", amount: "6172839" },
    { name: "own entry carrying the key nested and in a string too", own: `{"meta":{"SEK_per_kWh":0.9},"note":"\\"SEK_per_kWh\\":0.9","SEK_per_kWh":0.30722,"time_start":"${W10.start}","time_end":"${W10.end}"}`, sek: "0.30722", amount: "15361000" },
  ];
  for (const decoy of DECOYS) {
    for (const shape of shapes) {
      for (const order of ["decoy first", "decoy last"]) {
        const body = order === "decoy first" ? `[${decoy.entry},${shape.own}]` : `[${shape.own},${decoy.entry}]`;
        const label = `${decoy.name} / ${shape.name} / ${order}`;
        const feed = new EnergySpotFeed(async () => new Response(body, { status: 200 }));
        const state = await buildState({ feed, at: AT_10_05, kwhMilli: 50_000n, mintDecimals: 6 });
        const res = quoteResponse(state, ENDPOINTS);
        assert.equal(res.status, 200, label);
        assert.equal(res.body.sek_per_kwh, shape.sek, label);
        assert.equal(res.body.amount, shape.amount, label);
        assert.notEqual(res.body.amount, "45000000", label);
      }
    }
  }
});
