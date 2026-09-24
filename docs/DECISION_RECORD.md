# Decision record

A Veto decision, paid or refused, as JSON. Anyone with an RPC can re-read the
chain and say yes or no. That is the ten-second beat: the refusal is not a
story we tell, it is a file you can check from a laptop that is not the phone.

A single record is one answer. A bulk file is the population: a date range, or
everything under one rule. Same fields, one row per decision, each with its own
transaction signature.

This is not a W3C VC profile, not a signing ceremony, and not a hosted verifier.
The chain is the verifier. `tools/verify.ts` is a client of that chain.

Schema version 1 is the stable export. Field names are snake_case. Amounts,
timestamps and nonces are integers (mint base units, unix seconds). No floats.

## Record

```json
{
  "schema_version": 1,
  "cluster": "devnet",
  "genesis_hash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "program_id": "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  "mandate": "CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g",
  "limits": {
    "cap": 100000000,
    "per_tx_max": 500000,
    "expires_at": 1797713870,
    "merchant": "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG",
    "purpose": "SE3 home charging"
  },
  "kind": "refused",
  "amount": 6232500,
  "counterparty": "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  "timestamp": 1789937892,
  "nonce": 1789920000,
  "reason_code": 5,
  "reason_text": "over per-payment maximum",
  "suggested_override": 6232500,
  "signature": "3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib"
}
```

That object is a live export from public Solana devnet (the cluster in
[DEVNET.md](DEVNET.md)): mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g`
(SE3 home charging), refused at 6232500 because it broke the 500000
per-payment maximum. `tools/verify.ts` confirmed it against
`https://api.devnet.solana.com`. The signature is the refused `charge` the
README links for 2026-09-20 evening.

## Fields

Every field below is read from the chain. The export did not add a field to the
program. Devnet is upgradeable under the deployer key in [DEVNET.md](DEVNET.md).
Setting the mainnet upgrade authority to none stays the intent in the README
threat model. This program is not deployed on mainnet.

| Field | JSON type | On-chain source |
|---|---|---|
| `schema_version` | integer | This document. Always `1` for this shape. |
| `cluster` | string | Cluster the genesis hash belongs to: `mainnet-beta`, `devnet`, `testnet`, or `localnet` for any other hash. Verify rejects a label that names a different cluster. |
| `genesis_hash` | string | `getGenesisHash`. Pins the record to one chain so a copy-paste from another cluster fails verify. |
| `program_id` | string | The program invoked by the transaction, which must match `declare_id` / [DEVNET.md](DEVNET.md). |
| `mandate` | string | Mandate PDA. Seeds: `["mandate", owner, mandate_id_le_bytes]`. |
| `limits.cap` | integer | Mandate account. Total that may ever be spent, base units. Set at open, never raised. |
| `limits.per_tx_max` | integer | Mandate account. Largest single payment, base units. Set at open. |
| `limits.expires_at` | integer | Mandate account. Unix seconds after which nothing may be spent. Set at open. |
| `limits.merchant` | string | Mandate account. The only wallet that may receive funds. Set at open. |
| `limits.purpose` | string | Mandate account. Owner's words, at most 64 characters, immutable after open. Stored, not semantically enforced. |
| `kind` | string | Ledger entry `kind`: `paid` (1) or `refused` (2). Open / override / revoke entries are not this export. |
| `amount` | integer | Ledger entry `amount`, base units. |
| `counterparty` | string | Ledger entry `counterparty`. For a charge this is the **destination token account**, not the merchant wallet. |
| `timestamp` | integer | Ledger entry `ts`. `Clock::get().unix_timestamp` at the instruction, not the JSON export time. |
| `nonce` | integer | Ledger entry `nonce`. Paid charges advance `last_nonce`; a refused charge can retry the same nonce after an override. |
| `reason_code` | integer | Ledger entry `reason`. `0` on a paid charge. |
| `reason_text` | string | The program's `reason_text` for that code (table below). Verify rejects a mismatched string. |
| `suggested_override` | integer | Ledger entry `suggested_override`. One-shot amount that would clear this exact charge, or `0` when none would. An override raises the per-payment ceiling only, never the cap. |
| `signature` | string | Transaction signature of the `charge` that wrote this entry. **Not stored in the ledger account.** Recovered from cluster transaction history (see below). |

`kind` and `nonce` are not in the original one-line pitch list. They are in the
schema because a refusal can share a nonce with a later retry, and because paid
versus refused is the whole product. Export always writes them. Verify requires
them.

