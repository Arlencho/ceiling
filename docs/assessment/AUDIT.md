# Audit: code that presents what it did not obtain

One defect class, every package. An instance is any place that presents a value, a state or an
outcome it did not actually obtain:

1. a fallback or a default standing in for an unobserved fact,
2. several distinct outcomes collapsed into one indistinguishable result,
3. a cache or a local record consulted as though it were the source of truth,
4. a timestamp or a label describing an event that did not happen,
5. a screen or a document asserting something it never checked.

## Counts

| | Count |
|---|---|
| Instances found | 66 |
| **Mechanical** (a type, a lint or a test could have caught it) | **42** |
| **Judgment** (someone had to decide the claim was wrong) | **24** |

Stated plainly, because the ratio decides whether a mechanical fix can work: **42 of 66 are
mechanical, 24 of 66 needed judgment.** Roughly two thirds could be held by tooling. The remaining
third is sentences and verdicts: "Your rule held", "VERDICT: CONFIRMED", "the complete record",
"no payments received yet". No type and no lint reaches those. They are caught by a reader who
knows what the code actually looked at, which is what this audit is, and they cluster in exactly
the places the product sells: the refusal card, the export, the verifier.

The mechanical majority is also not free. Most of the 42 are one of three shapes: `?? CONSTANT`
where the constant is a chain identity, `catch {}` turning a failed read into an empty or zero
result, and a label written from an input rather than from an observed outcome. A rule per shape
plus a test per site covers them. A rule that only bans `??` would not: five of the 42 are shell
(`|| printf '0'`), one is a CI job that runs a typecheck and calls it a test run, and two are
generated documents.

## Scope and method

Audited tree: branch `assess/invariant`, based on `main` at `2a8110e`. Packages read in full:
`programs`, `watcher`, `indexer`, `tools`, `app`, `scripts`, `docs`, CI and the Makefile.

`terminal/` does not exist on `main`. It lives only on the unmerged branch `feat/merchant-terminal`
(head `6a87920`), and was read from there with `git show`. Its three instances are marked
**branch only** and are counted, because the task names the package.

Two notes on the calibration set, stated because evidence beats assertion:

- The plan file header listing the eighteen known instances is not present in this worktree.
  `docs/PLAN.md` is the build plan and does not carry that list, and no other plan file exists
  under the worktree or the main checkout. This audit was therefore derived from the class
  definition above and from the one worked example the task gives, not calibrated against the
  eighteen. If the eighteen were a subset, they should appear below; if any do not, that is a gap
  in this audit rather than a claim that they are absent.
- The task says the decision to remove defaulted chain identities "was applied to two packages this
  morning". On this tree that is `app` (`app/lib/appConfig.ts:42-52` throws when the RPC url or the
  program id is missing) and `watcher`, but the watcher change is **not on `main`**: it exists only
  on `feat/merchant-terminal` (`c41c088`), which replaced the `DEFAULTS` block with a loader that
  throws. On the tree that ships today, `watcher/src/config.ts:9-18` still carries all eight
  defaulted identities. So the live count of packages still resolving chain identity to a constant
  is three, not one: `watcher`, `indexer`, `tools`.

---

## programs

The program is frozen and both instances are recorded for completeness, not for action.

#### P1. `programs/veto/src/lib.rs:239-247`
- **Claims:** the refusal line prints `per_tx_max=` and `remaining=` for every refusal, as the
  numbers that explain it. The README quotes this line as the product.
- **Knows:** only the reason code. For reason 1 (not active), 3 (stale nonce), 4 (merchant not
  allowed), 7, 8 and 10, neither number had anything to do with the decision.
- **Demo:** yes. Any refusal outside reason 5 or 6.
- **Catchable:** judgment. The fields are factually the mandate's own limits; only a reader
  deciding that a refusal line must carry the reason's own evidence sees the problem. The app made
  exactly this decision for its copy (handoff F1) and the program log was not revisited.

#### P2. `programs/veto/src/lib.rs:87-96`
- **Claims:** the `KIND_OPENED` ring entry stores `amount = args.cap` and
  `counterparty = args.merchant`, in the two fields that everywhere else mean "the amount of this
  decision" and "who was paid".
- **Knows:** nothing was paid to anyone. Same for `KIND_OVERRIDE` (`lib.rs:286-295`, amount is the
  override) and `KIND_REVOKED` (`lib.rs:318-327`, counterparty is the merchant).
- **Demo:** yes, entry 0 of every ledger. The app and the indexer both filter to paid and refused,
  so nothing renders it today.
- **Catchable:** judgment. The struct is one `Entry` for five kinds, so no type distinguishes them.

---

## watcher

#### W1. `watcher/src/config.ts:9-18`, used at `100-110`
- **Claims:** a full chain identity (RPC, program id, mint, owner, owner token account, merchant,
  merchant token account, agent) whenever the environment and `keys/devnet-addresses.env` are
  silent. `index.ts:89-91` then logs `watcher start rpc=...` as though it had been configured.
- **Knows:** nothing was configured. The constants are a snapshot of one devnet deploy.
- **Demo:** yes. A watcher started without `keys/` signs charges against whatever lives at those
  addresses, or hangs in RPC backoff against `127.0.0.1:8999`.
- **Catchable:** mechanical. This is the exact defect removed on `feat/merchant-terminal`, with a
  test (`watcher/src/config.test.ts`) asserting the loader throws. Not merged.

