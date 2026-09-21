## Built

Close-out of the critic review on PR 68 (`feat/merchant-terminal`). Shared watcher code was in scope. Recreated `terminal/src/critic.test.ts` (lost from the critic worktree; never posted to GitHub). Red on HEAD `6794c7e`: 1 pass, 8 fail. Green after the product changes: 9 pass.

- E1: `EnergySpotFeed.readWindow` classifies HTTP 200 missing-hour and malformed bodies separately from unreachable. The screen no longer claims the feed could not be reached when it answered 200.
- E2: `parseFeedBody` keeps the source `SEK_per_kWh` text (including `1e-05`). Money math still expands through `plainDecimal` inside `sekPerKwhToScaled`. The number on screen matches the source URL.
- E3: `loadConfig` no longer fills RPC or accounts from hardcoded defaults. Missing identities throw.
- Finding 1: the day file stays cached. A later failed fetch still hits the network, keeps the last successful read time, sets `refreshFailed`, and says so. No fresh fetch stamp on a cached price.
- Finding 2: an unparseable matched price becomes a no-quote state (503 JSON, source URL, no amount). It no longer escapes as plain-text 500.
- Finding 3: watcher and terminal both read `keys/devnet-addresses.env`, `watcher/.env`, and `terminal/.env`. File keys may be `VETO_RPC=` or `RPC=`. Volume is in that merge. Two files with different values throw.
- Finding 4: the disclosure block sits under the h1, before the payments table.
- Finding 5: the literal em dash in `page.test.ts` is now `"\u2014"`.

## Decisions

- Widen the watcher `PriceFeed` with optional `readWindow` rather than a second fetch in the terminal. `getWindow` stays `PriceWindow | null` for the watcher loop.
- Keep the day-file cache (a day of prices is fixed), as the plan required. The critic's original cache case wanted the second state to be unreachable; the fixture now asserts last-read honesty and a visible failed refresh instead of dropping the cache.
- Identities are required from env or files. Volume still defaults to 50 kWh when unset, and a disagreement between files is an error.

## Do not repeat

- Do not treat every `getWindow` null as unreachable. HTTP 200 with a missing hour or a bad body is a different sentence on the screen.
- Do not run `plainDecimal` before the terminal sees the price string. Expand only at the money boundary.
- Do not stamp `fetchedAt = now` on a cached day file.
- Do not give `quoteForWindow` a chance to throw out of `buildState`; the agent endpoint must stay JSON.
- Do not restore hardcoded RPC or merchant token fallbacks.

## Evidence

Red before the product change, from `terminal/`:

```
npx tsx --test src/critic.test.ts
tests 9, pass 1, fail 8
```

After:

```
terminal:  npm test  -> 32 pass, 0 fail; npm run typecheck exit 0
watcher:   npm test  -> 41 pass, 0 fail; npm run typecheck exit 0
indexer:   npm test  -> 18 pass, 0 fail; npm run typecheck exit 0
tools:     npm test  -> 29 pass, 0 fail; npm run typecheck exit 0
```

Critic fixtures: 9 pass, 0 fail. Dash sweep on the added lines: no U+2014, U+2013, or U+2015.

## Open questions

None for this round. Critic findings 5 (mint_decimals on `/api/quote`), 6 (batched `getParsedTransactions`), and 8 (fixed 500 body) were listed by the critic and were not in this plan's five fixable items.

## Next hint

Re-run `terminal/src/critic.test.ts` first. The cache case now expects a second network call, an unchanged `fetchedAt`, `refreshFailed: true`, and a still-usable quote. A 200 missing-hour or malformed body must not contain "could not be reached".
