import assert from "node:assert/strict";
import test from "node:test";
import { renderPage, type PageView } from "./page.js";

const BASE: PageView = {
  generatedAt: "2026-09-20T00:05:00.000Z",
  sourceUrl: "https://www.elprisetjustnu.se/api/v1/prices/2026/09-20_SE3.json",
  feed: "ok",
  windowStart: "2026-09-20T00:00:00+02:00",
  windowEnd: "2026-09-20T00:15:00+02:00",
  sekPerKwh: "0.00892",
  kwh: "50",
  amountTokens: "0.446",
  amountBaseUnits: "446000",
  nonce: "1789...",
  note: null,
  merchantTokenAccount: "MerchantTokenAcct",
  mint: "MintAddr",
  programId: "ProgramAddr",
  explorerQuery: "?cluster=devnet",
  balanceTokens: "0.446",
  payments: [
    { time: "2026-09-20T00:01:00.000Z", amountTokens: "0.446", signature: "Sig123" },
  ],
  paymentsError: null,
  paymentsAt: "2026-09-20T00:04:00.000Z",
};

test("the page shows the window, the real price, the quote, the nonce and the source URL", () => {
  const html = renderPage(BASE);
  assert.ok(html.includes("2026-09-20T00:00:00+02:00"));
  assert.ok(html.includes("0.00892"));
  assert.ok(html.includes("0.446"));
  assert.ok(html.includes("446000"));
  assert.ok(html.includes("1789..."));
  assert.ok(html.includes(BASE.sourceUrl));
  assert.ok(html.includes("MerchantTokenAcct"));
  assert.ok(html.includes("Sig123"));
});

test("the page states the honesty boundary in plain language", () => {
  const html = renderPage(BASE);
  assert.ok(html.includes("independently verifiable"));
  assert.ok(html.includes("not a real charge point"));
  assert.ok(!html.includes("—"), "no em dash anywhere on the page");
});

test("a down feed renders the outage and no price at all", () => {
  const html = renderPage({
    ...BASE,
    feed: "unreachable",
    windowStart: null,
    windowEnd: null,
    sekPerKwh: null,
    amountTokens: null,
    amountBaseUnits: null,
    nonce: null,
    note: "The price feed could not be reached, so there is no price and no quote.",
  });
  assert.ok(html.includes("could not be reached"));
  assert.ok(!html.includes("0.00892"), "no stale price may be rendered");
  assert.ok(html.includes(BASE.sourceUrl), "the source URL stays visible for verification");
  assert.ok(html.includes("not a real charge point"));
});

test("an RPC payment error is shown instead of pretending the list is current", () => {
  const html = renderPage({ ...BASE, paymentsError: "RPC unreachable: connection refused" });
  assert.ok(html.includes("RPC unreachable"));
});

test("payment rows link to the explorer with the configured cluster query", () => {
  const html = renderPage(BASE);
  assert.ok(
    html.includes(`https://explorer.solana.com/tx/Sig123?cluster=devnet`),
  );
});
