/** Critic round 2 fixture for PR 122. The terminal must not quote a nonce that
 * the watcher pays for a different window at a different amount. The feed is
 * the untrusted input #118 covers: a window that starts three seconds before
 * the slot still contains the slot. The watcher never pays that window, so a
 * quote for it must not name the nonce of the slot the watcher does pay.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { windowContaining, type PriceFeed, type PriceWindow } from "../../watcher/src/feed.js";
import { JsonlJournal } from "../../watcher/src/journal.js";
import { processWindow } from "../../watcher/src/run.js";
import { buildState } from "./state.js";

const BASE = { kwhMilli: 50_000n, mintDecimals: 6 };
const SLOT = new Date("2026-09-22T15:45:00Z");
const LATER = new Date("2026-09-22T16:00:00Z");

const honest: PriceWindow = {
  timeStart: "2026-09-22T15:45:00Z",
  timeEnd: "2026-09-22T16:00:00Z",
  sekPerKwh: "1.00000",
};
const shifted: PriceWindow = {
  timeStart: "2026-09-22T15:59:57Z",
  timeEnd: "2026-09-22T16:14:57Z",
  sekPerKwh: "2.00000",
};
const feed: PriceFeed = {
  async getWindow(at) {
    return windowContaining([honest, shifted], at);
  },
};

test("critic r2 PR 122: a quote for a window that starts off the slot does not carry the nonce the watcher pays for another window", async () => {
  const terminal = await buildState({ feed, at: LATER, ...BASE });
  assert.ok(terminal.quote !== null);
  assert.equal(terminal.quote.windowStart, shifted.timeStart);

  let submitted: { amount: bigint; nonce: bigint } | null = null;
  const journal = new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-critic-")), "decisions.jsonl"));
  const result = await processWindow({
    at: SLOT,
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
  assert.equal(result, "submitted");
  assert.ok(submitted !== null);
  const chain: { amount: bigint; nonce: bigint } = submitted;
  assert.equal(chain.nonce, 1790091900n, "the watcher paid the 15:45 slot under its own nonce");

  if (terminal.quote.nonce === chain.nonce) {
    assert.equal(
      terminal.quote.amount,
      chain.amount,
      `nonce ${chain.nonce.toString()} is quoted at ${terminal.quote.amount.toString()} for window ${terminal.quote.windowStart} but the chain paid ${chain.amount.toString()} for window ${honest.timeStart}`,
    );
  }
});
