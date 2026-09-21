# Veto history indexer

Rebuilds the full Paid and Refused trail from transaction logs. The on-chain
ledger is a 32-entry ring. That ring is the authoritative recent window. A week
of decisions will wrap it, so seven-day history has to come from the logs.

This package is a library the app and the export tool can call, plus a CLI.

It does not assume the ring is complete. It does not invent rows for missing
signatures.

## What it reads

1. `getSignaturesForAddress` on the program, paginated with `before`.
2. Each confirmed transaction's `Program data:` logs, decoded as Anchor `Paid`
   and `Refused` events.
3. The charge instruction's destination account, which is the counterparty the
   ring stores for those kinds.

If the RPC's signature index is empty (Agave 4.1.2 `solana-test-validator`
returns `[]` here), the indexer scans retained blocks instead. That fallback
is how a local cluster can still prove the decoder. Public Solana RPC has a
real signature index, and that is the path the CLI prefers.

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

Addresses come from `keys/devnet-addresses.env` (public only). Keypairs for
the seed script stay under gitignored `keys/`. See `.env.example`.

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

JSON (for the app / export):

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

```ts
import { fetchDecisionHistory, fetchLedgerRing, compareRingToHistory } from "veto-indexer";
```

Amounts are `bigint` in the library and decimal strings in JSON. Never floats.
