# Veto watcher

Unattended agent. It reads the live Nordic day-ahead electricity spot, converts a
fixed kWh volume into token base units as integers, and submits `charge` with the
agent key. The program decides. A refusal is a confirmed transaction with a reason,
not an error.

The price is real, public, and independently verifiable against the same URL. The
counterparty is a terminal we run, because no charge point operator accepts this
mint. Refusals happen because the spot crossed the ceiling, not because anyone
pressed a button.

## What it does

Four times per Stockholm day (00:00, 06:00, 12:00, 18:00) the process:

1. Reads `https://www.elprisetjustnu.se/api/v1/prices/YYYY/MM-DD_SE3.json` for the
   15-minute window that starts on that hour.
2. Converts a fixed 50 kWh volume to mint base units with integer arithmetic only.
   1 token is treated as 1 SEK. The test mint has 6 decimals (see `docs/DEVNET.md`).
3. Derives the on-chain nonce from the unix seconds of the window start, so a
   restart cannot double-charge a settled window.
4. Submits `charge`, signed by `keys/agent.json`.
5. Appends one JSONL row (signature, amount, decision, reason) and prints a
   one-line summary.

A down feed is a gap: the row is recorded, nothing is submitted, no synthetic
price is invented. An RPC failure backs off and retries the same window. The
thread is not dropped. A rate limit is not a failure: the process logs that it
was throttled, tries the next configured endpoint (and re-walks a single
endpoint with bounded doubling), and leaves the cadence slot due so the next
cycle can still submit it. The outage is written as a gap with a reason that
names the rate limit, so it stays visible after midnight and `status` can
count it. A gap is not terminal.

The `PriceFeed` interface exists because the feed may be revisited
(`docs/internal/DECISIONS.md`, 2026-09-20). The only implementation is `EnergySpotFeed`.

## Setup

From the repo root. Node 22 or newer. Keypairs live under gitignored `keys/` as
listed in `docs/DEVNET.md`. The typed client is generated from the Anchor IDL
at `watcher/idl/veto.json` (copied from `target/idl/veto.json` when present).

```bash
cd watcher
npm ci
npm test
npm run build
```

Open a mandate once (owner signature, rent paid by the owner key):

```bash
npm run open-mandate
```

RPC, program id, mint, and the owner / merchant / agent accounts come from
the environment, `keys/devnet-addresses.env`, `watcher/.env`, or
`terminal/.env`. There is no hardcoded fallback for those. File keys may be
`VETO_RPC=` or `RPC=`. Both packages read both package env files, so they
cannot silently disagree about the quoted volume. Copy `.env.example` to
`watcher/.env` and uncomment the identity lines with values you supply. The
placeholders do not resolve.

Process defaults that cannot select a chain identity (overridable with env):

| | |
|---|---|
| RPC | `VETO_RPC`, required. One URL, or several separated by commas, tried in order. |
| Volume | 50 kWh (`VETO_KWH_MILLI=50000`) |
| Cap | 100 tokens |
| Per-payment max | 0.5 tokens |
| Mandate id | 1 |
| Purpose | `SE3 home charging` |

0.5 tokens per 50 kWh is 0.01 SEK/kWh. On 2026-09-20 that pays the cheapest night
and midday dips and refuses the evening spike. Raise `VETO_PER_TX_MAX` before
opening if you want a looser ceiling. Opening is a chain instruction; changing
the env later does not rewrite an existing mandate.

## Pointing at a dedicated RPC

The public cluster URL is shared and will 429 under load. `VETO_RPC` is a list,
read from the environment (or `watcher/.env`, or `keys/devnet-addresses.env`
`RPC=`). Put a dedicated JSON-RPC URL first and keep the public cluster URL
from `docs/DEVNET.md` after it as fallback. No code change is required.

```bash
VETO_RPC=<dedicated>,<public> npm start
```

On HTTP 429 the watcher backs off, tries the next URL, and logs `rpc rate limited`
rather than `rpc failure`. Those need different responses from a person. A slot
that only saw a rate limit stays due and is tried again; it is not written off
as a gap.

