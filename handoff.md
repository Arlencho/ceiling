## Built

Merchant terminal for issue 5, PR 68 against `main`, branch `feat/merchant-terminal`, commit 9125081. New top-level package `terminal/` next to `watcher/` and `indexer/`, plus a `terminal-test` Makefile target.

- `src/quote.ts`: prices a fixed kWh volume per feed window as bigint base units. Imports `feed.ts`, `money.ts`, `nonce.ts` from `watcher/src` directly (relative ESM import, resolved by tsx and tsc). No second copies.
- `src/state.ts`: `buildState` turns a feed read into a state where a down feed carries no window, no price, no quote. `quoteResponse` is the agent-facing JSON: 200 with amount + nonce, or 503 with no amount, no nonce, no price.
- `src/page.ts`: the screen. Window, fetched price, quote, nonce, source URL link, payments, and the honesty block (price public and independently verifiable; demo counterparty, not a real charge point). Price rows are not rendered at all when the feed is down.
- `src/payments.ts`: reads the merchant token account. Per-payment amount is the account's token balance delta inside the parsed transaction, matched by account address via message account keys (not owner+mint, which could double count).
- `src/server.ts`: node:http, no framework. `GET /` page (5s meta refresh), `GET /api/quote`, `GET /api/state`. 20s state cache, 15s payments cache; RPC failure shows the error plus the last good list with its timestamp.
- `src/config.ts`: reuses the watcher's `loadConfig`, so RPC, program id, mint and merchant token account come from env, `keys/devnet-addresses.env`, or package `.env`, exactly like the other packages.

## Decisions

- Plain Node + tsx package, mirroring watcher/indexer, not a Next.js app: the task says "alongside watcher and indexer", both are minimal tsx packages, and a Next.js toolchain would be the only one of its kind in the repo.
- Ran with `tsx` at runtime (`npm start` = `tsx src/index.ts serve`) instead of `tsc` emit, because the terminal imports watcher sources and a dist build would need a shared rootDir spanning two packages. Tests in the repo already run under tsx.
- The agent contract is `GET /api/quote` returning JSON; the page is for humans. A down feed is 503, so an agent cannot mistake an outage for a quote.
- `terminal/.env.example` ships the public devnet RPC URL. It is public infrastructure already committed in `docs/DEVNET.md`, and indexer ships its program id the same way. No key or private endpoint is committed.
- Zero or negative fetched price yields no quote (matches the watcher's skip rule), with an on-screen note that is distinct from the feed-down message.

## Do not repeat

- Do not copy `feed.ts` / `money.ts` / `nonce.ts` into the terminal. The relative import across packages works; the tests prove it.
- Do not cache a failed feed read into anything that renders a price. The feed-down state has no price fields by construction; `state.test.ts` asserts the serialized state contains no `sekPerKwh`.
- Do not match received payments by owner+mint in parsed token balances; match the account address through `accountKeys[accountIndex]`.
- Do not add a fallback or placeholder price. The task and the plan both treat that as disqualifying.

## Evidence

From `terminal/`:

- Red before implementation: `npx tsx --test src/*.test.ts` -> all 4 suites failed (modules absent).
- After: `npm run typecheck` exit 0; `npm test` 21 pass, 0 fail.
- Live: `VETO_RPC=https://api.devnet.solana.com npx tsx src/index.ts quote` returned amount `15361000` for window `2026-09-21T10:15:00+02:00` at `0.30722` SEK/kWh (50 kWh), nonce `1789978500`, source `https://www.elprisetjustnu.se/api/v1/prices/2026/09-21_SE3.json`.
- Live server: page rendered the same quote, read the real merchant token account balance `0.666 tokens`, and listed received payments with `explorer.solana.com/tx/...?cluster=devnet` links.
- `grep` sweep for em/en dashes over `terminal/` and the Makefile: clean.
- Issue 5 labeled `status:in-progress` at start, `status:in-review` after PR 68 opened.

## Open questions

- The watcher does not yet call the terminal's `/api/quote`; it computes the same quote itself from the same modules, so the numbers agree by construction. Wiring the watcher to consume the endpoint is a product decision, not a correctness gap.
- The terminal only reads the chain. Nothing triggers a charge from the screen; `docs/VIDEO.md` mused about an on-demand trigger for the video, and it does not exist here.

## Next hint

For the critic: check the feed-down path first (`state.test.ts`, the 503 body, and the page render asserting no stale `0.00892`), then that `quote.ts` and `state.ts` really import from `watcher/src` rather than vendoring, then that no float literal touches an amount.
