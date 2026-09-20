# Self-review of the commits merged to main without an independent critic

Reviewed on 2026-09-20 against main at `7cd1d43`. Scope: the seven areas named in the task, highest
risk first. This is a review: nothing in this PR changes behaviour or a test. Every verdict below
was reached by reading the code and running it; the evidence column names the command or the
file and line. Issues are filed for every finding at medium or worse.

Suites run from this worktree (no `target/`, no `keys/`, shared cargo registry only):

| Suite | Command | Result |
|---|---|---|
| program | `make test` | `red_team` 20 passed, `refusal_is_recorded` 4 passed, exit 0; built `target/deploy/veto.so` has ELF `e_flags = 0` (SBPF v0), 247416 bytes |
| watcher | `cd watcher && npm ci && npm test` | 26 passed, 0 failed |
| tools | `cd tools && npm ci && npm test` | 11 passed, 0 failed |
| indexer | `cd indexer && npm ci && npm run typecheck && npm test` | 18 passed, 0 failed |

Verdict words: **holds** (claim confirmed), **finding** (claim does not hold, or a defect was
found), **holds with a note** (claim confirmed, something adjacent worth knowing).

## ONE: 7cd1d43, scientific notation in the feed

| Commit | Claim | Verdict | Evidence | Severity |
|---|---|---|---|---|
| 7cd1d43 | `plainDecimal` expands negative exponents exactly | holds | `plainDecimal("1e-05") = "0.00001"`, `"1.50e-4" = "0.000150"`, `"-3.25e-2" = "-0.0325"`; scaled at `PRICE_SCALE=8` gives 1000, 15000, -3250000 | none |
| 7cd1d43 | exponents without a sign, and with `+`, expand to the right magnitude | holds | `"1e5" = "100000"`, `"1e+2" = "100"`, `"12.34e1" = "123.4"`, `"1e0" = "1"`, `"007e0" = "007"` (parses as 7) | none |
| 7cd1d43 | a plain decimal passes through unchanged | holds | `plainDecimal("0.00429") = "0.00429"`, `"-0.001"`, `"0"`, `"0.0"` unchanged; the expander regex requires `[eE]` (`watcher/src/feed.ts:37`) | none |
| 7cd1d43 | values that round to zero cannot produce a charge | holds | `"1e-8"` scales to 1 and `amountBaseUnits` returns 0; `"1e-9"`, `"1e-10"`, `"1.5e-9"` scale to 0; `run.ts:157` records `skipped, zero amount` and submits nothing | none |
| 7cd1d43 | nothing reaches the money math as a float or a wrong magnitude | holds | `plainDecimal` is string-only (`feed.ts:35-56`); `money.ts` has no `Number`/`parseFloat` on the price path; every JSON number form (`-?int(.frac)?([eE][+-]?int)?`) is either expanded or already plain. Non-JSON forms (`"1e"`, `"e5"`, `".5e-3"`, `"1.e5"`) fall through and `money.ts:18` rejects them | none |
| 7cd1d43 | `money.ts` still rejects scientific notation | holds | `money.ts:18-20` throws on `/[eE]/`; `money.test.ts:25` pins it; observed `parseDecimalToScaled: scientific notation is not allowed: 1e` | none |
| 7cd1d43 | the loosened `ENTRY_RE` cannot match across two entries | holds | `[^,]+` for `EUR_per_kWh` and `EXR` cannot cross a comma, and every field boundary and the `},{` between entries contains one (`feed.ts:28`). Fed a first entry with no `time_start`/`time_end` followed by a good one, the parser returns exactly the second entry with `sekPerKwh "0.00011"`, no fabricated window | none |
| 7cd1d43 | a price of exactly zero is handled as the program expects | holds with a note | `"0"`, `"0e5"`, `"-0e-3"` all scale to 0; the watcher records `skipped, zero amount` off chain (`run.ts:155-165`). The program would record `REASON_ZERO_AMOUNT` (`lib.rs:376`) if submitted; the watcher pre-empts it and never spends a ring slot on it. Pre-existing choice, documented in `watcher/README.md:156` | none |
| 7cd1d43 | a negative price is handled as the program expects | holds | `"-3.25e-2"` and `"-0.001"` scale negative; `run.ts:141` records `skipped, negative price` before `amountBaseUnits`, which would throw (`money.ts:75`). Nothing is submitted | none |
| 7cd1d43 | `SEK_per_kWh: null` or a missing field | holds with a note | The entry is dropped silently (`[]` returned), as before this commit. The feed does not emit null, so no action; noted because "dropped whole" was the failure mode this commit fixed for another cause | low, no issue |