#### W2. `watcher/src/config.ts:93-97`
- **Claims:** `mandateId` 1, `cap` 100000000, `perTxMax` 500000, `kwhMilli` and `mintDecimals`
  defaults are the owner's limits. `open-mandate` writes them on chain, permanently.
- **Knows:** no one stated a cap or a per-payment maximum.
- **Demo:** yes. `npm run open-mandate` with an empty env opens a real mandate with invented limits.
- **Catchable:** mechanical. Same test shape as W1.

#### W3. `watcher/src/feed.ts:117-133`
- **Claims:** `getWindow` returns `null`, and `run.ts:109-127` writes
  `decision: "gap", reason: "feed unavailable"`.
- **Knows:** four different things collapsed into that one `null`: the fetch threw (line 128), the
  server answered non-200 (line 123), the body did not parse (`parseFeedBody` returned nothing), or
  the feed simply has no window covering this instant (`windowContaining`, line 98-107). Only the
  first is "unavailable".
- **Demo:** yes. This is the journal the seven day history is read from.
- **Catchable:** judgment. `Promise<PriceWindow | null>` typechecks perfectly. The classification
  exists on `feat/merchant-terminal` (`FeedRead`/`FeedStatus`), written for the terminal, and the
  watcher's own `run.ts` on `main` still consumes the collapsed `null`.

#### W4. `watcher/src/feed.ts:110`, `119-131`
- **Claims:** `sek_per_kwh` in the journal is the price for that window.
- **Knows:** the body was fetched once per URL per process lifetime and cached forever. `run` is a
  long-lived process (`index.ts:100-108`), so a day's file read at 00:05 is served until midnight.
  A republished or corrected day is never seen.
- **Demo:** yes, for any watcher that stays up, which is the point of `scripts/watcher-service.sh`.
- **Catchable:** judgment. A cache with no TTL is a design choice until someone asks what the
  recorded price is evidence of.

#### W5. `watcher/src/run.ts:51`, `98`, `117-118`
- **Claims:** `window_start` is the start of the price window this decision is about.
- **Knows:** on the gap path and the overtaken path it is `args.at.toISOString()`, the cycle's
  wall clock, written into the same field. A reader of the journal cannot tell a feed window
  boundary from a scheduler tick. The nonce is derived from the same substitution
  (`run.ts:82`), so a gap row's nonce is not a window nonce either.
- **Demo:** yes, on the first feed outage.
- **Catchable:** judgment. Both are `string`. A distinct type would have caught it, but only after
  someone decided they are different kinds of instant.

#### W6. `watcher/src/run.ts:39-50`
- **Claims:** `ts` is the time of the decision.
- **Knows:** it is `new Date()` at the moment the row is appended. For
  `once --window <past ISO>` (a documented command, `watcher/README.md:77-80`) the row claims now
  for a decision about a window hours earlier.
- **Demo:** yes, and backfill after a restart is the documented recovery path.
- **Catchable:** judgment.

#### W7. `watcher/src/chain.ts:100-106`
- **Claims:** on `getTransaction` returning `null`, `logs` becomes `[]` and `parseChargeLogs`
  throws "confirmed transaction had neither PAID nor REFUSED", a statement about what the
  transaction contained.
- **Knows:** the transaction was never read. "Not retrievable yet at this commitment" and "read,
  and it carried neither line" are collapsed into one message, and the throw propagates into
  `withRpcBackoff` (`run.ts:184`), which resubmits the same charge.
- **Demo:** yes. A confirmed signature is not always immediately retrievable.
- **Catchable:** mechanical. The `?? []` is the whole defect, and a test stubbing
  `getTransaction` to `null` catches it.

#### W8. `watcher/src/chain.ts:65-67`, against `80-81`
- **Claims:** the charge is sent to the configured program.
- **Knows:** the instruction's program id comes from the bundled IDL's `address` field
  (`watcher/idl/veto.json`, pinned to the committed id), because that is where Anchor 0.32 takes it
  from. `cfg.programId` is used only to derive the PDAs at lines 80-81. A `VETO_PROGRAM_ID` that
  differs from the bundled IDL is silently ignored for the instruction and honoured for the
  accounts. `indexer/src/seed.ts:99-101` overwrites `idl.address` for exactly this reason; the
  watcher does not.
- **Demo:** yes, on any redeploy under a new id.
- **Catchable:** mechanical. One equality assertion, and the sibling package already proves the
  author knew the field matters.

#### W9. `watcher/src/chain.ts:119-122` with `watcher/src/index.ts:119-123`
- **Claims:** "mandate already open `<pda>`".
- **Knows:** only that an account exists at that address. The existing mandate's cap, per-payment
  maximum, merchant, agent and expiry are never compared with the config that would have been used,
  so a run with different limits reports success and changes nothing.
- **Demo:** yes, on the second `open-mandate`.
- **Catchable:** mechanical. Fetch and compare the fields, and a test asserts the mismatch is
  reported.

#### W10. `watcher/src/journal.ts:41-46`
- **Claims:** `counts()` and `cmdStatus` (`index.ts:132-134`) report `total=`, `paid=`, `refused=`,
  `gap=`, `skipped=` as the journal's content.
- **Knows:** every unparseable line was silently dropped by the `catch`. The comment says a torn
  line is expected after a crash mid-write, which is precisely when the count matters.
- **Demo:** yes, after any hard stop of the service.
- **Catchable:** mechanical. Return the skipped count, and a test with a truncated line asserts it
  surfaces.

---

## indexer

