/** Critic round 3 fixture for PR 122. The terminal and the watcher must name
 * the same nonce, or both name none. A feed window that starts off the slot
 * gets no nonce from either side; an honest window quoted five minutes into
 * the slot gets the slot from both sides.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { windowContaining, type PriceFeed, type PriceWindow } from "../../watcher/src/feed.js";
import { JsonlJournal } from "../../watcher/src/journal.js";
import { processWindow } from "../../watcher/src/run.js";
import type { TerminalConfig } from "./config.js";
import { renderPage } from "./page.js";
import { viewFromState } from "./server.js";
import { buildState, quoteResponse } from "./state.js";

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
const ENDPOINTS = { mint: "Mint", mintDecimals: 6, merchantTokenAccount: "MerchantTokenAcct" };
const SNAP = { fetchedMs: 0, payments: [], balance: null, error: null, okAt: null };

const honest1545: PriceWindow = { timeStart: "2026-09-22T15:45:00Z", timeEnd: "2026-09-22T16:00:00Z", sekPerKwh: "1.00000" };
const shifted: PriceWindow = { timeStart: "2026-09-22T15:59:57Z", timeEnd: "2026-09-22T16:14:57Z", sekPerKwh: "2.00000" };
const honest1600: PriceWindow = { timeStart: "2026-09-22T16:00:00Z", timeEnd: "2026-09-22T16:15:00Z", sekPerKwh: "2.00000" };

function feedOf(windows: PriceWindow[]): PriceFeed {
  return { async getWindow(at) { return windowContaining(windows, at); } };
}

async function watcherAt(feed: PriceFeed, at: Date) {
  const sent: { amount: bigint; nonce: bigint }[] = [];
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-r3-")), "decisions.jsonl"));
  const result = await processWindow({
    at,
    feed,
    journal,
    submit: async (amount, nonce) => {
      sent.push({ amount, nonce });
      return { decision: "paid" as const, reason: "ok", reasonCode: 0, suggestedOverride: null, signature: "sig" };
    },
    ...BASE,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  });
  return { result, sent };
}

test("critic r3 PR 122: a window that starts off the slot carries no nonce on the terminal and no send from the watcher", async () => {
  const feed = feedOf([honest1545, shifted]);
  const at = new Date("2026-09-22T16:00:00Z");

  const terminal = await buildState({ feed, at, ...BASE });
  assert.ok(terminal.quote !== null);
  assert.equal(terminal.quote.windowStart, shifted.timeStart);
  assert.equal(terminal.quote.nonce, null);
  assert.equal(quoteResponse(terminal, ENDPOINTS).body.nonce, null);
  const view = viewFromState(terminal, SNAP, CFG);
  assert.equal(view.nonce, null);
  assert.match(renderPage(view), /none for this window/);

  const watcher = await watcherAt(feed, at);
  assert.equal(watcher.result, "gap");
  assert.deepEqual(watcher.sent, []);
});

test("critic r3 PR 122: an honest window quoted five minutes into the slot names the slot on both sides", async () => {
  const feed = feedOf([honest1600]);
  const at = new Date("2026-09-22T16:05:00Z");

  const terminal = await buildState({ feed, at, ...BASE });
  assert.ok(terminal.quote !== null && terminal.quote.nonce !== null);
  assert.equal(terminal.quote.nonce, 1790092800n);
  assert.equal(quoteResponse(terminal, ENDPOINTS).body.nonce, "1790092800");

  const watcher = await watcherAt(feed, at);
  assert.equal(watcher.result, "submitted");
  assert.equal(watcher.sent.length, 1);
  assert.equal(watcher.sent[0]?.nonce, terminal.quote.nonce);
  assert.equal(watcher.sent[0]?.amount, terminal.quote.amount);
  assert.equal(terminal.quote.amount, 100_000_000n);
});
