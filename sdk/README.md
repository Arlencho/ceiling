# veto-agent-sdk

TypeScript client for one `charge` and for reading the mandate, the ledger, and the decisions. The package is not yet published ([issue 190](https://github.com/Arlencho/veto/issues/190)). Install it from this checkout. `watcher/` is the full reference agent.

Node 22 or newer.

```bash
cd sdk
npm ci
npx tsx examples/pay-once.ts <agent-key.json> <config.json> <amount-in-base-units>
```

The example prints kind, reason code, reason text, suggested override, signature, and slot.

## The block the app copies

On an active rule the app shows Connect your agent. Copy all and the QR are the same JSON. `loadAgentConfig` accepts that text or the parsed object. Every field is required. An extra field is refused.

```json
{
  "mandate": "<mandate address>",
  "programId": "<program id>",
  "mint": "<mint address>",
  "mintDecimals": 6,
  "sourceTokenAccount": "<rule token account>",
  "payeeTokenAccount": "<payee token account>",
  "agent": "<agent address>",
  "cluster": "devnet",
  "rpcUrl": "<rpc url>"
}
```

`cluster` is `devnet`, `testnet`, or `mainnet-beta`.

## What `VetoAgent.fromConfig` checks

```ts
import { Connection } from "@solana/web3.js";
import { loadAgentConfig, VetoAgent } from "veto-agent-sdk";

const config = loadAgentConfig(jsonText);
const veto = await VetoAgent.fromConfig(config, agentKeypair);
```

In this repo the import is from `../sdk/src/index.js` until the package is built and linked. `main` points at `./dist/index.js`, which exists after `npm run build`.

The checks, in order:

1. The agent key in the file matches `config.agent`.
2. The program is the id bundled in `sdk/idl/veto.json` (`3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`). A block whose `programId` differs is refused. A localnet build passes a different program id as `{ programId }` in the options argument. The bundled id is the pin. The option is the only other id accepted.
3. A `Connection` argument is the endpoint. When it is omitted, `config.rpcUrl` is opened. Whichever endpoint is used must report the genesis hash of `config.cluster`.
4. The mandate account is owned by that program. Its agent matches the agent key. Its mint and source token account match the block.
5. `mintDecimals` matches the decimals on the mint account, and that mint account is owned by the same token program as the source account.
6. `payeeTokenAccount` is the payee's associated token account for this mint when that account exists, otherwise the payee's only token account for the mint.

`charge` uses `nextNonce()` when the example asks for the next nonce. That is `last_nonce` plus one, or `overrideNonce` when an override is pending above `last_nonce`. It submits one `charge` and reads the decision in that transaction.

## Retrying after the owner grants an override

A charge above the per-payment maximum is refused with reason code 5. `last_nonce` does not advance, so that charge can be retried. The owner grants an override for one nonce and one amount. The mandate stores those as `override_nonce` and `override_amount`.

`status()` returns them as `overrideNonce` and `overrideAmount`. While `overrideNonce` is above `lastNonce`, `nextNonce()` returns `overrideNonce` instead of `last_nonce` plus one. Any paid charge at that pending override nonce clears the override, including a smaller charge that was already queued. An agent with other charges waiting sends the retry first. Charge the refused amount, and only after checking that it is at most `overrideAmount`. The amount must still fit in the remaining cap.

```ts
const refusedAmount = 12_000n;
const status = await veto.status();
if (status.overrideNonce > status.lastNonce && refusedAmount <= status.overrideAmount) {
  const outcome = await veto.charge({
    amount: refusedAmount,
    nonce: await veto.nextNonce(),
  });
}
```

Pass `guardPendingOverride: true` to `charge` to refuse locally when the nonce is a pending override and the amount differs from `overrideAmount`. Without that option the SDK sends the amount and nonce you give it, and the program decides.

## Reading decisions

`decisionsForMandate` reads one page of signatures for the mandate. It does not walk every transaction on a long-lived mandate. Each call returns the decisions on that page, `oldestSignature` (the oldest signature on the listing, including a failed or foreign signature), and `pageFull` (true when the listing returned a full page).

The decision array is ordered oldest first. Omit `limit` to take every decision on the page. `limit` takes the newest decisions, at most 1000, and never splits a transaction: the last transaction included comes back in full, so the array can be longer than `limit`. `before` starts at signatures older than the one you name. `until` stops before a signature, leaving it and anything older unread.

Transactions on the page are fetched a few at a time. A 429 from the RPC is retried with backoff.

To read older history, pass `before` set to `oldestSignature` from the previous page. Continue while `pageFull` is true. Stop when a page is not full. An empty decision array is not the end of the history: a page of failed or foreign signatures still carries that cursor.

```ts
const seen = [];
let before: string | undefined;
for (;;) {
  const page = await decisionsForMandate(connection, mandate, { before });
  seen.push(...page);
  if (!page.pageFull || page.oldestSignature === null) break;
  before = page.oldestSignature;
}
```

Do not pass `limit` on this walk. `limit` can stop before the end of the listing, and `oldestSignature` is still the oldest signature listed, so the next page would skip signatures `limit` left unread. After a limited page, continue from the signature of the oldest decision in that result.
