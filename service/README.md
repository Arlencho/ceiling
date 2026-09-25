# Instruction decoding

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

## Recorded devnet fixtures

```sh
npm run record-fixtures --prefix service
```

The executable recorder uses `VETO_RPC` when set, otherwise the public Solana devnet RPC. It never writes or prints the endpoint. Requests are sequential with a bounded exponential back-off and a timeout. Transaction files use their signatures as names. `accounts.json` contains the program account snapshot with its context slot; `manifest.json` lists the signatures and completion time. The snapshot is captured first and history is bounded by that slot. During a download, `capture.json` preserves that boundary and the signature list across retries. Once the manifest exists, subsequent runs leave the capture unchanged. Interrupted transaction downloads can resume from saved files; the temporary capture checkpoint is removed on completion.

Tests are offline. They check that each successful lifecycle instruction produces a record, each successful charge produces Paid or Refused, and surviving mandate fields agree with account bytes. For each surviving ledger they compare total history length and the last 32 entries, including counts per kind, charge amounts, nonces, destinations, reasons, and suggested overrides. Close removes both accounts, so no surviving ledger can independently attest a close count. Its recorded instruction count is checked separately; synthetic tests cover kinds absent from the live capture.
