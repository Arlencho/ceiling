## Built

Round 3 close-out of PR 68 (`feat/merchant-terminal`). One classification defect, three screens. Fixtures in `d6f84ec` were not edited.

- Unreadable body: a JSON array the parser cannot read (wrong keys, quoted price text, or any non-empty array with zero parsed windows) is `malformed`, not `missing_window`. The screen says the body could not be read. A valid day file that simply lacks this hour stays `missing_window`.
- HTTP answer: a non-2xx response is `http_error` with the status code. The screen names the status. Fetch throw or timeout stays `unreachable`.
- Last-read time: `readAt` is the last successful price read, or null. `fetchedAt` is only set when `feed === "ok"`. A screen with nothing read does not say "Price last read at".

## Decisions

- Widen `FeedStatus` with `http_error` and carry `httpStatus` on `FeedRead`, rather than rewriting the unreachable sentence per status.
- Treat a non-empty JSON array with zero parsed windows as unreadable. An empty array is understood and is a missing hour.
- Cache still stores a day file we understood. Cache is not a last-read time when no price came out of it.

## Do not repeat

- Do not treat `windows.length === 0` on a JSON array as a missing hour. That is how a body holding this hour under other keys was mislabelled.
- Do not map `!res.ok` to unreachable. The feed answered.
- Do not stamp `readAt` with the attempt time when no price was read, and do not render "Price last read at" unless `feed === "ok"`.
- Do not edit `terminal/src/critic-round2.test.ts` or `terminal/src/critic.test.ts`.

## Evidence

Red at `d6f84ec`, before the product change:

```
cd terminal && npx tsx --test src/critic-round2.test.ts
13 tests in that file: 5 pass, 8 fail
(wrong-shape array as missing hour; last-read time on no-price screens; HTTP 404/429/503 as unreachable)
```

Round 1 regression (`critic.test.ts` "feed goes down after one good read") stayed green on unfixed code.

After, at this SHA:

```
cd terminal && npx tsx --test src/critic-round2.test.ts src/critic.test.ts
22 pass, 0 fail (13 round 2 + 9 round 1)

terminal:  npm test  -> 45 pass, 0 fail; npm run typecheck exit 0
watcher:   npm test  -> 41 pass, 0 fail; npm run typecheck exit 0
indexer:   npm test  -> 18 pass, 0 fail; npm run typecheck exit 0
tools:     npm test  -> 29 pass, 0 fail; npm run typecheck exit 0
```

Dash sweep on the added lines: no U+2014, U+2013, or U+2015. Fixtures, `programs/veto/src`, and `app/` untouched.

## Open questions

None for this round. Out of scope stays #72 (entry parser key order), #73 (20 s state cache across a window boundary), and the round 1 items listed as outside the plan.

## Next hint

Re-run `terminal/src/critic-round2.test.ts` (13) and `terminal/src/critic.test.ts` (9). A 200 array that is not the day-file shape must say "the body could not be read". A 404/429/503 must name the status and must not say "could not be reached". A no-price screen must not contain "Price last read at".