#### I1. `indexer/src/cli.ts:21` with `indexer/src/constants.ts:4`
- **Claims:** the run header prints `rpc <url>` and the JSON body carries `"rpc"`, presented as the
  endpoint the history was read from.
- **Knows:** with `VETO_RPC` unset it is the constant `http://127.0.0.1:8999`, which is not even the
  standard local validator port.
- **Demo:** yes. This is the live instance the task names.
- **Catchable:** mechanical.

#### I2. `indexer/src/cli.ts:22` with `indexer/src/constants.ts:3`
- **Claims:** `program <id>` in both output shapes, as the program whose logs were decoded.
- **Knows:** the committed constant, with nothing said about whether that program is the deployed
  one.
- **Demo:** yes. The second live instance the task names.
- **Catchable:** mechanical.

#### I3. `indexer/src/seed.ts:60-61`
- **Claims:** `rpc` and `program` in the seed report are the endpoint and the program used.
- **Knows:** both fall through `process.env`, then the addresses file, then to the same two
  constants. The seed opens a real mandate and submits real charges under them.
- **Demo:** yes, `make indexer-seed`.
- **Catchable:** mechanical.

#### I4. `indexer/src/history.ts:39`
- **Claims:** `fetchDecisionHistory` decodes the history of `opts.programId`.
- **Knows:** when a caller omits it, the constant is substituted and the caller is never told.
- **Demo:** no. The only in-repo caller, `tools/export.ts:174`, always passes one. This is a
  library surface waiting to be used.
- **Catchable:** mechanical. Make the field required; the type does the work.

#### I5. `indexer/src/seed.ts:99-101`
- **Claims:** silently rewrites `idl.address` to the configured program id when the two disagree.
- **Knows:** that the bundled IDL describes a different program than the one being seeded, which is
  a fact worth reporting rather than overwriting. Under the assumption behind W8 the rewrite is the
  only reason the seed targets the right program, so the disagreement is load bearing and invisible.
- **Demo:** yes, whenever the deploy id is not the committed one.
- **Catchable:** mechanical. Compare and throw.

#### I6. `indexer/src/seed.ts:164-169`, `178-180`
- **Claims:** the report's `"paid"` and `"refused"` keys, and the three `extra_refused_signatures`,
  label what each charge did.
- **Knows:** only the amounts it chose (500000 against a 1000000 per-payment maximum, and
  5000000 above it). No log is read. If the mandate is not active, if the delegation is missing, or
  if the source is short, the first charge is refused and the JSON still calls it paid.
- **Demo:** yes. This JSON is what the CLI is then compared against.
- **Catchable:** mechanical. `parseChargeLogs` already exists two packages over.

#### I7. `indexer/src/events.ts:82-92`
- **Claims:** every decision row carries a `counterparty`, printed in the table and the JSON.
- **Knows:** if no charge instruction in the transaction names this mandate, it returns account 4
  of the first charge instruction it can find, which may belong to a different mandate; and if
  there is none at all it returns `""`, which formats as an empty cell and exports as an empty
  string.
- **Demo:** yes for the empty case (any transaction whose accounts were not fully decoded), and the
  empty string reaches `tools/bulk.ts:159-163`, which does throw on it.
- **Catchable:** mechanical. The return type should be `string | null`, and a fixture with no
  matching charge catches the fallback.

#### I8. `indexer/src/history.ts:52-57` with `cli.ts:59-61`
- **Claims:** the usage text says the command "rebuilds Paid and Refused decisions from program
  logs" and "does not invent rows for gaps".
- **Knows:** the block scan fallback stops after `maxSlots` (default 50000) and never says the
  window was bounded. Not inventing a row is not the same as having looked at the whole chain.
- **Demo:** only against an RPC with no signature index, which is the local validator path.
- **Catchable:** judgment. The truncation is deliberate and correct; only the claim around it is
  wrong.

#### I9. `indexer/src/history.ts:98`
- **Claims:** the header prints `signatures N across P page(s)` then `M Paid/Refused event(s)`,
  which reads as N signatures decoded into M events.
- **Knows:** every signature with `err` was skipped before decoding, and N still counts them.
- **Demo:** yes, wherever a failed transaction touched the program.
- **Catchable:** judgment. The number is honest about what it counts; the sentence is not.

#### I10. `indexer/src/compare.ts:58`, surfaced at `format.ts:57` and `cli.ts:128-130`
- **Claims:** "matched exactly: N", `ok: true`, exit code 0.
- **Knows:** `equal` is computed after filtering out every `timestamp:` diff. A row whose ring
  timestamp disagrees with the indexed block time is counted as an exact match and the comparison
  passes. The diff is appended to the row line, so it is visible, but the summary and the exit code
  say the two sources agree.
- **Demo:** yes. `--compare` is the whole point of the CLI.
- **Catchable:** judgment. The filter is intentional; the word "exactly" is the defect.

#### I11. `indexer/src/cli.ts:25`, `36` with `rpc.ts:45-50`
- **Claims:** the JSON reports `signature_pages` and `signature_count`, implying a known paging
  behaviour.
- **Knows:** `--page-size abc` or `VETO_PAGE_SIZE=abc` becomes `NaN`, is silently clamped to 200,
  and the effective page size is never reported.
- **Demo:** yes, on a typo.
- **Catchable:** mechanical. Reject non-numeric input; a test on `Number()` output catches it.

---

## tools

#### T1. `tools/lib.ts:208-215`
- **Claims:** `export` and `verify` ran against the RPC they report.
- **Knows:** with no flag, no `VETO_RPC` and no addresses file, it is the constant
  `https://api.devnet.solana.com`. A verify run against the wrong chain reports REJECTED with
  "not found on this RPC", which reads as tampering rather than as a defaulted endpoint.
