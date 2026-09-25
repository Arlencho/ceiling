# veto-loadtest-gen

Synthetic transaction generator for indexer load tests. It emits transactions
in exactly the shape the indexer consumes (the `TxView` type in
`indexer/src/types.ts`): signature, slot, blockTime, logs, accountKeys and
compiled instructions. Log frames use real `Program <id> invoke` / `success`
lines, Paid and Refused events carry real Anchor event bytes built with the
discriminators from `indexer/idl/veto.json`, and `open_mandate` and
`grant_override` instructions carry real borsh encoded argument data behind
their IDL discriminators.

## Usage

```
npm install
npm run gen -- --agents 8 --rules 3 --transactions 10000 --seed 7 --out batch.ndjson
```

Output is newline-delimited JSON, one `TxView` per line. Instruction data is
base58 encoded, which the indexer accepts via `decodeIxData`.

Options (all optional):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--agents` | 4 | number of agents |
| `--rules` | 2 | rule profiles per agent, one mandate each |
| `--transactions` | 100 | charge and override transactions to emit |
| `--paid` | 70 | mix weight for paid charges |
| `--refused` | 25 | mix weight for refused charges |
| `--override` | 5 | mix weight for grant_override calls |
| `--seed` | 1 | deterministic seed |
| `--start-slot` | 250000000 | slot of the first transaction |
| `--start-time` | fixed | blockTime of the first transaction, unix seconds |
| `--out` | stdout | write to a file instead of stdout |

The mix weights are relative: `--paid 60 --refused 30 --override 10` yields
about 60 percent paid, 30 percent refused and 10 percent overrides. A batch
always starts with one `open_mandate` transaction per agent per rule, followed
by `--transactions` decision transactions spread across the mandates. The same
flags and seed always produce a byte-identical batch.

## Test

```
npm ci --prefix ../../../indexer   # the test decodes with indexer/src/events.ts
npm test
npm run typecheck
```

The test decodes a generated batch with the indexer decoder (imported
read-only) and asserts every event decodes to the intended kind, reason and
amount.
