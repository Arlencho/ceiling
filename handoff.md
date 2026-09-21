## Built

Removed defaulted chain identities from watcher, indexer and tools, and closed the two app defects named in the plan.

- Watcher `loadConfig` throws `missing VETO_RPC` (and the other identity keys) when the environment and documented env files are silent. Volume, cap, per-payment max, mandate id, decimals and purpose stay as process defaults; they cannot select an endpoint, program, mint or account.
- Indexer CLI, seed and `fetchDecisionHistory` require a program id. `DEFAULT_RPC` and `DEFAULT_PROGRAM_ID` are gone.
- Tools `resolveRpc` and `resolveProgramId` throw naming `VETO_RPC` / `VETO_PROGRAM_ID`. Cluster label still defaults to `devnet` (a label, not an identity). SPL Token program id stays as the well-known constant.
- `app/lib/wallet.ts`: an unreadable agent secret or agents map is reported (`could not read the stored agent identity`) and is not overwritten or replaced by a newly minted key.
- `app/lib/chain.ts`: a failed signature listing throws (`Failed to list ledger signatures`) instead of becoming `[]`, so override confirmation cannot fall through to nonce and amount matching on a list it never read.

No shared directory, no branded type, no lint allowlist, `programs/veto/src` untouched.

## Decisions

- Port the throwing `required(env, files, key)` shape from `c41c088` into each package, not a shared module. The two critics on `assess/invariant` rejected branded `Configured<N>` and a vendored `shared/` directory.
- Keep last-write-wins file merge. Do not add the volume-disagreement check from the terminal branch; that would change how config is combined.
- Keep the nonce/amount fallback in `grantOverride` for a listing that actually returned. The defect is treating a failed listing as empty.

## Do not repeat

- Do not restore `DEFAULT_RPC`, `DEFAULT_PROGRAM_ID`, or the watcher `DEFAULTS` block.
- Do not introduce `shared/`, `Configured<N>`, or an allowlist.
- Do not treat a failed store parse as an empty store. Absent is mintable; unreadable is not.
- Do not catch `listSignatures` into `[]`. Empty and unread are different.
- Tests that need an identity must pass one. Do not put the old constants back to make a test green.

## Evidence

Red on unfixed code, from `app/`:

```
npx tsx --experimental-test-module-mocks --test lib/wallet.test.ts lib/chain.listing.test.ts
```

- `an unreadable agent secret is reported and is not replaced by a newly minted identity`: `Missing expected rejection`
- `an unreadable agents map is reported and is not overwritten`: `Missing expected rejection`
- `a failed signature listing is not treated as an empty list, so override confirmation does not name a row by nonce and amount`: `Missing expected rejection`

After the product change, same file pair: 18 pass, 0 fail.

Package suites and typecheck:

| Package | `npm test` | typecheck |
|---|---|---|
| watcher | 36 pass, 0 fail | `tsc --noEmit` exit 0 |
| indexer | 22 pass, 0 fail | `tsc --noEmit` exit 0 |
| tools | 34 pass, 0 fail | `tsc --noEmit` exit 0 |
| app | 103 pass, 0 fail | `npx tsc --noEmit` exit 0 |

Entry points with no identity configured (`VETO_KEYS_DIR` pointing at a missing dir, identity vars unset):

- watcher `status`: `config.loadConfig: missing VETO_RPC; set it in the environment, keys/devnet-addresses.env, watcher/.env` exit 1
- indexer CLI: `config.loadConfig: missing VETO_RPC; set it in the environment, keys/devnet-addresses.env, indexer/.env` exit 1
- tools `export.ts --signature x`: `lib.resolveRpc: missing VETO_RPC; set it in the environment, keys/devnet-addresses.env, or pass --rpc` exit 1

## Open questions

- Cluster label `devnet` in `resolveClusterName` is still a default. It is a label, not an endpoint or account. T3 in the audit is a separate genesis-hash check.

## Next hint

Branch `fix/no-defaulted-identities`. PR against `main`. Leave the issue open for QA if one is filed.