## TWO: 7cd1d43, `maxSettledNonce` counts only paid rows

| Commit | Claim | Verdict | Evidence | Severity |
|---|---|---|---|---|
| 7cd1d43 | a refusal does not advance `last_nonce` on chain | holds | `programs/veto/src/lib.rs:187` `mandate.last_nonce = nonce` is inside the `reason == REASON_OK` branch; the else branch (`lib.rs:205-236`) touches `status` and `refusal_count` only; `grant_override` sets `override_nonce` (`lib.rs:284`), not `last_nonce`; `evaluate` comment at `lib.rs:379` states it | none |
| 7cd1d43 | `maxSettledNonce` therefore must count only paid rows | holds | `journal.ts:66` filters `signature !== null && decision === "paid"`; `run.test.ts` "a refusal does not strand an earlier window" is green | none |
| 7cd1d43 | no window can be submitted twice | holds | `TERMINAL` is `paid`, `refused`, `skipped` (`journal.ts:26`); `hasNonce` gates both `processDue` (`index.ts:56`) and `processWindow` (`run.ts:84`, `run.ts:125`). A refused nonce is never resubmitted by this watcher (the F2 known limit in `docs/SECURITY_REVIEW.md`), so no double submission from the journal's point of view | none |
| 7cd1d43 | no window can be stranded | finding | A gapped window below the highest paid nonce is not stranded but is turned into an on-chain replay refusal when the feed recovers. See THREE, issue #39 | medium |

## THREE: 4b46505, gaps are no longer terminal

| Commit | Claim | Verdict | Evidence | Severity |
|---|---|---|---|---|
| 4b46505 | an overtaken window is closed as `skipped` rather than submitted | **finding** | The guard `nonce <= maxSettledNonce()` exists only in the `window === null` branch (`run.ts:87`). When the feed is back up, the retry runs `run.ts:125-183` with no guard and submits. Repro: journal with a `gap` at 06:00 and a `paid` at 12:00, feed returning the 06:00 window: `processWindow` calls `submit` once and records `refused, nonce already settled, reason_code 3`. The commit's live verification only exercised the feed-still-down branch because the 12:00 entry was at that time being dropped by the regex (fixed in 7cd1d43). Issue [#39](https://github.com/Arlencho/veto/issues/39) | medium |
| 4b46505 | no duplicate rows | holds for the feed-down path, finding for the unreadable-price path | `hasGap` (`journal.ts:77`) dedupes `feed unavailable` rows: repro with three cycles of a down feed yields one row. The `unreadable price` append at `run.ts:132` has no such check: three cycles with `sekPerKwh "1e"` yield three `gap` rows. Only reachable with a non-JSON number, since `plainDecimal` covers every JSON form, so low. Folded into #39 | low |
| 4b46505 | a window cannot be retried forever | holds with a note | Retries are bounded by the Stockholm day: `dueSlots(now)` (`cadence.ts:75`) only yields today's slots, so a gapped window stops being retried at midnight and its `gap` row stands. During an outage the run loop wakes every 30 s (`index.ts:107`) and each gapped slot costs 5 fetch attempts with 2 s between them (`run.ts:12-13`), so a whole-day outage is roughly 20 requests per 40 s against the public feed all day. Bounded, not free | low, no issue |
| 4b46505 | the journal cannot grow without bound during a long outage | holds | One `gap` row per gapped slot per day, four slots per day (`hasGap`, `cadence.ts:9`). The unreadable-price case above is the only unbounded path and needs a malformed feed | low |
| 4b46505 | a gap cannot be mistaken for a decision in the ledger the demo shows | finding, same root cause | In the journal a `gap` has `signature: null` and `decision: "gap"` and `counts()` reports it separately (`journal.ts:85`); `skipped` rows say `window overtaken by a later settled charge`. But the on-chain ledger, which the app and the indexer show, gets a `REFUSED reason=3` entry from the path in the first row of this table: a refusal no policy produced, in the ring of 32. Issue #39 | medium |
| 4b46505 | (adjacent) `once --window <ISO>` with a time that is not a slot start | holds with a note | In the feed-down branch the gap nonce is derived from `args.at` (`run.ts:83`), so a manual `--window 12:07` during an outage records the gap under `nonce(12:07)`, and the later real window is `nonce(12:00)`; `hasGap` and the overtaken guard key off the wrong value for that one manual row. `run` and `once` without `--window` always pass exact slot starts. Pre-existing shape, not from this commit | low, no issue |

