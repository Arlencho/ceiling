# Veto history indexer

Rebuilds the full Paid and Refused trail from transaction logs. The on-chain
ledger is a 32-entry ring. That ring is the authoritative recent window. Four
decisions a day stay inside it for a week. The 33rd entry overwrites the oldest,
so longer history has to come from the logs.

This package is a library the export tool calls, plus a CLI. The app does not
import it.

It does not assume the ring is complete. It does not invent rows for missing
signatures.

## What it reads

1. `getSignaturesForAddress` on the program, paginated with `before`.
2. Each confirmed transaction's `Program data:` logs, decoded as Anchor `Paid`
   and `Refused` events.
3. The charge instruction's destination account, which is the counterparty the
   ring stores for those kinds.

When `getSignaturesForAddress` returns an empty first page, the indexer scans
retained blocks instead (`allowBlockScan` defaults on in the library and the
CLI). Public Solana RPC has a signature index, and that is the path the CLI
uses when the page is not empty. `tools/export.ts` passes block scan through
only when `--block-scan` is set.

Opened, override and revoked ring rows have no `Paid`/`Refused` event. They
are not synthesized.

## Setup

Node 22 or newer.

```bash
cd indexer
npm ci
npm test
npm run typecheck
```

RPC and program id must be set (environment, `indexer/.env`,
`keys/devnet-addresses.env`, or `--rpc` / `--program`). There is no built-in
endpoint or program. Addresses come from `keys/devnet-addresses.env` (public
only). Keypairs for the seed script stay under gitignored `keys/`. Copy
`.env.example` to `indexer/.env` and uncomment the identity lines with values
you supply. The placeholders do not resolve.

`VETO_RPC` (and `--rpc`) is one URL or a comma-separated list. First is tried
first. A dedicated endpoint belongs first; the public cluster URL from
`docs/DEVNET.md` can sit after it as fallback. On HTTP 429 the indexer backs
off, tries the next URL, and logs that it was rate limited rather than that
the read failed.

## Seed a mandate when the watcher is not running

Opens a fresh mandate and submits one paid charge and several refused charges
so pagination can be exercised.

```bash
# program and token fixtures must already exist (`make setup`)
npm run seed
```

Prints the mandate PDA, ledger PDA, and signatures. Re-running without
`VETO_MANDATE_ID` picks a new id.

## CLI

Table (default):

```bash
npx tsx src/cli.ts --rpc "$VETO_RPC" --mandate <MANDATE_PDA>
```

JSON (for export):

```bash
npx tsx src/cli.ts --json --mandate <MANDATE_PDA>
```

Compare overlapping ring entries with the indexer (fails the process if they
diverge on amount, nonce, counterparty, kind, reason or suggested override):

```bash
npx tsx src/cli.ts --compare --page-size 2 --mandate <MANDATE_PDA>
```

`--page-size 2` forces more than one signature page when the RPC indexes
signatures. On a test validator the CLI reports that it scanned slots instead.

Library:

The package is private and unpublished. `main` is `./dist/index.js`, which
exists after `npm run build`. In-repo callers import the source, as
`tools/export.ts` does:

```ts
import { fetchDecisionHistory } from "../indexer/src/index.js";
```

`fetchLedgerRing` and `compareRingToHistory` are on the same module. The bare
specifier `veto-indexer` does not resolve from a fresh clone.

Amounts are `bigint` in the library and decimal strings in JSON. Never floats.
