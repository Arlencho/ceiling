import assert from "node:assert/strict";
import test from "node:test";
import type { PriceWindow } from "../../watcher/src/feed.js";
import { ECB_FX_URL, type FxQuote } from "../../watcher/src/fx.js";
import { amountBaseUnitsUsd, parseDecimalToScaled } from "../../watcher/src/money.js";
import { renderPage, type PageView } from "./page.js";
import { quoteForWindow } from "./quote.js";
import { buildState, quoteResponse } from "./state.js";

const WINDOW: PriceWindow = {
  timeStart: "2026-09-21T00:00:00+02:00",
  timeEnd: "2026-09-21T00:15:00+02:00",
  sekPerKwh: "0.00892",
};

const FX: FxQuote = {
  usdRateScaled: parseDecimalToScaled("1.0854", 6),
  sekRateScaled: parseDecimalToScaled("10.8540", 6),
  fixingDate: "2026-09-18",
  sourceUrl: ECB_FX_URL,
};

const PAGE: PageView = {
  generatedAt: "2026-09-21T00:05:00.000Z",
  sourceUrl: "https://www.elprisetjustnu.se/api/v1/prices/2026/09-21_SE3.json",
  feed: "ok",
  windowStart: WINDOW.timeStart,
  windowEnd: WINDOW.timeEnd,
  sekPerKwh: "0.00892",
  kwh: "50",
  amountTokens: "0.0446",
  amountBaseUnits: "44600",
  tokenSymbol: "USDC",
  fxRate: "0.10000000",
  fxDate: "2026-09-18",
  nonce: "1789941600",
  note: null,
  merchantTokenAccount: "MerchantTokenAcct",
  mint: "MintAddr",
  programId: "ProgramAddr",
  explorerQuery: "?cluster=devnet",
  balanceTokens: null,
  payments: [],
  paymentsError: null,
  paymentsAt: null,
};

test("the terminal quote reuses the watcher conversion and shows USDC", async () => {
  const quote = quoteForWindow({
    window: WINDOW,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    at: WINDOW.timeStart,
    fx: FX,
  });
  assert.ok(quote !== null);
  const want = amountBaseUnitsUsd({
    kwhMilli: 50_000n,
    sekPerKwhScaled: parseDecimalToScaled("0.00892", 8),
    usdRateScaled: FX.usdRateScaled,
    sekRateScaled: FX.sekRateScaled,
    mintDecimals: 6,
  });
  assert.equal(quote.amount, want);
  assert.equal(quote.amount, 44_600n);
  assert.equal(quote.tokenSymbol, "USDC");

  const state = await buildState({
    feed: { async getWindow() { return WINDOW; } },
    at: new Date(WINDOW.timeStart),
    kwhMilli: 50_000n,
    mintDecimals: 6,
    quoteCurrency: "USD",
    fx: { async read() { return { ok: true, quote: FX }; } },
  });
  assert.ok(state.quote !== null);
  assert.equal(state.quote.amount, 44_600n);
  const res = quoteResponse(state, {
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    merchantTokenAccount: "MerchantTokenAcct",
    mintDecimals: 6,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.amount, "44600");
  assert.equal(res.body.token_symbol, "USDC");
  assert.equal(res.body.fx_rate, "0.10000000");

  const html = renderPage(PAGE);
  assert.ok(html.includes("0.0446 USDC"));
  assert.ok(html.includes("0.10000000"));
  assert.ok(html.includes("2026-09-18"));
});

test("a terminal with USD off still quotes the SEK amount", async () => {
  const state = await buildState({
    feed: { async getWindow() { return WINDOW; } },
    at: new Date(WINDOW.timeStart),
    kwhMilli: 50_000n,
    mintDecimals: 6,
    fx: {
      async read() {
        throw new Error("fx must not be read");
      },
    },
  });
  assert.ok(state.quote !== null);
  assert.equal(state.quote.amount, 446_000n);
  assert.equal(state.quote.tokenSymbol, "tokens");
});
