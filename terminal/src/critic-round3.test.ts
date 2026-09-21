/** Critic round 3 fixtures for PR 68. Regression cover for the round 3 close:
 * the five no-price outcomes stay distinct on the wire, a no-price screen
 * carries no read time, and the fix did not bring back a cached price on a
 * successful read or a read time that is not the time of a successful read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { EnergySpotFeed } from "../../watcher/src/feed.js";
import type { TerminalConfig } from "./config.js";
import { createTerminalServer } from "./server.js";

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

// The window is built around the wall clock so the real server, which reads
// Date.now(), lands inside it.
const NOW = Date.now();
const START = new Date(NOW - 5 * 60_000).toISOString();
const END = new Date(NOW + 10 * 60_000).toISOString();
const entry = (sek: string, start: string, end: string): string =>
  `{"SEK_per_kWh":${sek},"EUR_per_kWh":1e-05,"EXR":11.17,"time_start":"${start}","time_end":"${end}"}`;
const GOOD = (sek: string): string => `[${entry(sek, START, END)}]`;
const OTHER_HOUR = `[${entry("0.30722", "2000-01-01T00:00:00+02:00", "2000-01-01T00:15:00+02:00")}]`;

const rpcOff = {
  getTokenAccountBalance: async () => {
    throw new Error("rpc off");
  },
  getSignaturesForAddress: async () => {
    throw new Error("rpc off");
  },
} as unknown as Connection;

type Answer = () => Promise<Response>;
const throwing: Answer = async () => {
  throw new TypeError("fetch failed");
};
const answers =
  (status: number, body: string): Answer =>
  async () =>
    new Response(body, { status });

function sequence(list: Answer[]): typeof fetch {
  let i = 0;
  return (async () => {
    const f = list[Math.min(i, list.length - 1)];
    i += 1;
    assert.ok(f !== undefined);
    return f();
  }) as unknown as typeof fetch;
}

type Wire = { feed: string; httpStatus: number | null; generatedAt: string | null; refreshFailed: boolean; sekPerKwh: string | null };

/** One server per call so the 20 s state cache never masks a later fetch. */
async function hit(feed: EnergySpotFeed): Promise<{ html: string; state: Wire; quote: { status: number; body: Record<string, unknown> } }> {
  const server = createTerminalServer({ cfg: CFG, feed, connection: rpcOff });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const addr = server.address();
    assert.ok(addr !== null && typeof addr === "object");
    const base = `http://127.0.0.1:${String(addr.port)}`;
    const html = await (await fetch(`${base}/`)).text();
    const state = (await (await fetch(`${base}/api/state`)).json()) as Wire;
    const q = await fetch(`${base}/api/quote`);
    const body = (await q.json()) as Record<string, unknown>;
    return { html, state, quote: { status: q.status, body } };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const OUTCOMES = [
  { name: "unreachable", answer: throwing, feed: "unreachable", httpStatus: null },
  { name: "not JSON", answer: answers(200, "<html>rate limited</html>"), feed: "malformed", httpStatus: null },
  { name: "JSON of the wrong shape", answer: answers(200, `{"oops":true}`), feed: "malformed", httpStatus: null },
  { name: "HTTP error answer", answer: answers(503, "nope"), feed: "http_error", httpStatus: 503 },
  { name: "good answer, no window for this hour", answer: answers(200, OTHER_HOUR), feed: "missing_window", httpStatus: null },
] as const;

test("the five no-price outcomes are named on the wire and never collapse into one another", async () => {
  const banners = new Map<string, string>();
  for (const o of OUTCOMES) {
    const { html, state, quote } = await hit(new EnergySpotFeed(sequence([o.answer])));
    assert.equal(state.feed, o.feed, o.name);
    assert.equal(state.httpStatus, o.httpStatus, o.name);
    assert.equal(state.generatedAt, null, `${o.name}: nothing was read, so there is no read time`);
    assert.equal(state.sekPerKwh, null, o.name);
    assert.ok(!html.includes("Price last read at"), o.name);
    assert.ok(!html.includes("Spot price"), o.name);
    assert.equal(quote.status, 503, o.name);
    const banner = /<p class="down">([^<]*)<\/p>/.exec(html)?.[1];
    assert.ok(banner !== undefined, `${o.name}: the screen must say what happened`);
    banners.set(o.name, banner);
  }
  // "not JSON" and "wrong shape" are the same class (the body could not be
  // read); every other pair must read differently.
  const distinct = new Set([...banners.entries()].filter(([n]) => n !== "JSON of the wrong shape").map(([, b]) => b));
  assert.equal(distinct.size, 4, JSON.stringify([...banners.entries()], null, 2));
  assert.equal(banners.get("not JSON"), banners.get("JSON of the wrong shape"));
  assert.ok(banners.get("HTTP error answer")?.includes("503"));
});

test("a good read after a good read shows the new price and the new read time, not a cached one", async () => {
  const feed = new EnergySpotFeed(sequence([answers(200, GOOD("0.11111")), answers(200, GOOD("0.22222"))]));
  const first = await hit(feed);
  const second = await hit(feed);
  assert.equal(first.state.sekPerKwh, "0.11111");
  assert.equal(second.state.sekPerKwh, "0.22222");
  assert.equal(second.quote.body.sek_per_kwh, "0.22222");
  assert.equal(second.state.refreshFailed, false);
  assert.ok(first.state.generatedAt !== null && second.state.generatedAt !== null);
  assert.ok(Date.parse(second.state.generatedAt) >= Date.parse(first.state.generatedAt));
  assert.ok(second.html.includes("Price last read at"));
});

test("a failed refresh after a good read keeps the time of the good read and says the refresh failed", async () => {
  const feed = new EnergySpotFeed(sequence([answers(200, GOOD("0.11111")), answers(503, "nope")]));
  const first = await hit(feed);
  const second = await hit(feed);
  assert.equal(second.state.feed, "ok");
  assert.equal(second.state.refreshFailed, true);
  assert.equal(second.state.sekPerKwh, "0.11111");
  assert.equal(second.state.generatedAt, first.state.generatedAt, "the read time is the successful read, not the failed attempt");
  assert.ok(second.html.includes(`last successful read at ${String(first.state.generatedAt)}`));
  assert.ok(!second.html.includes("could not be reached"));
});
