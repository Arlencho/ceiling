# veto-index

Node 22 ESM package for the Postgres 16 decision index. Numeric token amounts,
nonces and counters stay exact; `pg` returns numeric and bigint columns as strings.
The grade function accepts bigint counters and Unix-second timestamps.

## Development and tests

Run from `service/`, with Docker available:

```sh
npm ci
npm ci --ignore-scripts --prefix ../app
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export PGHOST=localhost PGPORT=55432 PGUSER=veto PGDATABASE=veto_index
export PGPASSWORD="$POSTGRES_PASSWORD"
docker compose up -d --wait
npm run migrate
npm run lint
npm test
npm run build
docker compose down -v
```

Tests require a disposable database: they truncate index tables. The Compose
database uses ephemeral storage and a loopback port. The service CI job uses this
same real Postgres setup, including partitions, constraints, locks and rollback.
A supplied Postgres 16 database also works through standard `PG*` variables.
App dependencies are needed only to load the actual grade module for parity tests.

## Transactions and storage

Use `transaction(tx => insertDecision(tx, row))`. `insertDecision` requires an
active READ COMMITTED transaction on a dedicated client, never a pool directly.
It returns false for duplicate identities, including delivery through another
source or with another timestamp. Use inner index `-1` for a top-level instruction.
`reverseDecision(row)` owns its transaction, or use `reverseDecision(tx, row)`
inside a caller-owned transaction. Reversing a missing identity returns false.
Cursor changes can be made on that same client before committing.

Postgres 16 cannot enforce a partitioned primary key that excludes the partition
column. `decision_keys` enforces the requested global primary key
`(signature, instruction_index, inner_index)`. `decisions` has a physical primary
key that also includes `block_time`, with a foreign key to the identity and its
canonical timestamp. This prevents duplicates across monthly partitions even for
direct SQL writes. UTC month partitions are created transactionally on demand,
including backfills. The migration runner is transactional, serialized and checks
migration checksums; the compiled build includes the SQL files.

Ingestion writers serialize on one transaction advisory lock. Each write
reclassifies only the decisions that share its rule and nonce, found through
the `decisions_rule_nonce` index, then applies only their differences to rule
and agent stats. Timestamp and slot extrema move incrementally: an insert
raises or lowers them in place, and a reversal rescans an extreme only when
the removed row held it. Insert cost stays flat as rule history grows; the
performance test inserts 5,000 decisions into one rule and checks the last
500 against the first 500 and both against a clean replay. Only use these
functions for decision writes so deltas and statistics remain consistent.
Rule addresses identify immutable on-chain ownership and agent associations.

An allowance suppresses every payment with its nonce in the same rule. Every
refusal counts outside; allowances count outside only if that nonce has no refusal.
Each delta stores the decision's current contribution, including reclassification
when a sibling arrives or disappears. Reversal subtracts the saved contribution,
deletes the decision and delta, and reclassifies surviving siblings. It works in
any removal order. Timestamp extrema are recalculated from surviving history;
empty stats rows remain with zero counters and null extrema. `updated_at` records
the latest change rather than being restored on reversal. `first_ts` is retained
in addition to `first_open_ts` for the app's fallback day-count rule.

The caller populates `rules` from decoded rule account state. Ingesting a decision
does not invent missing mint, cap or lifecycle account state. Cursors are likewise
advanced by the caller after the corresponding batch has been persisted.

## Integration seams with the decoder

`src/boundary.ts` converts a decoded `Location` into the ingest row's identity
fields. Three representations differ between the decoder and the index:

- `block_time`: `getTransaction` can return a null `blockTime`, but
  `block_time` is the partition column and cannot be null. The caller resolves
  the slot's block time (`getBlockTime` or a block header) and passes it to
  `ingestLocation` as `slotTime`; a record with neither timestamp is refused
  rather than stored under a fabricated time. A separate unpartitioned table
  was rejected: an untimed row would still need counters and extrema
  participation, duplicating the delta and reversal machinery for a case the
  slot's own time answers exactly.
- `inner_index`: the decoder uses `null` for a top-level instruction; the
  index stores `-1` (the `inner_index` column is a non-null integer with a
  `>= -1` check). `ingestLocation` converts at the boundary.
- `slot`: the decoder reports a number; the index stores the string form so
  `bigint` round-trips stay exact. `ingestLocation` stringifies it.

## Instruction decoding

The package name is `veto-index`. Install both this package and the existing event parser's dependencies from the repository root:

```sh
npm ci --prefix indexer
npm ci --prefix service
npm test --prefix service
npm run typecheck --prefix service
npm run build --prefix service
```

`src/decode/index.ts` exports `decodeTransaction`, `transactionInstructions`, the devnet `PROGRAM_ID`, and the record types. Input is the result of `getTransaction` with `encoding: "json"` and `maxSupportedTransactionVersion: 0`. Legacy and versioned transactions, top level instructions, and inner instructions are supported. Records retain the signature, slot, timestamp, and instruction location. All 64-bit fields use `bigint`; callers must stringify them explicitly when producing JSON.

Instruction discriminators and account positions come from `indexer/idl/veto.json`. The four lifecycle kinds are `open_mandate`, `grant_override`, `revoke_mandate`, and `close_mandate`. Paid and Refused records use the existing `indexer/src/events.ts` parser, including its historical text-log fallback and numeric and readable reasons. Failed transactions and transactions without metadata produce no committed records. Recognized malformed instructions or charge instructions without matching decisions raise an error, so an indexer cannot silently report complete history from truncated logs.

### Recorded devnet fixtures

```sh
npm run record-fixtures --prefix service
```

The executable recorder uses `VETO_RPC` when set, otherwise the public Solana devnet RPC. It never writes or prints the endpoint. Requests are sequential with a bounded exponential back-off and a timeout. Transaction files use their signatures as names. `accounts.json` contains the program account snapshot with its context slot; `manifest.json` lists the signatures and completion time. The snapshot is captured first and history is bounded by that slot. During a download, `capture.json` preserves that boundary and the signature list across retries. Once the manifest exists, subsequent runs leave the capture unchanged. Interrupted transaction downloads can resume from saved files; the temporary capture checkpoint is removed on completion.

Tests are offline. They check that each successful lifecycle instruction produces a record, each successful charge produces Paid or Refused, and surviving mandate fields agree with account bytes. For each surviving ledger they compare total history length and the last 32 entries, including counts per kind, charge amounts, nonces, destinations, reasons, and suggested overrides. Close removes both accounts, so no surviving ledger can independently attest a close count. Its recorded instruction count is checked separately; synthetic tests cover kinds absent from the live capture.