- **Demo:** yes, from a fresh clone with no `keys/`.
- **Catchable:** mechanical.

#### T2. `tools/lib.ts:217-222`
- **Claims:** `program_id` in every exported record.
- **Knows:** the committed constant when nothing else is set.
- **Demo:** yes.
- **Catchable:** mechanical.

#### T3. `tools/lib.ts:224-230` with `tools/export.ts:229-231`
- **Claims:** every exported record and every CSV comment header carries `cluster: devnet`.
- **Knows:** the string came from `keys/devnet-addresses.env` or from the constant `"devnet"`, and
  it is never cross checked against the genesis hash read from the same connection eight lines
  later at `export.ts:231`. The two fields sit side by side in the record, one observed and one
  asserted.
- **Demo:** yes, on every export.
- **Catchable:** mechanical. The genesis hash of devnet is a known constant; one comparison settles
  it, and `docs/DECISION_RECORD.md:58` already concedes the field is "not a proof".

#### T4. `tools/export.ts:114-128`
- **Claims:** the record's `timestamp`, `counterparty` and `suggested_override` are this decision's.
- **Knows:** when several ring rows match on amount, nonce and kind, it scores the candidates by
  block time and log agreement and emits the highest scorer. A tie emits whichever sorted first.
- **Demo:** yes, after a retried charge or a ring wrap.
- **Catchable:** judgment. The scoring is a reasonable heuristic; emitting its output as fact
  without a note is the defect.

#### T5. `tools/export.ts:129-146`
- **Claims:** a record in exactly the same shape as a ring backed one.
- **Knows:** the ring no longer holds the row, so the entry was rebuilt from the transaction and
  its logs, and `ts` is `0n` when `blockTime` is null. The only signal is a `console.error` warning
  that does not travel with the file.
- **Demo:** yes, after the ring wraps (32 entries; the planned cadence fills it in eight days).
- **Catchable:** mechanical for the `0n`; a flag on the record would need judgment.

#### T6. `tools/export.ts:193-197`
- **Claims:** bulk records are overlaid with ring data where the ring still holds the row.
- **Knows:** a failed ledger read is swallowed into `null`, so every record for that mandate
  silently loses the overlay and falls back to indexer block times. "No ledger" and "could not read
  the ledger" are the same value.
- **Demo:** yes, on one RPC hiccup mid-export.
- **Catchable:** mechanical.

#### T7. `tools/bulk.ts:175`
- **Claims:** `timestamp` in the exported record.
- **Knows:** when the indexer had no block time and the ring has no matching row, it writes `0`,
  which is 1970-01-01T00:00:00Z presented as when the decision happened. `verify.ts` does not check
  `timestamp` on the log-only path (see T9), so such a record verifies CONFIRMED.
- **Demo:** yes, wherever an RPC omits `blockTime`.
- **Catchable:** mechanical. The type should be `bigint | null`, and a test with a null block time
  catches it.

#### T8. `tools/bulk.ts:588-590` with `tools/verify.ts:240-270`
- **Claims:** "VERDICT: CONFIRMED", "confirmed: 0", "empty export: no paid or refused charges in
  this scope", exit 0.
- **Knows:** that the file it was handed has no rows. It never asked the chain whether the scope is
  empty. An export that dropped every row, or a hand-written empty bundle, confirms.
- **Demo:** yes. Export a date range with no activity, verify it, get CONFIRMED.
- **Catchable:** judgment. Nothing mechanical objects to a true sentence about a file being
  presented as a sentence about the chain.

#### T9. `tools/verify.ts:173-185` with `206-228`
- **Claims:** "VERDICT: CONFIRMED", the record's `timestamp` printed in the list of confirmed
  fields, and the closing line "Mandate limits, ledger entry, and charge transaction agree."
- **Knows:** on the log-only path no ledger entry was read at all, and `timestamp` is compared
  against nothing (the logs carry no timestamp). A note is printed before the verdict, and the
  verdict's own closing sentence contradicts it.
- **Demo:** yes, after the ring wraps, which is the case this path exists for.
- **Catchable:** judgment. Every individual check is correct; the summary sentence is the claim.

#### T10. `tools/verify.ts:210`
- **Claims:** `cluster <name>` printed inside the CONFIRMED block, among fields that were checked.
- **Knows:** `cluster` is the only record field verify never checks. `genesis_hash` is the check
  (line 79-80), and `docs/DECISION_RECORD.md:58` says so, but the verdict formatting does not.
- **Demo:** yes, on every confirmed verify.
- **Catchable:** judgment.

#### T11. `tools/produce.ts:175-178`, `192-193`
- **Claims:** `paid amount=... tx=...`, `refused amount=... tx=...` on stderr, and `"paid"` and
  `"refused"` objects written into `tools/.local/produce.json`.
- **Knows:** only the two amounts it chose against the per-payment maximum it also chose. No log is
  parsed. If either charge decides differently, the labels are wrong and the file is what the demo
  beat is then exported from.
- **Demo:** yes. This is the documented producer (`README.md:218`).
- **Catchable:** mechanical. `parseChargeLogs` is imported into the same package already.

---

## app

#### A1. `app/app.config.js:8` with `app/lib/appConfig.ts:55-56`
- **Claims:** `explorerCluster` is the cluster, used to build every explorer link
  (`format.ts:84-94`) and stamped into every exported record and CSV header as `cluster`
  (`share.tsx:110`).