## FOUR: 78496c8 and 4b50a63, the SBPF arch split

| Commit | Claim | Verdict | Evidence | Severity |
|---|---|---|---|---|
| 78496c8 | the test path and the deploy path cannot silently swap artifacts again | holds | Both `make build` and `make build-test` `rm -f target/deploy/veto.so` before `anchor build` (`Makefile:42,46`); `devnet-setup.sh:426` does the same and `unset ANCHOR_BUILD_SBF_ARCH` at `:12`. The tests read ELF `e_flags` at offset 48 and fail with the rebuild command if it is not 0 (`tests/refusal_is_recorded.rs:100-104`, `tests/red_team.rs:181-185`), so a stale v3 artifact is loud, never silent |none |
| 78496c8 | a fresh clone running `make test` gets a v0 binary | holds | This worktree had no `target/` and no `keys/`; `make test` built and passed; `e_flags` of the result is 0, size 247416 (the v0 size the commit names). CI `program` job green on all 14 main runs | none |
| 78496c8 | `make setup` deploys the default arch | holds | `devnet-setup.sh:12` unsets the pin, `:426-427` deletes and rebuilds; `docs/DEVNET.md` recorded at 20:57Z; devnet `getSignaturesForAddress` shows the five most recent transactions to `3zNp...` with `err: null` at blockTime 1789937870 to 1789938050, so the deployed binary executes. Not verified: a byte comparison of the on-chain program data against a local default-arch build | none |
| 78496c8 | nothing else builds the program by a third route | holds with a note | `grep -rn "anchor build\|build-sbf\|ANCHOR_BUILD_SBF_ARCH"` outside `node_modules` and `target` finds only the Makefile, the setup script, `Anchor.toml` comments, the test doc comments, `docs/DEVNET.md` (the manual deploy recipe, default arch, correct for deploy) and `watcher/README.md:184` (`anchor idl build`, which does not emit a `.so`). `anchor test` would run the default-arch build and then fail loudly on `e_flags`. CI caches `target/` but `build-test` deletes the artifact first | none |
| 4b50a63 | (superseded) one arch for both paths | n/a | Reverted by 78496c8 after it deployed a v0 binary the validator refused; the current Makefile header records why. Nothing of 4b50a63 remains except the `rm -f` idea | none |

## FIVE: a8c4698, `declare_id`

