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
environment, `keys/devnet-addresses.env`, `watcher/.env`, and `terminal/.env`
(see `.env.example`). File keys may be `VETO_RPC=` or `RPC=`. Both packages
read both package env files, so a volume set in one place is the volume both
use; two different values is an error at load, not a silent disagreement.
RPC, program id, mint, and the merchant token account are required from those
sources. There is no hardcoded fallback. For the recorded devnet cluster:

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

1. The honesty block: the price is public and verifiable at the source, and
   this terminal is a demo counterparty, not a real charge point.
2. The current 15-minute window, the real SEK/kWh price last read from the
   source, the quoted amount for 50 kWh in tokens and base units, and the
   nonce.
3. The source URL as a link, and the time of the last successful read. Open
   the URL in a second tab on camera and match the number. That is the
   verification moment.
4. The merchant token account with its live balance and the payments received
   so far, each with an explorer link. When the watcher's `charge` settles,
   the row appears here on the next reload.

The day file is cached, because that day's prices are fixed. A later failed
read does not invent a new fetch time for the cached price: the page keeps
the last successful read time and says the refresh failed. A first read that
never succeeds says the feed could not be reached and shows no price. A 200
body with no current hour, or a body that cannot be read, says that rather
than claiming the feed was unreachable.

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

`amount` is a decimal string of an integer (mint base units). `nonce` is a
decimal string or null. The decimal string is the unix seconds of the window
start, and it is present only when that window starts on the cadence slot.
When the window is chargeable but does not start on the slot, `GET /api/quote`
answers 200 with `"nonce": null`. Null means the watcher will not pay that
window, so there is nothing to pay under it. When the feed is down the
endpoint answers 503 with an error and no amount, no nonce, no price.
`npm run quote` prints the same JSON once and exits nonzero when there is no
quote, which is handy for scripting the agent side.

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
