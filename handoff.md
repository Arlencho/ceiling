## Built

Closed the remaining round 2 finding on PR 69 (`feat/app-override`) without touching `programs/veto/src` and without editing the critic fixture in `f4a2d0a`.

- A failed override probe is no longer stored under the live probe key. The skip that avoids a second chain read on a same-state refresh only applies to a probe that returned a result.
- The blocked copy ("Pull to retry") still shows after a failed read. A later refresh with the same row and mandate fields issues the read the copy promises.
- The two F3 regression checks still pass: a successful probe is not re-read on a same-state refresh, and a moved `last_nonce` still re-probes.

## Decisions

- Keep the field-keyed skip for results. That is the F3 close the previous review confirmed.
- Hold a failed read in separate state so the screen can show the blocked copy without making `overrideProbeIsCurrent` true.

## Do not repeat

- Do not cache a thrown probe under the live key. The owner was told to pull to retry.
- Do not edit `app/lib/useOverrideGrant.test.ts` or `app/lib/overrideGrant.test.ts`.
- Do not undo the guard-before-already order, the `isActive` clock path, or the field-keyed success skip.
- Do not touch `programs/veto/src`.
- `react-test-renderer` is a devDependency in `app/package.json` and in `app/package-lock.json`. `npm ci` in `app/` must keep installing it or the app job and the hook fixture break.

## Evidence

Red on unfixed `f4a2d0a`, from `app/`:

```
npx tsx --experimental-test-module-mocks --test lib/useOverrideGrant.test.ts
```

- `CRITIC F3: after a failed probe, a refresh that reads the same state back must re-probe, because the copy says "Pull to retry"`
  `AssertionError: the pull the owner was told to do must issue the read it promised` (`1 !== 2`)
- `regression F3: after a successful probe, a refresh that reads the same state back does not re-probe`: pass
- `regression F3: a refresh that shows the chain moved on does re-probe`: pass

After the product change, from `app/`:

- same file: 3 pass, 0 fail
- `npx tsc --noEmit`: exit 0
- `npx expo lint`: exit 0
- `npm test`: 95 pass, 0 fail
- `npx expo config --type public`: `platforms: ['android']`, `android.package: com.veto.app`, `extra.vetoRpc: ''`, `extra.vetoProgramId: ''`
- `npm ci`: exit 0
- `npm ls react-test-renderer --depth=0`: `react-test-renderer@19.2.3`

No Seeker run. `grant_override` via Mobile Wallet Adapter still has to be signed on device.

## Open questions

- Live Seeker path: grant from a per-payment refusal, then watcher retry of the same nonce, then the four-step record on Decisions.

## Next hint

Branch `feat/app-override`. PR 69 against `main` for issue 16. Leave 16 open for QA.
