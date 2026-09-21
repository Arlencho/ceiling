## Built

Closed the five review findings on PR 62. Branch `feat/app-fleet-console`. Nothing else.

- F1. Refusal copy follows `row.reason`. The per-payment sentence is only for reason 5. An override line and the raise-per-payment block appear only for that reason.
- F2. The Decisions tab no longer puts one date over the whole list. Rows group by local day, each group under its own heading.
- F3. After three rate-limit retries the app stops claiming it is still trying. `rateLimited` is cleared, the error is "The RPC rate limited this read three times. Pull to retry.", and the read lands in `failed`.
- F4. Rule detail, decision detail, and share wait for a completed chain read before claiming a rule or decision is absent. A decision is only taken from the ring of the rule named in its id.
- F5. Rule detail compares a purpose stamp to the ruleset on this phone: matches, limits differ, or no ruleset with this stamp. Opening a rule rejects a typed stamp suffix unless the owner is applying a saved ruleset. Copy still does not claim the ruleset file is on chain.

## Decisions

- Extracted `refusalWhyLine` so the card and the tests share one sentence.
- Override copy is withheld for every reason that an override cannot clear, even if `suggestedOverride` is nonzero.
- Rate-limit exhaustion reuses `failed` rather than adding a sixth read state.
- Stamp check is phone-local (cap, per-payment max, payee). A reader without this phone cannot check that match, and the detail screen says so.

## Do not repeat

- Do not reorder `app/index.js` polyfill imports.
- Do not hardcode an RPC url or program id.
- Do not invent rows, prices, or kWh.
- Do not claim a ruleset is on chain. Only the purpose stamp is.
- Do not touch `programs/veto/src`.
- Do not style a refusal as an error.
- `lib/wallet.test.ts` `publicKeyFromMwaAddress accepts a base58 address` can fail on a random keypair whose base58 also decodes as 32-byte base64. Pre-existing. Not part of these five findings.

## Evidence

F1, unfixed why-line (perTxMax in hand, amount 50, limit 60):

```
reason 1 "Asked for 50, over the 60 per-payment maximum. No override would have cleared this."
reason 2 same
reason 5 same
reason 6 same
```

F1, after the fix:

```
reason 1 "mandate not active."
reason 5 "Asked for 50, over the 60 per-payment maximum. No override would have cleared this."
reason 6 "over remaining cap."
```

From `app/`:

- `npx tsc --noEmit`: exit 0
- `npm test`: 71 pass, 0 fail (one earlier full run hit the pre-existing wallet base58 flake, then 71/71)
- `npx expo lint`: exit 0
- `npx expo config --type public`: `platforms: ['android']`, `android.package: com.veto.app`, `extra.vetoRpc: ''`, `extra.vetoProgramId: ''`, splash and adaptive icon `#0F1A16`

## Open questions

- Live Seeker / MWA open-mandate and share sheet still need a device.
- The wallet base58 address test is flaky. Out of scope for this round.

## Next hint

PR 62 against `main` on `feat/app-fleet-console`. Issues 47, 51, 52, 55, 56, 59 stay open for QA.
