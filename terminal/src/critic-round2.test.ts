/** Critic round 2 fixtures for PR 68. The screen must say something true and
 * specific whenever it shows no price, and must never show a price it did not
 * fetch. Each case goes through the real HTTP server so the sentence tested is
 * the one a viewer reads.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { EnergySpotFeed, type PriceFeed } from "../../watcher/src/feed.js";
import { JsonlJournal } from "../../watcher/src/journal.js";
import { processWindow } from "../../watcher/src/run.js";
import { loadTerminalConfig, type TerminalConfig } from "./config.js";
import { renderPage } from "./page.js";
import { createTerminalServer, viewFromState } from "./server.js";
import { buildState, quoteResponse } from "./state.js";

const AT = new Date("2026-09-20T10:05:00+02:00");
const BASE = { kwhMilli: 50_000n, mintDecimals: 6 };

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

function entry(sek: string, start: string, end: string): string {
  return `{"SEK_per_kWh":${sek},"EUR_per_kWh":1e-05,"EXR":11.17,"time_start":"${start}","time_end":"${end}"}`;
}
const OTHER_HOURS_ONLY = `[${entry("0.30722", "2026-09-20T00:00:00+02:00", "2026-09-20T00:15:00+02:00")}]`;
const CURRENT_HOUR_SCI = `[${entry("1e-05", "2026-09-20T10:00:00+02:00", "2026-09-20T10:15:00+02:00")}]`;
// Valid JSON, an array, holds the current hour, but not in the shape the parser reads.
const WRONG_SHAPE_ARRAY = `[{"price_sek":0.30722,"from":"2026-09-20T10:00:00+02:00","to":"2026-09-20T10:15:00+02:00"}]`;

function fetchReturning(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}
function fetchThrowing(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
}

async function screenFor(feed: PriceFeed): Promise<string> {
  const server = createTerminalServer({ cfg: CFG, feed, connection: {} as unknown as Connection });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const addr = server.address();
    assert.ok(addr !== null && typeof addr === "object");
    const res = await fetch(`http://127.0.0.1:${String(addr.port)}/`);
    assert.equal(res.status, 200);
    return await res.text();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// The five screens with no price. Each must carry its own true sentence, no
// price row, no price literal from any body, and must not claim a price was
// read at some time when nothing was read.
for (const c of [
  {
    name: "feed unreachable (fetch throws)",
    fetchImpl: fetchThrowing(),
    says: "could not be reached",
  },
  {
    name: "feed answers 200 with a body that is not JSON",
    fetchImpl: fetchReturning(200, "<html>rate limited</html>"),
    says: "the body could not be read",
  },
  {
    name: "feed answers 200 with JSON of the wrong shape (object)",
    fetchImpl: fetchReturning(200, `{"oops":true}`),
    says: "the body could not be read",
  },
  {
    name: "feed answers 200 with JSON of the wrong shape (array holding this hour under other keys)",
    fetchImpl: fetchReturning(200, WRONG_SHAPE_ARRAY),
    says: "the body could not be read",
  },
  {
    name: "feed answers 200 with no window for the current hour",
    fetchImpl: fetchReturning(200, OTHER_HOURS_ONLY),
    says: "no entry for this hour",
  },
]) {
  test(`screen: ${c.name}`, async () => {
    const html = await screenFor(new EnergySpotFeed(c.fetchImpl));
    assert.ok(html.includes(c.says), `screen must say "${c.says}", got:\n${html}`);
    assert.ok(!html.includes("Spot price"), "no price row may render");
    assert.ok(!html.includes("Quoted amount"), "no amount row may render");
    for (const literal of ["0.30722", "1e-05", "0.00001"]) {
      assert.ok(!html.includes(literal), `price literal ${literal} was never fetched for this hour`);
    }
    if (c.says !== "no entry for this hour") {
      assert.ok(
        !html.includes("no entry for this hour"),
        "a body the parser cannot read is not a day file missing this hour",
      );
    }
    assert.ok(
      !html.includes("Price last read at"),
      "nothing was read, so the screen must not state a time a price was last read",
    );
    assert.ok(html.includes("not a real charge point"));
  });
}

test("screen: feed goes down after one good read keeps the fetched price and says the refresh failed", async () => {
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) return new Response(CURRENT_HOUR_SCI, { status: 200 });
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const feed = new EnergySpotFeed(flaky);
  const first = await buildState({ feed, at: AT, ...BASE });
  const second = await buildState({ feed, at: new Date(AT.getTime() + 60_000), ...BASE });
  assert.equal(calls, 2);
  const html = renderPage(
    viewFromState(second, { fetchedMs: 0, payments: [], balance: null, error: null, okAt: null }, CFG),
  );
  assert.ok(html.includes("later read of the source failed"));
  assert.ok(html.includes(`last successful read at ${first.fetchedAt}`));
  assert.ok(html.includes(">1e-05<"), "the price shown is the source text that was fetched");
  assert.ok(!html.includes("0.00001"), "the expanded form was never on the wire");
  assert.ok(!html.includes("could not be reached"), "the feed was reached once; say what happened");
});

// The feed answered with an HTTP error. It was reached. The screen must not
// say it could not be, and must name the status so a viewer can check it.
for (const status of [404, 429, 503]) {
  test(`screen: feed answers HTTP ${String(status)} names the status instead of claiming it could not be reached`, async () => {
    const html = await screenFor(new EnergySpotFeed(fetchReturning(status, "nope")));
    assert.ok(!html.includes("Spot price"));
    assert.ok(!html.includes("could not be reached"), `HTTP ${String(status)} is an answer, got:\n${html}`);
    assert.ok(html.includes(String(status)), `the status ${String(status)} must be on screen`);
  });
}

test("byte identity: HTML and /api/quote carry the source text 1e-05 while the amount is the expanded bigint", async () => {
  const feed = new EnergySpotFeed(fetchReturning(200, CURRENT_HOUR_SCI));
  const state = await buildState({ feed, at: AT, ...BASE });
  const html = renderPage(
    viewFromState(state, { fetchedMs: 0, payments: [], balance: null, error: null, okAt: null }, CFG),
  );
  assert.ok(html.includes(">1e-05<"));
  assert.ok(!html.includes("0.00001"));
  const res = quoteResponse(state, CFG);
  assert.equal(res.status, 200);
  assert.equal(res.body.sek_per_kwh, "1e-05");
  assert.equal(res.body.amount, "500");
  assert.ok(state.quote !== null && typeof state.quote.amount === "bigint");
});

test("terminal and watcher agree on amount and nonce for the same window", async () => {
  for (const sek of ["0.00892", "1e-05", "1.23456789", "0.30722", "0.00011"]) {
    const window = {
      timeStart: "2026-09-20T10:00:00+02:00",
      timeEnd: "2026-09-20T10:15:00+02:00",
      sekPerKwh: sek,
    };
    const feed: PriceFeed = { getWindow: async () => window };
    const terminal = await buildState({ feed, at: AT, ...BASE });
    assert.ok(terminal.quote !== null, sek);
    let submitted: { amount: bigint; nonce: bigint } | null = null;
    const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-")), "decisions.jsonl"));
    const result = await processWindow({
      at: AT,
      feed,
      journal,
      submit: async (amount, nonce) => {
        submitted = { amount, nonce };
        return { decision: "paid" as const, reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig" };
      },
      ...BASE,
      log: () => {},
      feedAttempts: 1,
      feedRetryMs: 0,
    });
    assert.equal(result, "submitted", sek);
    assert.ok(submitted !== null);
    const s: { amount: bigint; nonce: bigint } = submitted;
    assert.equal(s.amount, terminal.quote.amount, `amount for ${sek}`);
    assert.equal(s.nonce, terminal.quote.nonce, `nonce for ${sek}`);
  }
});

test("disclosure is readable before the first table on the page", () => {
  const html = renderPage({
    generatedAt: "2026-09-20T08:05:00.000Z",
    sourceUrl: "https://example.invalid/day.json",
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
    balanceTokens: null,
    payments: [],
    paymentsError: null,
    paymentsAt: null,
  });
  const disclosure = html.indexOf("not a real charge point");
  const verifiable = html.indexOf("independently verifiable");
  const firstTable = html.indexOf("<table");
  assert.ok(disclosure !== -1 && verifiable !== -1 && firstTable !== -1);
  assert.ok(disclosure < firstTable && verifiable < firstTable);
});

test("no environment: nothing resolves and the failure names the first missing variable", () => {
  const empty = mkdtempSync(join(tmpdir(), "veto-critic-empty-"));
  assert.throws(() => loadTerminalConfig({ VETO_KEYS_DIR: empty }), /missing VETO_RPC\b/);
  assert.throws(
    () => loadTerminalConfig({ VETO_KEYS_DIR: empty, VETO_RPC: "http://rpc.test" }),
    /missing VETO_PROGRAM_ID\b/,
  );
  assert.throws(
    () =>
      loadTerminalConfig({
        VETO_KEYS_DIR: empty,
        VETO_RPC: "http://rpc.test",
        VETO_PROGRAM_ID: "P",
        VETO_MINT: "M",
        VETO_OWNER: "O",
        VETO_OWNER_TOKEN: "OT",
        VETO_MERCHANT: "Me",
      }),
    /missing VETO_MERCHANT_TOKEN\b/,
  );
});