| Commit | Claim | Verdict | Evidence | Severity |
|---|---|---|---|---|
| a8c4698 | the id agrees in source, `Anchor.toml`, the three bundled IDLs and on devnet | holds | `lib.rs:31`, `Anchor.toml` `[programs.localnet]` and `[programs.devnet]`, `tools/idl/veto.json`, `watcher/idl/veto.json`, `indexer/idl/veto.json`, `watcher/src/idl.ts`, `watcher/src/config.ts:11` default, `docs/DEVNET.md` all carry `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`; devnet `getAccountInfo` returns `executable: true`, owner `BPFLoaderUpgradeab1e...`, programData `7Khc...`; the three IDL JSON copies are byte-identical (md5 `f33e0fbf...`) | none |
| a8c4698 | a mismatch fails loudly rather than silently refusing every charge | holds at runtime | Anchor's generated entrypoint returns `DeclaredProgramIdMismatch` on every instruction when `program_id != ID` (`anchor-syn-1.2.0/src/codegen/program/entry.rs:62`); `charge` additionally errors with `InvalidMandatePda` (`lib.rs:133-147`). Both are transaction errors, not recorded refusals, so the ledger is not polluted and the failure is visible on the first call | none |
| a8c4698 | (adjacent) the deploy script keeps that guarantee | **finding** | `devnet-setup.sh` never checks `keys/program.json` against `declare_id`. Without the backed-up key, `ensure_keypair` mints a new one, `anchor keys sync` (`:417`) rewrites `declare_id` for the build, the deploy goes to the new id, `restore_after_build` (`:399`) hides the rewrite, and `Anchor.toml` plus `docs/DEVNET.md` are rewritten to the new id while every bundled consumer still points at `3zNp...`. On localnet consumers then fail with program-not-found; on devnet they silently use the existing `3zNp...` deployment instead of the program just built. Issue [#40](https://github.com/Arlencho/veto/issues/40) | medium |

## SIX: a21fe13, the round 2 closure

| Commit | Claim | Verdict | Evidence | Severity |
|---|---|---|---|---|
| a21fe13 | the bundled IDL copies were regenerated from the built ABI | holds | Freshly built `target/idl/veto.json` equals all three copies once `docs` arrays are stripped (the copies are built with `--no-docs`, `watcher/README.md:184`): 21 errors, last `NonceAlreadySettled` (6020); `watcher/src/idl.ts` has the same 119 `name` entries as the JSON | none |
| a21fe13 | `docs/SECURITY_REVIEW.md` status lines point at real tests | holds | F1, F2, F4 each carry a `Status: fixed in #37` block and name `finding_1_expired_status_still_allows_revoke_and_drops_the_delegation`, `finding_2_grant_override_rejects_a_nonce_that_can_never_pay`, `finding_4_a_frozen_account_is_a_recorded_refusal`; all three exist (`red_team.rs:895,939,1020`) and pass. F3, F5, F6, F7 keep their defect-pinning names and still pass, so they are still open and still pinned | none |
| a21fe13 | `finding_1` proves what its name claims | holds | Charges to EXPIRED, then `revoke` succeeds, status is REVOKED, `source.delegate.is_none()`; second revoke errors `MandateNotActive`; close succeeds and delegate is still none. Second world: five paid charges to EXHAUSTED (asserted), revoke succeeds, delegate none | none |
| a21fe13 | `finding_2` proves what its name claims | holds | After nonce 8 pays, `grant_override` at 3 and at 8 both error `NonceAlreadySettled`, `override_nonce` and `override_amount` stay 0, last ledger entry is still PAID (no dead OVERRIDE written); nonce 9 is accepted. The orphan case asserts both exits the reworded comment names: a later grant replaces (`override_nonce == 9`), revoke clears (`== 0`) | none |
| a21fe13 | `finding_4` proves what its name claims | holds | Frozen destination: `charge` returns Ok, ledger total +1, kind REFUSED, reason 10, `suggested_override` 0, `refusal_count` 1, destination balance unchanged. Frozen source: same, destination balance 0 | none |
| a21fe13 | no test was weakened | holds | The three renamed tests replaced assertions of the defect with assertions of the fix, which is the inversion the file header prescribes ("Each pins current behaviour; invert when fixed"). Test count unchanged at 20 + 4. Every other test in the diff is additive: `tools/lib.test.ts` +1 assertion +1 test, `watcher/src/parse.test.ts` +1 test | none |
| a21fe13 | the tools regression means "the next code cannot reintroduce the same gap" | holds with a note | `tools/lib.test.ts:102` loops `0..=10` with the bound hardcoded. It pins today's table and catches a removed entry; it cannot catch a reason 11 added to the program without a tools update, because the bound is not derived from the program or the IDL (the IDL carries no reason constants). The name is broader than the test | low, no issue |

## SEVEN: 382a028 fresh clone, and 81ffc43 the merge

| Commit | Claim | Verdict | Evidence | Severity |
|---|---|---|---|---|
| 382a028 | a clean clone can run `make test` | holds | Run here from a worktree with no `target/` and no `keys/`: exit 0, 24 program tests green, v0 artifact. CI `program` job: success on every one of the 14 main runs since the workflow landed | none |
| 382a028 | "and prove it in CI" | **finding, pre-existing** | Every main run from 382a028 through 7cd1d43 has `conclusion: failure` because the `app` job fails at `npm ci`: `Missing: typescript@5.9.3 from lock file`. Not reproduced locally: with npm 11.16.0, `cd app && npm ci --ignore-scripts` exits 0 and installs 969 packages, so the lock is rejected only by the runner's npm (Node 22 ships npm 10), which makes the job's colour depend on the npm version rather than on the code. Main has never been green, so the workflow cannot signal a regression in `program` or `indexer` by its colour. `watcher` and `tools` are not in CI at all. Introduced by the mobile seat (`app/package-lock.json` last touched in ef86380 and 04c2a42), not by the reviewed range. Issue [#41](https://github.com/Arlencho/veto/issues/41) | medium |
| 382a028 | CI installs the same toolchain the docs name | holds with a note | Anchor is pinned to 1.2.0; the Solana CLI is `release.anza.xyz/stable`, unpinned, while `docs/DEVNET.md` names 4.1.2. Drift risk only | low, no issue |
| 81ffc43 | all three Makefile sections are kept | holds with a note | Indexer targets from e0f0c65 and the tools comment block from 9bfc543 are both in the merged Makefile (`Makefile:47-53`, `:37-39`). The watcher never added a Makefile section (cb52cef touched only `README.md` and `watcher/`), so "each documented itself in the Makefile" overstates by one, and nothing was lost | none |
| 81ffc43 | all three README sections are kept | holds with a note | `watcher/`, `indexer/` and `tools/` all appear in the layout block, plus the tools walkthrough and the indexer paragraph. The resolution added a second `tools/` line, so `README.md:127` and `:129` now describe the same directory twice with different wording. Doc nit | low, no issue |

## Summary

Three findings at medium, each with an issue:

1. [#39](https://github.com/Arlencho/veto/issues/39) watcher: an overtaken window is submitted when the feed is back and lands a `nonce already settled` refusal on chain. The guard 4b46505 added covers only the feed-still-down branch.
2. [#40](https://github.com/Arlencho/veto/issues/40) build: `devnet-setup.sh` silently deploys under a fresh id when `keys/program.json` is not the `declare_id` key, and rewrites the docs to match while every bundled consumer keeps the old id.
3. [#41](https://github.com/Arlencho/veto/issues/41) ci: the `app` job has failed on every main run since CI was introduced, so main has never been green. Pre-existing.

Everything else the seven commits claim holds under the evidence above. The scientific-notation expander is exact and cannot reach the money math as a float; refusals do not advance `last_nonce`; the arch split cannot swap artifacts silently; the program id agrees everywhere it is written and on devnet; the round 2 assertions prove what their names say and no test was weakened; a fresh clone runs `make test`.
