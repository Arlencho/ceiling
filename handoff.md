## Built

Closed the four round-1 findings on PR 76. Nothing else.

- F1: `watcher/src/chain.ts` `connect` copies the indexer seed shape. If `idl.address` differs from `cfg.programId`, the IDL is rewritten before `new Program`. The critic fixture `watcher/src/chain.critic.test.ts` is unchanged and green.
- F2: `watcher/.env.example` and `indexer/.env.example` carry commented placeholders that name each identity and show its shape. Copying them into a searched `.env` does not resolve an endpoint, program id, mint or account. READMEs say to uncomment and supply values.
- F3: `docs/DECISION_RECORD.md` documents tools RPC as `--rpc`, then `VETO_RPC`, then `keys/devnet-addresses.env` `RPC=`, then exit naming `VETO_RPC`. No public endpoint in that order.
- F4: `indexer/src/seed.ts` skips a missing addresses file (same as the other loaders) and lets `required` name `VETO_RPC`.

No shared directory, no branded type, `programs/veto/src` untouched, critic fixture not edited.

## Decisions

- Mutate `idl.address` the way `indexer/src/seed.ts` already does, rather than a second Program constructor.
- Leave process defaults in the watcher example (journal path, mandate id, volume, decimals, keys dir). They cannot select a chain identity.

## Do not repeat

- Do not restore `http://127.0.0.1:8999`, `https://api.devnet.solana.com`, or `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV` as active example values or as a tools fallback.
- Do not edit `watcher/src/chain.critic.test.ts`.
- Do not `readFileSync` the addresses file in seed before `required` has a chance to name the variable.

## Evidence

Critic fixture red on unfixed `connect` (b718877):

```
cd watcher && npm test -- src/chain.critic.test.ts
```

- `the program the watcher signs against is the configured VETO_PROGRAM_ID, not the bundled IDL address`
- actual `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`, expected `11111111111111111111111111111111`

After the product change, same file: 37 pass, 0 fail.

Seed with `env -i PATH=... VETO_KEYS_DIR=/nonexistent/keys`:

- before: `ENOENT: no such file or directory, open '/nonexistent/keys/devnet-addresses.env'`
- after: `config.loadConfig: missing VETO_RPC; set it in the environment, keys/devnet-addresses.env, indexer/.env` exit 1

Copy of each `.env.example` into a searched env file, empty keys dir:

- watcher `loadConfig`: `missing VETO_RPC`
- indexer `requiredIdentity('VETO_RPC')`: `missing VETO_RPC`
- indexer `requiredIdentity('VETO_PROGRAM_ID')`: `missing VETO_PROGRAM_ID`
- watcher example active lines: `VETO_KEYS_DIR`, `VETO_JOURNAL`, `VETO_MANDATE_ID`, `VETO_KWH_MILLI`, `VETO_MINT_DECIMALS`
- indexer example active lines: none

Suites after the four fixes:

| Package | `npm test` | typecheck |
|---|---|---|
| watcher | 37 pass, 0 fail | `tsc --noEmit` exit 0 |
| indexer | 22 pass, 0 fail | `tsc --noEmit` exit 0 |
| tools | 34 pass, 0 fail | `tsc --noEmit` exit 0 |
| app | 103 pass, 0 fail | `npx tsc --noEmit` exit 0 |

## Open questions

None for this round.

## Next hint

PR 76 on `fix/no-defaulted-identities`. Four findings closed. Leave the issue open for QA if one is filed.
