# Veto merchant terminal

The counterparty screen for the demo. It fetches the real Nordic day-ahead
electricity spot price for the current SE3 window, quotes a charge for a fixed
kWh volume at that price, exposes the amount and a monotonic nonce to the
agent over HTTP, and shows the payments arriving at its token account. That
account is the merchant named in the on-chain mandate, so the payment you see
arriving on this screen is the same payment the mandate ledger records.

The price is real, public, and independently verifiable against the same URL
the terminal fetches, and the screen says so. This terminal is a demo
counterparty we run, because no charge point operator accepts this mint. It is
not a real charge point, and the screen says that too. If the feed cannot be
reached the screen says that and shows no price at all, never a stored or
invented one.

Feed parsing, integer money arithmetic, and the window-start nonce are
imported from `watcher/src` (`feed.ts`, `money.ts`, `nonce.ts`). There is no
second copy, and no float anywhere near an amount.

## Setup

From the repo root. Node 22 or newer.

```bash
cd terminal
npm ci
npm test
npm run typecheck
```

Config comes from the same sources as the watcher and indexer: the
environment, `keys/devnet-addresses.env`, or `terminal/.env` (see
`.env.example`). RPC, program id, mint, and the merchant token account are
read from config, never hardcoded. For the recorded devnet cluster:

```bash
export VETO_RPC=https://api.devnet.solana.com
```

## How to run it for the video

One terminal, from `terminal/`:

```bash
npm start
```

Open `http://127.0.0.1:8788`. The page reloads itself every 5 seconds and
shows, top to bottom:

1. The current 15-minute window, the real SEK/kWh price it just fetched, the
   quoted amount for 50 kWh in tokens and base units, and the nonce.
2. The source URL as a link. Open it in a second tab on camera and match the
   number. That is the verification moment.
3. The merchant token account with its live balance and the payments received
   so far, each with an explorer link. When the watcher's `charge` settles,
   the row appears here on the next reload.
4. The honesty block: the price is public and verifiable at the source, and
   this terminal is a demo counterparty, not a real charge point.

Point the feed down (for example, no network) and the page says the feed
could not be reached and shows no price. Point it back and the real price
returns. Nothing is cached across that boundary.

The agent does not scrape the page. It reads JSON:

```bash
curl http://127.0.0.1:8788/api/quote
```

```json
{
  "amount": "446000",
  "nonce": "1789855200",
  "window_start": "2026-09-20T00:00:00+02:00",
  "window_end": "2026-09-20T00:15:00+02:00",
  "sek_per_kwh": "0.00892",
  "kwh_milli": "50000",
  "mint": "...",
  "merchant_token_account": "...",
  "source": "https://www.elprisetjustnu.se/api/v1/prices/2026/09-20_SE3.json"
}
```

`amount` and `nonce` are decimal strings of integers (mint base units and the
unix seconds of the window start). When the feed is down the endpoint answers
503 with an error and no amount, no nonce, no price. `npm run quote` prints
the same JSON once and exits nonzero when there is no quote, which is handy
for scripting the agent side.

`GET /api/state` returns the exact view model the page renders, as JSON.

## Tests

```bash
npm test
```

Covered: quoting an amount from a price and a volume as integer base units
(including the 50 kWh at 0.00892 SEK/kWh window the watcher journal recorded
as 446000 base units), nonce monotonicity across windows and stability across
restarts, and the feed-down path: no price, no quote, 503, and the page shows
the outage instead of a number.
