/** The screen. One self-contained HTML page, reloaded by meta refresh.
 *
 * The page always carries the honesty boundary in plain language: the price
 * is public and can be checked at the source URL while watching, and this
 * terminal is a demo counterparty, not a real charge point. When the feed is
 * down the price rows are not rendered at all, so nothing stale can show.
 */

import type { FeedStatus } from "../../watcher/src/feed.js";

export type PagePayment = {
  time: string;
  amountTokens: string;
  signature: string;
};

export type PageView = {
  generatedAt: string;
  sourceUrl: string;
  feed: FeedStatus;
  windowStart: string | null;
  windowEnd: string | null;
  sekPerKwh: string | null;
  kwh: string;
  amountTokens: string | null;
  amountBaseUnits: string | null;
  nonce: string | null;
  note: string | null;
  merchantTokenAccount: string;
  mint: string;
  programId: string;
  explorerQuery: string;
  balanceTokens: string | null;
  payments: PagePayment[];
  paymentsError: string | null;
  paymentsAt: string | null;
  refreshFailed?: boolean;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function row(label: string, value: string): string {
  return `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
}

function feedBanner(view: PageView): string {
  if (view.feed === "unreachable") {
    return `<p class="down">The price feed could not be reached. No price is shown and no quote is offered. This terminal never falls back to a stored or invented price.</p>`;
  }
  if (view.feed === "malformed") {
    return `<p class="down">The price feed answered, but the body could not be read. No price is shown and no quote is offered.</p>`;
  }
  if (view.feed === "missing_window") {
    return `<p class="down">The price feed has no entry for this hour. No price is shown and no quote is offered.</p>`;
  }
  return "";
}

export function renderPage(view: PageView): string {
  const priceRows =
    view.feed === "ok" && view.windowStart !== null && view.sekPerKwh !== null
      ? [
          row("Window start", esc(view.windowStart)),
          row("Window end", esc(view.windowEnd ?? "")),
          row("Spot price (SEK/kWh)", esc(view.sekPerKwh)),
          row("Volume", `${esc(view.kwh)} kWh`),
          row(
            "Quoted amount",
            view.amountTokens === null || view.amountBaseUnits === null
              ? esc("none for this window")
              : `${esc(view.amountTokens)} tokens (${esc(view.amountBaseUnits)} base units)`,
          ),
          row("Nonce", esc(view.nonce ?? "none for this window")),
        ].join("\n")
      : "";

  const noteLine = view.note !== null ? `<p class="note">${esc(view.note)}</p>` : "";

  const paymentsSection = (() => {
    if (view.paymentsError !== null) {
      return `<p class="down">${esc(view.paymentsError)}. The list below is from the last successful read${
        view.paymentsAt === null ? "" : ` at ${esc(view.paymentsAt)}`
      }.</p>`;
    }
    if (view.payments.length === 0) {
      return "<p>No payments received yet.</p>";
    }
    const rows = view.payments
      .map(
        (p) =>
          `<tr><td>${esc(p.time)}</td><td>${esc(p.amountTokens)}</td><td><a href="https://explorer.solana.com/tx/${esc(
            p.signature,
          )}${esc(view.explorerQuery)}">${esc(p.signature)}</a></td></tr>`,
      )
      .join("\n");
    return `<table class="payments">
<thead><tr><th>Time</th><th>Amount (tokens)</th><th>Transaction</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  })();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Merchant terminal (demo)</title>
<style>
body { background: #0f1a16; color: #e8efe9; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 52rem; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.05rem; margin-top: 2rem; }
a { color: #7fd4a8; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.3rem 0.6rem 0.3rem 0; vertical-align: top; }
thead th { border-bottom: 1px solid #3a4f45; }
tbody td { border-bottom: 1px solid #223029; word-break: break-all; }
th { color: #9fb3a7; font-weight: normal; white-space: nowrap; }
.down { color: #f0b429; }
.note { color: #9fb3a7; }
.boundary { border: 1px solid #3a4f45; padding: 0.8rem 1rem; margin: 1rem 0 1.5rem; }
.muted { color: #9fb3a7; }
</style>
</head>
<body>
<h1>Merchant terminal <span class="muted">(demo counterparty)</span></h1>

<div class="boundary">
<p>The price shown here is real, public, and independently verifiable. It is the Nordic day-ahead
spot price for the SE3 area, fetched from the source URL below. Open the same URL in another tab
and check the number while you watch.</p>
<p>This terminal is a demo counterparty run for the veto project. It is not a real charge point,
and no charge point operator accepts this token. Payments arrive at the token account below, which
is the merchant named in the on-chain mandate, so the payment you see arriving here is the same
payment the mandate ledger records.</p>
</div>

${feedBanner(view)}
${noteLine}

<h2>Current quote</h2>
<table>
${priceRows}
${row("Price source", `<a href="${esc(view.sourceUrl)}">${esc(view.sourceUrl)}</a>`)}
${row("Price last read at", esc(view.generatedAt))}
</table>

<h2>Received payments</h2>
<table>
${row("Merchant token account", `<a href="https://explorer.solana.com/address/${esc(view.merchantTokenAccount)}${esc(view.explorerQuery)}">${esc(view.merchantTokenAccount)}</a>`)}
${row("Balance", view.balanceTokens === null ? esc("unknown") : `${esc(view.balanceTokens)} tokens`)}
</table>
${paymentsSection}

<p class="muted">Program ${esc(view.programId)} &middot; mint ${esc(view.mint)} &middot; the agent reads
GET /api/quote on this server &middot; page reloads every 5 seconds</p>

</body>
</html>
`;
}
