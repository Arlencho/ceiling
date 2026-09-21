## Built

Override flow for issue 16 on `feat/app-override`, on top of the fleet console now on `main`.

A refused decision that names a suggested override offers granting it as one action. The owner sees what they are about to sign, signs once through Seed Vault, and the result is read back from the ledger as `kind = override`. That row is listed and styled with the same weight as a payment and a refusal. It is never hidden and never rendered as a settings change.

A refusal for any reason the program records no override for offers no action and says why. An exhausted total cap (reason 6, or a per-payment refusal whose suggested amount is 0) says an override cannot raise the cap because the program will not accept one.

Before the action is offered, the mandate is re-read on chain. A revoked rule and a settled nonce each block the grant and say so. Success is claimed only after the override row is present on the ledger.

The record of one nonce can be read afterwards: asked, refused, waived by the owner, then paid.

## Decisions

- Eligibility follows `suggested_override` in `programs/veto/src/lib.rs`: only reason 5 (over per-payment maximum) with a positive suggestion. Amount and nonce for `grant_override` are that suggestion and the refused nonce. No second reason or kind table.
- Live guards match the program: status must be active, `nonce > last_nonce`, amount `<= remaining`. Revoked is called out. Exhausted and a remaining cap below the amount reuse the cap sentence.
- Override rows are listed decisions (`isListedDecision`), not exportable charges. Export stays complete over paid and refused only.
- Confirmation is a second step on the decision, not a settings screen. After sign, `fetchMandate` + `fetchLedgerRows` must produce an override row or the app reports that it will not invent one.

## Do not repeat

- Do not touch `programs/veto/src`.
- Do not offer a grant for a reason the program writes `suggested_override = 0` for, even if a stale UI still shows an amount.
- Do not claim success from the wallet signature alone. The ledger row is the proof.
- Do not render an override as a rule edit, a limit change, or a settings row.
- Do not reorder `app/index.js` polyfill imports.
- Do not hardcode an RPC url or program id.
- `lib/wallet.test.ts` `publicKeyFromMwaAddress accepts a base58 address` can fail on a random keypair whose base58 also decodes as 32-byte base64. Pre-existing.

## Evidence

`grant_override` in `programs/veto/src/lib.rs` takes `(amount, nonce)`, requires active status, `nonce > last_nonce`, `amount <= remaining`, writes `KIND_OVERRIDE` with `REASON_OK`.

From `app/`:

- `npx tsc --noEmit`: exit 0
- `npx expo lint`: exit 0
- `npm test`: 85 pass, 0 fail
- `npx expo config --type public`: `platforms: ['android']`, `android.package: com.veto.app`, `extra.vetoRpc: ''`, `extra.vetoProgramId: ''`

Pure tests covering reasons, revoked rule, settled nonce, override row copy, and asked/refused/waived/paid sequence: `lib/override.test.ts`.

No Seeker run. `grant_override` via MWA still has to be signed on device.

## Open questions

- Live Seeker path: grant from a per-payment refusal, then watcher retry of the same nonce, then the four-step record on Decisions.

## Next hint

Branch `feat/app-override`. PR against `main` for issue 16. Leave 16 open for QA.