### Reason codes

Same mapping the program logs. Zero means the charge was allowed.

| Code | `reason_text` |
|---|---|
| 0 | ok |
| 1 | mandate not active |
| 2 | past expiry |
| 3 | nonce already settled |
| 4 | merchant not allowed |
| 5 | over per-payment maximum |
| 6 | over remaining cap |
| 7 | delegation withdrawn |
| 8 | insufficient funds |
| 9 | zero amount |
| 10 | account frozen |

Any other code is `unknown`. Verify rejects `unknown` on a genuine record,
because the deployed program does not emit one.

### Limits agreed in advance

`cap`, `per_tx_max`, `expires_at`, `merchant` and `purpose` are written once in
`open_mandate` and the program has no instruction that changes them. `spent`,
`status`, `last_nonce`, `override_*` and the counters do change after a
decision. They are not in this record: they are current state, not the prior
claim.

The mandate is the prior claim. The ledger entry is the evidence. Neither is
worth anything alone, which is why both are in the file.

### Counterparty

`charge` writes `destination.key()` into the ledger, and `destination` is a
token account. `open_mandate` / `grant_override` / `revoke_mandate` write the
merchant **wallet**. This export only covers paid and refused charges, so
`counterparty` is the destination token account. Verify checks that this
account's owner equals `limits.merchant`.

## Signature recovery

The ledger ring does not store a transaction signature. The export did not add
a field for it.

Export recovers the signature by fetching the transaction (`--signature`) or,
for `--mandate`, by scanning `getSignaturesForAddress` on the program and
rebuilding the Paid and Refused events from the transaction logs, keeping the
rows for that mandate. The indexer does that scan. Ledger matching happens
after, on amount, nonce, and kind.

That depends on the cluster retaining transaction history:

- Public Solana devnet does.
- Current `solana-test-validator` serves transaction history by default. The
  old `--enable-rpc-transaction-history` flag is not in `solana-test-validator
  --help` on solana-cli 4.1.2. Retention is bounded by `--limit-ledger-size`.
  Once the ledger prunes past the slot, `getTransaction` returns null, and
  verify says the signature was not checked rather than pretending it was.

If the 32-entry ring has wrapped past this decision, the ledger account no
longer holds the row. Export from `--signature` still works: the transaction,
its logs, and the mandate account are enough. Verify then confirms the
transaction and the limits, and reports that the ring no longer contains the
row.

Bulk export does not use the ring as the population. It calls the indexer
library (`indexer/src/history.ts`), which rebuilds Paid and Refused events from
transaction logs. A range longer than the 32-entry window would otherwise be
silently incomplete. The ring is still read when it still holds a matching row,
so timestamps on recent decisions match the on-chain entry verify checks.

## What the chain does not have

Documented here so nobody adds them to the program.

- A binding of the owner key to a legal person, a device, or Seed Vault.
- Proof that the agent had no other spending path (a burner, a second mandate,
  a direct owner transfer).
- A record of a charge the agent never submitted. Nothing on chain can provide
  that.
- A human-readable merchant name. The chain has a pubkey.
- Token decimals and a unit name. Decimals live on the mint account, not on the
  mandate. This record speaks base units only.
- The signature, inside the ledger account. See above.

## Verify

