# Decision record

A single Veto decision, paid or refused, as JSON. Anyone with an RPC can re-read
the chain and say yes or no. That is the ten-second beat: the refusal is not a
story we tell, it is a file you can check from a laptop that is not the phone.

This is not a W3C VC profile, not a signing ceremony, and not a hosted verifier.
The chain is the verifier. `tools/verify.ts` is a client of that chain.

Schema version 1 is the stable export. Field names are snake_case. Amounts,
timestamps and nonces are integers (mint base units, unix seconds). No floats.

## Record

```json
{
  "schema_version": 1,
  "cluster": "devnet",
  "genesis_hash": "5NrLCg7BRzhkDYxbiDy966tfYmVPfpprZamwXLALe3L5",
  "program_id": "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  "mandate": "GLrnmrCEVa7fLawwFtFJ8D91Nvv3WMTKweiM9xKdx6RS",
  "limits": {
    "cap": 500000000,
    "per_tx_max": 60000000,
    "expires_at": 1792465618,
    "merchant": "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG",
    "purpose": "charging"
  },
  "kind": "refused",
  "amount": 180000000,
  "counterparty": "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  "timestamp": 1789873620,
  "nonce": 2,
  "reason_code": 5,
  "reason_text": "over per-payment maximum",
  "suggested_override": 180000000,
  "signature": "5j6QCeKUFeu5FcAgePUp9xqyLMkTUF3C6ocoA8MWQbUuBZJhK8ZhewnivkWfK3eN1M8CDeDbEXxUmWXqL8zwj6Ls"
}
```

That object is a live export from 2026-09-20: mandate opened, one charge paid
at 50000000, one refused at 180000000 because it broke the 60000000
per-payment maximum. `tools/verify.ts` confirmed it against the cluster in
[DEVNET.md](DEVNET.md). The signature is the refused `charge`.

## Fields

Every field below is read from the chain. The program is frozen: nothing was
added to it for this export.

| Field | JSON type | On-chain source |
|---|---|---|
| `schema_version` | integer | This document. Always `1` for this shape. |
| `cluster` | string | Cluster name from [DEVNET.md](DEVNET.md) (`devnet` or `localnet`). Hint for humans, not a proof. |
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

The ledger ring does not store a transaction signature. The program is frozen,
so this file does not invent a new field for it.

Export recovers the signature by fetching the transaction (`--signature`) or by
scanning `getSignaturesForAddress` on the mandate until it finds the `charge`
whose amount, nonce and kind match the ledger entry (`--mandate`).

That depends on the cluster retaining transaction history:

- Public Solana devnet does.
- `solana-test-validator` only does if started with
  `--enable-rpc-transaction-history`. Without that flag, `getTransaction` works
  for a short recent window and then returns null. Verify then rejects, honestly,
  rather than pretending the signature was checked.

If the 32-entry ring has wrapped past this decision, the ledger account no
longer holds the row. Export from `--signature` still works: the transaction,
its logs, and the mandate account are enough. Verify then confirms the
transaction and the limits, and reports that the ring no longer contains the
row.

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

1. `getGenesisHash` matches `genesis_hash`.
2. `getTransaction(signature)` exists, succeeded (`err` is null), and invoked
   this `program_id`.
3. The `charge` instruction amount and nonce match the record.
4. The mandate account in that transaction matches `mandate`, and its
   `cap` / `per_tx_max` / `expires_at` / `merchant` / `purpose` match `limits`.
5. The ledger PDA derived from the mandate still holds a matching row (amount,
   nonce, kind, reason, suggested override, counterparty, timestamp), unless
   the ring has wrapped, in which case the transaction logs must match and the
   wrap is printed.
6. The destination token account owner is `limits.merchant`.
7. `reason_text` is exactly the canonical string for `reason_code`.

Any mismatch prints `VERDICT: REJECTED` and a line per failure, exit status 1.
A genuine record prints `VERDICT: CONFIRMED` and exit status 0.

Default RPC, in order: `--rpc`, then `VETO_RPC`, then
`keys/devnet-addresses.env` `RPC=`, then `https://api.devnet.solana.com`.

The recorded cluster for this repo is the RPC in [DEVNET.md](DEVNET.md). Public
`https://api.devnet.solana.com` is a different genesis. Verify against the
cluster that actually ran the transaction.

## Commands

From a machine that is not the phone. Node 20 or newer. Keypairs are only
needed to **produce** a decision, never to export or verify one.

```bash
cd tools
npm ci

# One paid charge and one refused charge against a fresh mandate.
# Uses gitignored keys/ from scripts/devnet-setup.sh.
npx tsx produce.ts

# JSON for one decision, by signature or by mandate.
npx tsx export.ts --signature <tx>
npx tsx export.ts --mandate <mandate> --kind refused
npx tsx export.ts --signature <tx> --out refused.json

# Re-read the chain. Confirm a genuine file, reject a tampered one.
npx tsx verify.ts refused.json
npx tsx export.ts --signature <tx> | npx tsx verify.ts
```

`produce.ts` opens its own source token account so it does not replace the SPL
delegate on the demo owner ATA that the watcher uses.

## Out of scope

- Changing `programs/veto`. If a field is not on chain, it is listed above.
- A hosted verifier, an app server, or a QR that resolves to our infrastructure.
- A signing ceremony around the JSON. The transaction already signed.
- W3C VC types, `@context`, proofs, or any envelope that replaces the chain
  as the thing you check.