- **Knows:** nothing. It is `'devnet'` at build time and `'devnet'` again if that was empty. The app
  does read the genesis hash (`useChain.ts:156`) and never compares the two. The same default
  appears a third time at `(tabs)/index.tsx:25`, `(tabs)/decisions.tsx:23` and
  `decision/[id].tsx:27`, unreachable only because the config gate already failed by then.
- **Demo:** yes. An APK built for a local validator links every decision to the devnet explorer.
- **Catchable:** mechanical. The RPC's genesis hash is already in hand.

#### A2. `app/app.config.js:9` with `app/lib/appConfig.ts:26-29`
- **Claims:** `mintDecimals` scales every amount shown on every screen.
- **Knows:** `'6'` from the build, or `6` again from `parseDecimals('')`. No mint was read.
- **Demo:** yes, before or instead of A3's read.
- **Catchable:** mechanical.

#### A3. `app/lib/useChain.ts:148-153`, with the initial value at `:92`
- **Claims:** every amount on Overview, Decisions, Rule detail and the export is in tokens.
- **Knows:** when `fetchMintDecimals` throws, the configured or defaulted value is kept. The comment
  says "Keep the configured fallback rather than inventing an amount", but a wrong decimals count
  does invent the amount: a 9 decimal mint displayed at 6 reads a thousand times too large, and
  nothing on the screen says the mint was not read. The initial state is `6` before any read.
- **Demo:** yes. One failed `getMint` is enough.
- **Catchable:** mechanical. A test that fails the mint read and asserts the screen refuses to
  format, rather than formatting with a guess.

#### A4. `app/lib/useChain.ts:154-168`
- **Claims:** `genesisHash` identifies the chain the records were read from, and `share.tsx:99-101`
  refuses to export without it.
- **Knows:** it is only ever replaced on success (`if (genesis)`), never cleared. After the config
  is pointed at a different RPC and that read fails, the previous chain's genesis hash stays in
  state and is stamped into records from the new one.
- **Demo:** only across a config change in one session.
- **Catchable:** judgment. The guard reads as defensive; that is what makes it stale.

#### A5. `app/lib/chain.ts:326-336`, surfaced at `components/DecisionRow.tsx:105-109`
- **Claims:** "This RPC did not return a transaction signature for this row."
- **Knows:** `listSignatures` threw and the catch set `signatures = []`. "The RPC returned no
  signatures" and "the signature read failed" are the same empty array, and the copy asserts the
  first.
- **Demo:** yes, on a rate limit inside the signature read.
- **Catchable:** mechanical.

#### A6. `app/lib/chain.ts:372-400`
- **Claims:** ring rows are matched against the ledger's transaction history.
- **Knows:** at most four pages of fifty, so the newest 200 signatures. Older ring rows get
  `signature: null` and are then dropped from every export by `signedExportRows`.
- **Demo:** yes, on a busy ledger.
- **Catchable:** judgment. The cap is a deliberate cost control; nothing says the result is partial.

#### A7. `app/lib/ring.ts:113-149`, surfaced at `app/app/decision/[id].tsx:69-73` and `103-107`
- **Claims:** under a heading reading "Proof" and "anyone can check this against the chain", a row
  is labelled `transaction <signature>`.
- **Knows:** when the RPC gave no block time, the match is on kind, amount and nonce alone. The code
  comment says it outright: two refusals of the same charge share that key, and an evicted decision
  can still sit in the signature window. The screen presents the winner as this row's proof.
- **Demo:** yes, after a retried charge.
- **Catchable:** judgment, and the author already wrote the reasoning into the comment.

#### A8. `app/lib/events.ts:68`
- **Claims:** `suggestedOverride` decoded from a `Refused` log.
- **Knows:** the guard is `raw.length >= 73`, but a `Refused` event is exactly 65 bytes
  (8 discriminator, 32 mandate, 8 amount, 8 nonce, 1 reason, 8 override; see `lib.rs:573-579`).
  The condition is never true for a real event, so the decoded override is always `0n`. The sibling
  decoder `indexer/src/events.ts:54,62` uses 65 and is right.
- **Demo:** no. `attachSignatures` keeps only `signature` and `slot` from a decoded event, so the
  wrong zero never reaches a screen. It is a false value the code is currently lucky enough to
  discard.
- **Catchable:** mechanical. One fixture encoding a real refusal with a nonzero override.

#### A9. `app/lib/exportRecord.ts:151-153` and `216`, with `app/app/help/export.tsx:26-28`
- **Claims:** the bundle carries `completeness: "payments"` and a note saying it is complete over
  paid and refused charges that landed on chain. The help screen repeats it with no caveat.
- **Knows:** `signedExportRows` drops every row whose signature this phone could not attach, which
  by A5 and A6 includes rows the RPC failed on and rows older than 200 signatures. The share screen
  does disclose it (`share.tsx:188-190`); the file and the help screen do not, and the file is what
  travels.
- **Demo:** yes.
- **Catchable:** judgment. The omission is the honest behaviour; the completeness word on the file
  is the claim.

#### A10. `app/app/share.tsx:156-158` with `app/app/(tabs)/decisions.tsx:52-55`
- **Claims:** "Everything under this rule", "The complete record this phone can rebuild from the
  ring and logs", and on the Decisions tab "Export rebuilds the trail from transaction logs".