`tools/verify.ts` takes the JSON, talks to an RPC you name, and prints a
verdict. It does not trust the RPC URL inside the record (there isn't one) and
it does not trust `reason_text` without checking it against the code table.

It confirms, independently:

1. `getGenesisHash` matches `genesis_hash`, and `cluster` is the cluster that
   hash belongs to (`mainnet-beta`, `devnet`, `testnet`, or `localnet`).
2. `getTransaction(signature)` exists, succeeded (`err` is null), and invoked
   program `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`, the address in
   `tools/idl/veto.json`, unless `--program-id` or `VETO_PROGRAM_ID` names
   another deployment. `keys/devnet-addresses.env` is not read. The
   `program_id` in the file is not trusted. A confirmed record prints
   `checked against program <id> (<source>)`, where the source is `flag`,
   `VETO_PROGRAM_ID`, or `idl`.
3. The `charge` instruction amount and nonce match the record. A transaction
   with more than one charge is bound by mandate, nonce, and amount. Export
   of that signature needs `--mandate`, `--nonce`, and `--amount` together.
4. The mandate named in the transaction matches `mandate`, and its
   `cap` / `per_tx_max` / `expires_at` / `merchant` / `purpose` match `limits`.
   Limits come from the live account when that account is the opening that
   covers the signature. When the live account is a later opening, or the
   account is closed, limits come from the `open_mandate` whose tenure
   contains the signature. A closed account prints `mandate account is closed
   and the limits came from the opening transaction`.
5. The ledger PDA derived from the mandate still holds a matching row (amount,
   nonce, kind, reason, suggested override, counterparty, timestamp), unless
   the ring has wrapped, in which case the transaction logs must match and the
   wrap is printed.
6. The destination token account owner is `limits.merchant`.
7. `reason_text` is exactly the canonical string for `reason_code`.

Any mismatch prints `VERDICT: REJECTED` and a line per failure, exit status 1.
A genuine record prints `VERDICT: CONFIRMED` and exit status 0.

A bulk JSON bundle or CSV is checked the same way, one row at a time. The
verdict names how many rows were confirmed and lists every row that was not,
with the signature and the reason. Exit 0 only when every row confirms and
the envelope matches the chain. A tampered amount on one row rejects that
row and leaves the others confirmed.

The envelope `program_id`, `genesis_hash`, and `cluster` are checked against
the chain, not copied from the file. Every row must carry the same values.
When `scope.mandate` is set, every row's `mandate` must equal it. For a rule
scope, verify walks that mandate's ledger and rejects the file unless every
paid row and every refused row on the ledger appears once. The paid count
must equal `spend_count` and the refused count must equal `refusal_count`.
For a date_range scope, verify rebuilds the population with the indexer over
that same range (and that mandate, when one is named) and rejects the file
unless the signature set matches. A row whose timestamp is outside that
range is a failure, even when the row itself is genuine. A date_range with
no mandate is every charge on the program in that range. A date-range log
that ends with `Log truncated` fails the file. The bulk verdict prints the scope,
program, cluster, mandate, and range it checked. A missing row is a reject.
An RPC transport error prints `verify failed` and no verdict, and exits 3.
A listed signature whose `getTransaction` returns null is `was not checked`
and the process exits 3. On a bulk file the line names the row that was not checked.
A listed successful transaction that invokes the program and comes back with
`logMessages` null is the same kind of gap: the run was not checked and exits 3,
and the line names that signature. A null log body is not an empty log.

RPC, in order: `--rpc`, then `VETO_RPC`, then `keys/devnet-addresses.env`
`RPC=`. If none of those is set, the tool exits and names `VETO_RPC`. There
is no built-in endpoint.

The recorded cluster for this repo is public Solana devnet. The RPC is
`https://api.devnet.solana.com`, as listed in [DEVNET.md](DEVNET.md). Verify
against that cluster. A record from another genesis will not confirm.

## Commands

From a machine that is not the phone. Node 22 or newer (the indexer declares
`engines.node` of `>=22`, and export loads it). Keypairs are only
needed to **produce** a decision, never to export or verify one.

```bash
# Indexer first: bulk export loads it as a library (bs58 and the log decoder).
cd indexer && npm ci
cd ../tools && npm ci

# One paid charge and one refused charge against a fresh mandate.
# Uses gitignored keys/ from scripts/devnet-setup.sh.
VETO_RPC=https://api.devnet.solana.com npx tsx produce.ts

# JSON for one decision, by signature. A transaction with more than one
# charge also needs --mandate, --nonce, and --amount.
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature <tx> --out refused.json
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature <tx> --mandate <mandate> --nonce <nonce> --amount <amount> --out one.json

# Everything under one rule, or a UTC date range. JSON default, or CSV.
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --mandate <mandate> --out rule.json
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --mandate <mandate> --format csv --out rule.csv
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --from 2026-09-20 --to 2026-09-21 --mandate <mandate> --out day.json

# Re-read the chain. Confirm a genuine file, reject a tampered one.
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts refused.json
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts rule.json
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts rule.csv
```

Write the file with `--out`, then pass that path to `verify.ts`. After
`close_mandate` removes the account, export still writes the decision. Limits
come from the opening transaction that covered the signature, and the tool
prints `mandate account is closed and the limits came from the opening transaction`.

`produce.ts` creates a fresh keypair as its source token account
(`SystemProgram.createAccount`), mints into that account, and opens the mandate
against it. It does not replace the SPL delegate on the demo owner associated
token account that the watcher charges.

`--kind paid` or `--kind refused` is an optional filter on a bulk export. The
default includes both. Refused rows are never dropped unless you ask.

## Bulk JSON

Schema version 1, extended with a `decisions` array. Each element is a full
single-decision record as documented above, including `signature`. The envelope
states the honest limit on itself:

```json
{
  "schema_version": 1,
  "completeness": "payments",
  "completeness_note": "Complete over paid and refused charges that landed on chain. Never complete over attempts. A charge the agent never submitted cannot appear here, and this file does not invent rows for missing signatures.",
  "cluster": "devnet",
  "genesis_hash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "program_id": "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  "scope": {
    "type": "rule",
    "mandate": "CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g",
    "from": null,
    "to": null
  },
  "decisions": [
    {
      "schema_version": 1,
      "cluster": "devnet",
      "genesis_hash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      "program_id": "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
      "mandate": "CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g",
      "limits": {
        "cap": 100000000,
        "per_tx_max": 500000,
        "expires_at": 1797713870,
        "merchant": "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG",
        "purpose": "SE3 home charging"
      },
      "kind": "paid",
      "amount": 446000,
      "counterparty": "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
      "timestamp": 1789937883,
      "nonce": 1789855200,
      "reason_code": 0,
      "reason_text": "ok",
      "suggested_override": 0,
      "signature": "4N13AokSVj2A9fJyCZiypzhG9P6mdpMvpjcnDvzVUi2Qp6jUx1Ud34tHUDt1TQENzXu7TFWTfrKHHCLfrpKTBJ9a"
    }
  ]
}
```

That envelope is one row of a live export from public Solana devnet (mandate
`CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g`). A fresh export of that mandate
prints `export 9 decision(s)`: three paid and six refused. `tools/verify.ts`
on that file prints `confirmed: 9`, `rejected: 0`, and
`spend_count=3 refusal_count=6`. Changing one refused amount to `1` rejects
that row. It does not print `confirmed: 4` or `rejected: 1`. The ledger line
stays `spend_count=3 refusal_count=6`.

`scope.type` is `rule` (everything under that mandate) or `date_range` (`from`
and/or `to` as unix seconds, inclusive). A date range may also name a mandate.
`--from 2026-09-20` is 00:00:00 UTC that day. `--to 2026-09-20` is 23:59:59 UTC
that day. Unix integers are used as-is.

`completeness` is always `payments`. Verify rejects any other value. The record
is complete over paid and refused charges that landed on chain. It is never
complete over attempts: a charge the agent never submitted cannot appear, and
the exporter does not invent a row for a gap in a range. An empty scope is an
empty `decisions` array, still with `completeness=payments`.

A bare JSON array is not this schema. Completeness has to live on the file.

## CSV columns

CSV is the same population for a spreadsheet. Comment lines at the top repeat
the completeness limit and the scope so a file with zero data rows still states
them. The header row is:

| Column | Meaning |
|---|---|
| `completeness` | Always `payments`. Same honest limit as the JSON envelope. |
| `scope_type` | `rule` or `date_range`. |
| `scope_mandate` | Mandate pubkey, empty when the range covers every rule. |
| `scope_from` | Inclusive unix seconds, empty if unbounded. |
| `scope_to` | Inclusive unix seconds, empty if unbounded. |
| `schema_version` | `1` |
| `cluster` | Same as the JSON field. |
| `genesis_hash` | Same as the JSON field. |
| `program_id` | Same as the JSON field. |
| `mandate` | Mandate PDA for this row. |
| `limits_cap` | Mandate cap, base units. |
| `limits_per_tx_max` | Mandate per-payment maximum, base units. |
| `limits_expires_at` | Mandate expiry, unix seconds. |
| `limits_merchant` | Mandate merchant wallet. |
| `limits_purpose` | Mandate purpose string. Quoted if it contains a comma. |
| `kind` | `paid` or `refused`. |
| `amount` | Base units. |
| `counterparty` | Destination token account. |
| `timestamp` | Unix seconds. |
| `nonce` | Charge nonce. |
| `reason_code` | Integer reason. `0` on a paid charge. |
| `reason_text` | Canonical string for that code. |
| `suggested_override` | Base units, or `0`. |
| `signature` | Transaction signature of this charge. Every row has one. |

`tools/verify.ts` accepts this CSV as well as the JSON bundle.

## Out of scope

- Changing `programs/veto`. If a field is not on chain, it is listed above.
- A hosted verifier, an app server, or a QR that resolves to our infrastructure.
- A signing ceremony around the JSON. The transaction already signed.
- W3C VC types, `@context`, proofs, or any envelope that replaces the chain
  as the thing you check.