## How to run it

One pass over due slots (useful after a restart):

```bash
npm run once
```

A specific elapsed 15-minute window (must not be in the future):

```bash
node dist/index.js once --window 2026-09-20T01:30:00+02:00
```

Stay up:

```bash
npm start
```

That is `node dist/index.js run`. It processes any of today's due slots that are
not already in the journal, then sleeps until the next cadence tick. SIGINT and
SIGTERM finish the current slot and exit.

## How to keep it running

A week of history needs the process to outlive a laptop lid. Pick one.

tmux, on the machine that can reach the RPC:

```bash
tmux new -s veto-watcher 'cd /path/to/veto/watcher && npm start'
```

Detach with `Ctrl-b d`. Reattach with `tmux attach -t veto-watcher`. A restart
of the box still needs something that launches tmux again.

launchd, user agent, macOS. Save as
`~/Library/LaunchAgents/se.veto.watcher.plist` after editing the paths, then
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>se.veto.watcher</string>
  <key>WorkingDirectory</key><string>/path/to/veto/watcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>dist/index.js</string>
    <string>run</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/veto-watcher.log</string>
  <key>StandardErrorPath</key><string>/tmp/veto-watcher.err</string>
</dict>
</plist>
```

Cloud Run, if the laptop cannot stay up: [CLOUD.md](CLOUD.md). That path
persists the journal in Cloud Storage and runs `once` on the cadence.

If the window of recorded days breaks, say the true number in the pitch. Do not
round up to seven.

## How to read the JSONL

Rows land in `watcher/data/decisions.jsonl` (override with `VETO_JOURNAL`). One
JSON object per line, snake_case keys. `data/` is gitignored.

```bash
npm run status
```

```bash
# counts
jq -r .decision data/decisions.jsonl | sort | uniq -c

# the diary
jq -r '[.ts, .decision, .reason, .amount, .window_start, .signature] | @tsv' data/decisions.jsonl

# one row
jq . data/decisions.jsonl | less
```

| Field | |
|---|---|
| `decision` | `paid`, `refused`, `gap`, or `skipped` |
| `reason` | `ok`, the on-chain reason text, `feed unavailable`, `zero amount`, `negative price` |
| `reason_code` | on-chain u8, or null when the chain was not called |
| `amount` | mint base units, decimal string of an integer |
| `nonce` | unix seconds of `window_start` |
| `signature` | confirmed transaction, or null for a gap/skip |
| `sek_per_kwh` | decimal string copied from the feed body |

`refused` is a success path. Count it, keep going. `gap` means the feed did not
answer; there is no invented price in that row.

First live rows, 2026-09-20, 50 kWh, 0.5 token per-payment max, against the
cluster in `docs/DEVNET.md`:

- paid 446000 base units at 00:00 Stockholm, SEK/kWh 0.00892,
  `25A45ZM3BEkRWP9gNzPkSFyHa3YpqtDLvng1NPCny7dKyU25Pc6SUZNAKrv65sKmJgtw6FfyfTiyAXBvzC9qTWxn`
- refused 519500 base units at 01:30 Stockholm, SEK/kWh 0.01039, over
  per-payment maximum,
  `3TtZbJJFYDGc29GemFgyMeJXc188MiZ7LfJnUUe1Y3vGrtYtZFZyyF9mwZAt31999nMdMFXBKvzThwXugHUm7cJp`

Owner token account went 1000000 to 999999.554. Merchant received 0.446. The
refused row moved nothing.

## Regenerating the IDL

The program is frozen. Rebuild the client only if the program actually changes,
and never from this package:

```bash
anchor idl build -p veto -o watcher/idl/veto.json -t watcher/src/idl.ts --no-docs -- --lib
```

`--lib` is required so the build does not compile `tests/` which embed `veto.so`.

## Tests

```bash
npm test
```

Covered: integer money conversion, no float in the money source, deterministic
nonce, re-running the same window does not resubmit, a refusal is recorded
rather than thrown, a down feed writes a gap, a 429 is failed over and a rate
limited slot stays due.