- **Knows:** the phone never reads logs for history. `fetchLedgerRows` decodes the 32 entry ring and
  attaches signatures to it. Rows evicted from the ring are simply absent from the export. The log
  rebuild exists, in `indexer/` and `tools/export.ts`, off the phone.
- **Demo:** yes, after the ring wraps, and the banner announcing the wrap is the very line that
  points at the export.
- **Catchable:** judgment.

#### A11. `app/components/RefusalCard.tsx:39-41`
- **Claims:** "Your rule held. No payment made.", in the largest type on the card, for every
  refusal.
- **Knows:** the reason code. For reason 7 (delegation withdrawn), 8 (insufficient funds) and 10
  (account frozen), the rule is not what stopped it: the owner's delegation, the balance or a freeze
  authority did. The why line below is per reason (handoff F1 fixed that), the headline is not.
- **Demo:** yes. Reason 7 is one revoke away and reason 8 one spend away.
- **Catchable:** judgment.

#### A12. `app/lib/wallet.ts:9`
- **Claims:** `MWA_CHAIN = 'solana:devnet'` is sent on every authorize (`wallet.ts:207-211`).
- **Knows:** the chain the app is actually pointed at is `config.rpcUrl`, which is required and
  unconstrained. The wallet is asked to authorize devnet whatever the app then reads and writes.
- **Demo:** yes, for any non-devnet build.
- **Catchable:** mechanical. Derive it from config, and a test asserts the two cannot disagree.

#### A13. `app/lib/wallet.ts:76-82`
- **Claims:** the owner public key.
- **Knows:** the encoding was guessed. The address is tried as base64 first and accepted if it
  decodes to 32 bytes, otherwise as base58. A base58 address that also happens to decode to 32
  bytes as base64 yields a different key, silently, and the app then reports no rule for that owner.
  `handoff.md` already records the test for this as flaky, which is the collision firing.
- **Demo:** yes, at a low probability per address.
- **Catchable:** mechanical, and the repo has the failing test already.

#### A14. `app/lib/useRulesets.ts:20-61`, surfaced at `app/app/(tabs)/rules.tsx:110-111`
- **Claims:** "No rulesets saved on this phone yet."
- **Knows:** the store read may have returned unparseable JSON or rows that failed the shape check,
  all of which become `[]`. Absent and unreadable are the same screen.
- **Demo:** yes, on a corrupt secure store entry.
- **Catchable:** mechanical.

#### A15. `app/lib/chain.ts:96-103`
- **Claims:** `fetchOwnerMandates` returns this owner's rules, and the Rules tab counts them
  ("3 rules, 3 agents", `rules.tsx:31-36`).
- **Knows:** every account that failed to decode was skipped. The comment explains the intended
  case (ledgers share the program id), but a mandate written by a newer program version is dropped
  by the same catch and the count still presents itself as complete.
- **Demo:** only across a program layout change.
- **Catchable:** judgment. Distinguishing "not a mandate" from "a mandate I cannot read" is the
  decision, and the catch erases it.

#### A16. `app/lib/ruleView.ts:40-53`, surfaced at `components/RuleListItem.tsx:39-41`
- **Claims:** a rule is labelled `expired`.
- **Knows:** `nowSec >= mandate.expiresAt` on the phone's clock. The on chain `status` may still be
  ACTIVE, and the chain decides by its own clock. A skewed device relabels a live rule.
- **Demo:** yes, on a device with a wrong clock.
- **Catchable:** judgment.

#### A17. `app/lib/useChain.ts:97` with `app/app/(tabs)/index.tsx:22`, `83-85`
- **Claims:** the "days left" tile and every `formatTimeLeft` value read as current.
- **Knows:** `nowMs` is set once per `refresh()` and never ticks. A screen left open overnight
  still shows yesterday's remaining time against a live expiry.
- **Demo:** yes, and the app is meant to be left open.
- **Catchable:** judgment.

---

## terminal (branch only: `feat/merchant-terminal`)

Counted because the task names the package. Not on `main` and not reachable from the shipped tree.

#### TM1. `terminal/src/config.ts:23-27`
- **Claims:** `explorerQuery` decides the cluster of every explorer link on the merchant screen
  (`page.ts:102-104`, `163`).
- **Knows:** whether the RPC url contains the substring "devnet" or "testnet". A private devnet
  endpoint whose hostname does not contain the word gets no cluster query at all, which is a
  mainnet explorer link for a devnet signature.
- **Demo:** branch only, and yes on that branch for any non-public RPC.
- **Catchable:** mechanical. The genesis hash is one call away on a connection the server already
  holds.

