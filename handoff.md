## Built

Closed the four review findings on PR 69 (`feat/app-override`) without touching `programs/veto/src`.

- F1: `assessOverride` runs `overrideGuard` before the already-granted branch. An expired or exhausted rule with a pending waiver is `blocked` and does not say the agent can retry.
- F2: `overrideGuard` and `assessOverride` take `nowSec`. Clock expiry uses `isActive` from `lib/mandate.ts` and the existing expired-on-chain sentence. `probeOverride` and `grantOverride` pass the current unix time.
- F3: the live probe keys on row and mandate fields (plus an `isActive` clock bit), not object identity. A refresh that rebuilds the same accounts returns before a second chain read.
- F4: grant state and the probe effect live in `lib/useOverrideGrant.ts`. The detail screen calls the hook. `OverrideGrant` takes the view plus decimals.

The two critic tests were recreated first and were red on `bfc78d3` (`status 3 must be blocked, got already`; `expired by the clock must be blocked`, actual true). They are green after the product change. Two probe-key tests lock F3.

## Decisions

- Guard first, then already. A live pending waiver still returns `already` and can retry. A dead rule cannot.
- Reuse `isActive` for the clock question. Do not add a second expiry helper.
- Probe skip is `overrideProbeIsCurrent` on the string key. The key's clock bit flips from live to expired so a later refresh can block without depending on object identity.
- Grant UI state is a hook, not five `useState`s on the screen.

## Do not repeat

- Do not touch `programs/veto/src`.
- Do not offer a grant for a reason the program writes `suggested_override = 0` for.
- Do not claim success from the wallet signature alone. The ledger row is the proof.
- Do not promise a retry when `evaluate` will refuse on status or expiry.
- Do not depend on `row` / `mandate` object identity for the live probe.
- Do not weaken the critic tests. They were red on `bfc78d3` with the quoted assertions.
- `lib/wallet.test.ts` `publicKeyFromMwaAddress accepts a base58 address` can fail on a random keypair whose base58 also decodes as 32-byte base64. Pre-existing.

## Evidence

Red on unfixed `bfc78d3`, from `app/`:

```
npx tsx --test lib/override.test.ts
```

- `CRITIC: an already-granted override on a rule that is not active must not claim the agent can retry`
  `AssertionError: status 3 must be blocked, got already`
- `CRITIC: a rule past its expiry by the clock is not offered an override, because the retry cannot clear`
  `AssertionError: expired by the clock must be blocked` (actual true, expected false)

After the fix, from `app/`:

- `npx tsc --noEmit`: exit 0
- `npx expo lint`: exit 0
- `npm test`: 89 pass, 0 fail
- `npx expo config --type public`: `platforms: ['android']`, `android.package: com.veto.app`, `extra.vetoRpc: ''`, `extra.vetoProgramId: ''`

No Seeker run. `grant_override` via Mobile Wallet Adapter still has to be signed on device.

## Open questions

- Live Seeker path: grant from a per-payment refusal, then watcher retry of the same nonce, then the four-step record on Decisions.

## Next hint

Branch `feat/app-override`. PR 69 against `main` for issue 16. Leave 16 open for QA.
