/** Critic fixtures for PR 68. Each case names the honesty path it exercises. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { EnergySpotFeed, type PriceFeed } from "../../watcher/src/feed.js";
import { renderPage, type PageView } from "./page.js";
import { createTerminalServer } from "./server.js";
import { buildState, quoteResponse } from "./state.js";
import type { TerminalConfig } from "./config.js";

const AT = new Date("2026-09-20T10:05:00+02:00");
const BASE = { kwhMilli: 50_000n, mintDecimals: 6 };

function entry(sek: string, start: string, end: string): string {
  return `{"SEK_per_kWh":${sek},"EUR_per_kWh":1e-05,"EXR":11.17,"time_start":"${start}","time_end":"${end}"}`;
}
const OTHER_HOURS_ONLY = `[${entry("0.30722", "2026-09-20T00:00:00+02:00", "2026-09-20T00:15:00+02:00")},${entry(
  "0.31000",
  "2026-09-20T00:15:00+02:00",
  "2026-09-20T00:30:00+02:00",
)}]`;
const CURRENT_HOUR_SCI = `[${entry("1e-05", "2026-09-20T10:00:00+02:00", "2026-09-20T10:15:00+02:00")}]`;

function fetchReturning(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const CFG: TerminalConfig = {
  rpc: "http://rpc.invalid",
  programId: "Prog",
  mint: "Mint",
  merchant: "Merchant",
  merchantTokenAccount: "MerchantTokenAcct",
  kwhMilli: 50_000n,
  mintDecimals: 6,
  port: 0,
  explorerQuery: "",
};

// Path 1 and 2: the feed answered, but not with a usable price for now.
// The screen must say what happened, not claim the feed was unreachable.
for (const c of [
  { name: "current hour missing from the day file", body: OTHER_HOURS_ONLY },
  { name: "malformed body (valid JSON, wrong shape)", body: `{"oops":true}` },
  { name: "malformed body (not JSON)", body: `<html>rate limited</html>` },
]) {
  test(`reachable feed, ${c.name}: state does not claim the feed was unreachable`, async () => {
    const feed = new EnergySpotFeed(fetchReturning(200, c.body));
    const state = await buildState({ feed, at: AT, ...BASE });
    assert.equal(state.quote, null);
    assert.equal(state.window, null);
    assert.ok(state.note !== null);
    assert.ok(
      !state.note.includes("could not be reached"),
      `feed returned HTTP 200, note says: ${state.note}`,
    );
    assert.notEqual(state.feed, "unreachable", "an HTTP 200 is not an unreachable feed");
  });
}

// Path 2b: a matched entry whose price text is unparseable must produce a
// state (no price, says why), not an exception that becomes a plain-text 500.
test("unparseable price in a matched entry: buildState resolves to a no-quote state", async () => {
  const feed: PriceFeed = {
    getWindow: async () => ({
      timeStart: "2026-09-20T10:00:00+02:00",
      timeEnd: "2026-09-20T10:15:00+02:00",
      sekPerKwh: "1.2.3",
    }),
  };
  const state = await buildState({ feed, at: AT, ...BASE });
  assert.equal(state.quote, null);
  assert.ok(state.note !== null && !state.note.includes("could not be reached"));
});

test("unparseable price: GET /api/quote answers 503 JSON, not 500 text", async () => {
  const feed: PriceFeed = {
    getWindow: async () => ({
      timeStart: "2026-09-20T10:00:00+02:00",
      timeEnd: "2026-09-20T10:15:00+02:00",
      sekPerKwh: "1.2.3",
    }),
  };
  const server = createTerminalServer({ cfg: CFG, feed, connection: {} as unknown as Connection });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const addr = server.address();
    assert.ok(addr !== null && typeof addr === "object");
    const res = await fetch(`http://127.0.0.1:${String(addr.port)}/api/quote`);
    assert.equal(res.status, 503);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.amount, undefined);
    assert.equal(body.nonce, undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// Path 3: the day file is cached (a day of prices is fixed) but a failed
// refresh must be visible and must not stamp a fresh fetch time on the
// cached price. The plan kept the cache; it forbade the lie about when
// the body was last read.
test("feed goes down after one good read: cached price keeps the first read time and the failed refresh is visible", async () => {
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) return new Response(CURRENT_HOUR_SCI, { status: 200 });
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const feed = new EnergySpotFeed(flaky);
  const first = await buildState({ feed, at: AT, ...BASE });
  assert.equal(first.feed, "ok");
  const later = new Date(AT.getTime() + 60_000);
  const second = await buildState({ feed, at: later, ...BASE });
  assert.equal(calls, 2, "second build must hit the network");
  assert.equal(second.feed, "ok", "a day of prices is fixed, so the cached body remains usable");
  assert.ok(second.quote !== null);
  assert.equal(second.fetchedAt, first.fetchedAt, "do not stamp a fresh fetch time on a failed refresh");
  assert.equal(second.refreshFailed, true);
  assert.ok(second.note !== null && second.note.includes("later read of the source failed"));
});

// Byte identity and bigint path for a scientific-notation window.
test("scientific-notation price: amount is exact bigint arithmetic", async () => {
  const feed = new EnergySpotFeed(fetchReturning(200, CURRENT_HOUR_SCI));
  const state = await buildState({ feed, at: AT, ...BASE });
  assert.ok(state.quote !== null);
  // 50 kWh * 0.00001 SEK/kWh = 0.0005 tokens = 500 base units at 6 decimals.
  assert.equal(state.quote.amount, 500n);
  assert.equal(typeof state.quote.amount, "bigint");
  const res = quoteResponse(state, CFG);
  assert.equal(res.status, 200);
  assert.equal(res.body.amount, "500");
});

test("scientific-notation price: the price shown is byte-identical to the source text", async () => {
  const feed = new EnergySpotFeed(fetchReturning(200, CURRENT_HOUR_SCI));
  const state = await buildState({ feed, at: AT, ...BASE });
  assert.ok(state.window !== null);
  assert.equal(state.window.sekPerKwh, "1e-05", "viewer must be able to match the number at the source URL");
});

// Disclosure placement: the full sentence must come before the payments table,
// which can be up to 10 rows long and pushes the boundary block below the fold.
test("disclosure sentence appears before the payments section", () => {
  const view: PageView = {
    generatedAt: "2026-09-20T08:05:00.000Z",
    sourceUrl: "https://www.elprisetjustnu.se/api/v1/prices/2026/09-20_SE3.json",
    feed: "ok",
    windowStart: "2026-09-20T10:00:00+02:00",
    windowEnd: "2026-09-20T10:15:00+02:00",
    sekPerKwh: "0.30722",
    kwh: "50",
    amountTokens: "15.361",
    amountBaseUnits: "15361000",
    nonce: "1789978500",
    note: null,
    merchantTokenAccount: "MerchantTokenAcct",
    mint: "Mint",
    programId: "Prog",
    explorerQuery: "",
    balanceTokens: "0.666",
    payments: Array.from({ length: 10 }, (_, i) => ({ time: "t", amountTokens: "1", signature: `Sig${String(i)}` })),
    paymentsError: null,
    paymentsAt: "2026-09-20T08:04:00.000Z",
  };
  const html = renderPage(view);
  const disclosure = html.indexOf("not a real charge point");
  const payments = html.indexOf("Received payments");
  assert.ok(disclosure !== -1 && payments !== -1);
  assert.ok(disclosure < payments, `disclosure at ${String(disclosure)}, payments heading at ${String(payments)}`);
});