#### TM2. `terminal/src/server.ts:106-112` with `terminal/src/page.ts:164`
- **Claims:** the Balance row prints `<n> tokens`.
- **Knows:** on an RPC failure the snapshot keeps the previous balance
  (`balance: paymentsCache?.balance ?? null`) and the Balance row renders it with no qualifier. The
  payments list directly below does disclose the staleness ("The list below is from the last
  successful read at ...", `page.ts:92-94`); the balance does not.
- **Demo:** branch only.
- **Catchable:** mechanical, and the disclosure pattern already exists eight lines away.

#### TM3. `terminal/src/payments.ts:54` with `terminal/src/page.ts:96-97`
- **Claims:** "No payments received yet."
- **Knows:** `fetchPayments` looks at the last ten signatures on the merchant token account and
  skips any transaction the RPC returned `null` for. Eleven recent non-payment transactions push
  every payment out of the window, and the screen then asserts that none arrived while the Balance
  row above it shows a nonzero balance.
- **Demo:** branch only.
- **Catchable:** judgment. Ten is a fine page size; the sentence is what overreaches.

---

## scripts

#### S1. `scripts/devnet-setup.sh:589`
- **Claims:** `CLUSTER=devnet` written into `keys/devnet-addresses.env`.
- **Knows:** the script has `CLUSTER_NAME` (line 21) and ignores it here. `make localnet`
  (`Makefile:62-63`) sets `VETO_CLUSTER=localnet` and the file still says devnet. Every exported
  decision record's `cluster` field descends from this line (`tools/lib.ts:226`).
- **Demo:** yes, on the documented localnet path, which exists because the devnet faucet rate limits.
- **Catchable:** mechanical. Interpolate the variable that is already in scope.

#### S2. `scripts/devnet-setup.sh:253`, `255`, `272-276`, producing `docs/DEVNET.md:9`, `11`, `28-33`
- **Claims:** the generated document states "Name: `devnet`", "Explorer cluster query:
  `cluster=devnet`" and six explorer links with `?cluster=devnet`.
- **Knows:** the endpoint it was pointed at. `$RPC` is interpolated into the same document two lines
  above, so a localnet run produces a file that names the local RPC and calls it devnet, with links
  that resolve to nothing.
- **Demo:** yes, and the artifact is committed.
- **Catchable:** mechanical.

#### S3. `scripts/devnet-setup.sh:320`, producing `docs/DEVNET.md`'s recreate section
- **Claims:** the generated document says the script "Runs `anchor deploy --provider.cluster
  devnet`", and the "Exact commands" block (line 343) repeats it.
- **Knows:** line 471 passes `--provider.cluster "$RPC"`. The documented command is not the command
  run, and following the document verbatim on a localnet setup deploys to devnet.
- **Demo:** yes, for anyone recreating from the doc.
- **Catchable:** mechanical.

#### S4. `scripts/devnet-setup.sh:105-114`
- **Claims:** `lamports_of` returns a balance, used for the airdrop loop's exit condition and for
  "funded `<pk>` to `<n>` lamports" (line 155) and "agent already has `<n>` lamports" (line 547).
- **Knows:** `solana balance` failing prints nothing and the function answers `0`. A network error
  is reported as a zero balance, and the loop then airdrops against a key that may be funded.
- **Demo:** yes, and the devnet faucet path is exactly where transient failures live.
- **Catchable:** mechanical.

#### S5. `scripts/devnet-setup.sh:516-518`
- **Claims:** `owner_bal` is the owner's token balance, and line 537 prints "owner already funded
  (`<n>` tokens)".
- **Knows:** stderr is discarded and a failed read falls back to `'0'`, so one RPC hiccup mints
  another 1000000 tokens to an already funded account.
- **Demo:** yes.
- **Catchable:** mechanical.

#### S6. `scripts/devnet-setup.sh:550-583`
- **Claims:** "checking agent holds zero tokens", then "agent token total=`<n>`". The repo's
  invariant is that the agent holds no tokens (`docs/DEVNET.md`, README threat model).
- **Knows:** almost nothing. The python exits 2 when the total is positive, and `|| printf '0'`
  swallows that exit status and appends a `0` to the captured output, so the check can never fail
  the run; a failed or unparseable read also prints `0`. The line announces a check that has no
  consequence and a total that is `0` whenever the read did not work.
- **Demo:** yes, on every setup run.
- **Catchable:** mechanical. The script already uses `die` elsewhere (line 586 does it correctly for
  the executable bit).

#### S7. `scripts/watcher-service.sh:79`
- **Claims:** "process: running", as the status of this repo's watcher.
- **Knows:** `pgrep -f "dist/index.js run"` matched some process on this machine. A watcher from
  another checkout, or any process with that string in its command line, reports as this one.
- **Demo:** yes, with two worktrees, which is how this repo is being worked on.
- **Catchable:** mechanical. Match `${ROOT}/watcher/dist/index.js`, which the script already knows.

#### S8. `scripts/watcher-service.sh:80`
- **Claims:** `decisions: <n>`.
- **Knows:** the number of non-empty lines in the journal, which includes `gap` and `skipped` rows.
  `watcher/src/journal.ts:21-26` is explicit that a gap is not a decision. The one number an
  operator glances at to see whether the seven day history is accumulating overcounts it.
- **Demo:** yes, on every status check.
- **Catchable:** mechanical. `journal.counts()` already exists and is already wired to
  `veto-watcher status`.

---

## CI

#### C1. `.github/workflows/ci.yml:50-67`
- **Claims:** a green `app` check, next to `watcher`, `tools` and `indexer` jobs that each run
  `npm run typecheck` and `npm test`.
- **Knows:** the app job runs `npx tsc --noEmit` and nothing else. `app/package.json:9-11` defines
  both `lint` and a `test` script over thirteen test files, and CI invokes neither, so the tests
  covering refusal copy, read states, the export record and the config loader never run. The check
  reports the app as verified on the strength of a typecheck.
- **Demo:** yes, on every pull request.
- **Catchable:** mechanical, by comparing jobs in the same file.

---

## docs

#### D1. `watcher/README.md:57`
- **Claims:** the defaults table says the RPC default is `http://127.0.0.1:8999` and calls it
  "(the cluster recorded in `docs/DEVNET.md`)".
- **Knows:** `docs/DEVNET.md:10` records `https://api.devnet.solana.com`. The parenthetical is
  false about the very file it cites, and the rest of the same defaults block
  (`watcher/src/config.ts:11-17`) really is the devnet deploy, so the documented default is a
  devnet identity pointed at a local port.
- **Demo:** yes, for anyone following the README.
- **Catchable:** mechanical. One test asserting the documented default, the code default and
  `DEVNET.md` agree.

#### D2. `docs/DECISION_RECORD.md:58`
- **Claims:** the `cluster` field is a "Cluster name from DEVNET.md (`devnet` or `localnet`)".
- **Knows:** `localnet` is never produced. `scripts/devnet-setup.sh:589` writes `CLUSTER=devnet`
  unconditionally (S1), so the only value the pipeline can emit is `devnet`, including for a
  localnet deploy. The rest of that row is exemplary ("Hint for humans, not a proof") and is why
  this is a small defect rather than a large one.
- **Demo:** yes.
- **Catchable:** mechanical, once S1 is fixed the doc becomes true.

#### D3. `README.md:226-227`
- **Claims:** "Verify re-reads the cluster; it does not trust the file."
- **Knows:** verify re-reads the chain, which is a genuine and well built check
  (`verify.ts:79-80`, `97-172`). The record's own `cluster` field is the one thing it does trust,
  and it prints it inside the CONFIRMED block (T10). The sentence is the strongest version of a
  claim the code supports in a narrower form.
- **Demo:** yes, for a reader deciding what the verdict means.
- **Catchable:** judgment.

---

## What the counts mean

Sorted by shape rather than by package, the 42 mechanical instances are:

| Shape | Count | Sites |
|---|---|---|
| Chain identity or cluster label resolved to a constant | 12 | W1, W2, I1, I2, I3, I4, T1, T2, T3, A1, A2, A12 |
| Failed read turned into an empty, zero or default value | 13 | W7, W10, I11, T5, T6, T7, A3, A5, A14, S4, S5, S6, TM2 |
| Label written from an input instead of an observed outcome | 6 | I6, T11, S1, S2, S3, S8 |
| Identity guessed from a substring or a loose pattern | 4 | I7, A13, S7, TM1 |
| Local copy trusted over the thing it copies | 3 | W8, W9, I5 |
| A check that does not run, or a documented fact nothing binds | 3 | C1, D1, D2 |
| Wrong constant, catchable by one fixture | 1 | A8 |

The 24 judgment instances are, almost without exception, sentences: "Your rule held", "the complete
record", "matched exactly", "no payments received yet", "Mandate limits, ledger entry, and charge
transaction agree", "empty export: no paid or refused charges in this scope". They are not bugs in
the reading; they are claims made about the reading. Six of them sit on the export and verify path,
five on refusal or decision copy, and four on the watcher's journal, which is the evidence the whole
demo rests on.

Two conclusions follow for whatever fix comes next.

**A mechanical rule can carry two thirds of this, and only if it is written per shape.** A rule
against defaulted chain identities catches 11. It catches none of the 13 swallowed reads, none of
the 6 misapplied labels, and nothing at all in the shell, where five live and where no TypeScript
rule reaches. The fix needs at least four rules plus a test convention, not one.

**The remaining third cannot be automated and is where the product is.** The refusal card, the
decision record, the verifier's verdict and the merchant screen are the four surfaces a judge will
look at, and they hold eleven of the 24 judgment instances between them (P1, I10, T4, T8, T9, T10,
A7, A9, A10, A11, TM3). Those are fixed by reading
each user-visible sentence against what the code behind it actually observed, once, deliberately,
which is the pass this audit is. There is no lint for "this sentence is braver than the read behind
it".

One structural observation, offered because it explains the distribution rather than to widen the
scope: the same defect is repeatedly fixed in one package and left in the others. The feed
classification exists in `terminal` and not in `watcher/src/run.ts`. The defaults removal reached
`app` and, on an unmerged branch, `watcher`, while `indexer` and `tools` still resolve four
identities and a cluster name to constants. The 65 byte refusal event is decoded correctly in
`indexer` and incorrectly in `app`. The log parse that would make `produce.ts` and `seed.ts` honest
is already written, twice, in other packages. Six of the mechanical instances are a correct
implementation sitting one directory away from an incorrect one.

## Looked at and not counted

Recorded so the absence is a decision rather than an oversight.

- `watcher/src/index.ts:126-137` (`veto-watcher status` reporting the local journal): it prints the
  journal path first and names the file as its source, so it does not present local state as chain
  state.
- `app/lib/mandateRead.ts` and `app/components/ReadState.tsx`: the opposite of this defect class,
  and the reason several app screens are clean. `mayClaimAbsence` exists precisely to stop a failed
  read being rendered as an empty one.
- `app/app/(tabs)/index.tsx:83-84` (`left?.value ?? '0'`, `?? 'expired'`): a default, but the
  enclosing block requires `mandateStatus === 'present'` and a non-null mandate, so `left` cannot be
  null there.
- `watcher/src/parse.ts:38`: throws rather than defaulting when a confirmed transaction has neither
  log line. Correct behaviour; the defect is upstream at W7, where the logs may never have been
  read.
- `tools/bulk.ts:159-163`: throws on an empty counterparty from the indexer instead of exporting a
  blank. Correct, and it is what makes I7 survivable on the export path.
- `app/lib/templates.ts:89-93` (`assertTemplateIsEmptyStart`) and the template summaries: written
  specifically to stop a template implying history that does not exist.
- `docs/DECISION_RECORD.md:296-300` and `README.md:248-254`: both state the completeness limit
  accurately, including that nothing on chain can record an attempt the agent never made.
