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

## Advisory purpose check

`purposeCheck` is optional. Pass it to `VetoAgent` (or to `fromConfig` in the options argument). It is an async function you write. The SDK does not call a model, and it does not ship one.

The function receives the rule's on-chain purpose, the amount in base units, the mint decimals, the payee (the mandate's merchant address), the mandate address, and the description you pass to `chargeWithPurposeCheck`. It returns `{ allow, reason }`.

`chargeWithPurposeCheck({ amount, nonce, description })` calls that function first.

When `allow` is true, the SDK submits `charge` the same way `charge()` does. The program still enforces every number: the cap, the per-payment maximum, the nonce, expiry, the merchant, the delegation, and the rest. A purpose check cannot raise a limit.

When `allow` is not true, the SDK does not submit `charge`. It sends one transaction to the SPL Memo program `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`. The agent key signs that transaction and pays the fee. The mandate address is included as a read-only account and does not sign. That memo program accepts the mandate in the account list without a signature. The other memo program requires every account on the instruction to sign, so it cannot name the mandate this way. The memo text is `veto-advisory:v1` followed by compact JSON with `mandate`, `amount`, `nonce`, `reason`, and `description_sha256`. `reason` is at most 256 UTF-8 bytes, cut on a character boundary, then JSON-escaped. `description_sha256` is the hex sha256 of the description. The call returns `{ kind: "advisory_declined", reason, signature }`.

That record is the agent's own decision. It is not a program refusal. `verify` does not treat it as a decision. An advisory decline does not advance `last_nonce`: the program never sees the charge, so that nonce can still be charged later.

Whoever runs the agent can skip the check. `charge()` never calls `purposeCheck`, even when one is set.

`decisionsForMandate` returns an advisory record (`kind: "advisory_declined"`) only when the transaction succeeded, the memo is signed by the mandate's agent key, the memo names that mandate as a read-only non-signer, and the text parses as `veto-advisory:v1`. `reasonText` is `Agent declined (advisory)`. The memo's reason is `advisoryReason`. A stranger's memo that names the mandate is ignored. A memo that does not parse is ignored. Neither one is a decision, and neither one changes the page cursor: `oldestSignature` and `pageFull` still describe the signature listing.

`examples/purpose-check.ts` is one such check. It posts the context to the HTTP endpoint in `PURPOSE_CHECK_URL` and expects `{ "allow": boolean, "reason": string }`. If the endpoint errors, or the body is not that shape, the check declines.

```bash
PURPOSE_CHECK_URL=<endpoint> npx tsx examples/purpose-check.ts <agent-key.json> <mandate> <amount> "<description>"
```

`VETO_RPC` overrides the endpoint. When it is unset, the example uses `https://api.devnet.solana.com`.

## Reading decisions

`decisionsForMandate` reads one page of signatures for the mandate. It does not walk every transaction on a long-lived mandate. Each call returns the decisions on that page, `oldestSignature` (the oldest signature on the listing, including a failed or foreign signature), and `pageFull` (true when the listing returned a full page).

The decision array is ordered oldest first. Omit `limit` to take every decision on the page. `limit` takes the newest decisions, at most 1000, and never splits a transaction: the last transaction included comes back in full, so the array can be longer than `limit`. `before` starts at signatures older than the one you name. `until` stops before a signature, leaving it and anything older unread.

The signature listing is one request. Transaction reads then run one at a time by default, 1000 ms after the previous RPC read (`concurrency` is how many of those reads run together). A 429 is tried up to 4 times with capped exponential backoff and jitter: the ceiling starts at 200 ms, doubles, and never exceeds 2000 ms, and the built-in wait is between half that ceiling and the ceiling. With neither `readConnection` nor `connectionConfig`, the SDK opens its own connection from the caller's endpoint and commitment and sets `disableRetryOnRateLimit`, so the web3 client does not retry the same 429.

web3.js does not expose a connection's config, so a caller with custom headers, fetch, middleware or agent passes `connectionConfig` once or passes its own `readConnection` built with `disableRetryOnRateLimit: true`. `connectionConfig` (headers, fetch, middleware, agent, websocket endpoint) is merged with the caller's endpoint and commitment, and the connection opened for these reads sets `disableRetryOnRateLimit`. A `readConnection` is used as given.

```ts
const page = await decisionsForMandate(connection, mandate, {
  connectionConfig: { httpHeaders: { "x-read-key": "<read key>" } },
});
```

To read older history, pass `before` set to `oldestSignature` from the previous page. Continue while `pageFull` is true. Stop when a page is not full. An empty decision array is not the end of the history: a page of failed or foreign signatures still carries that cursor. A listed signature whose `getTransaction` returns null raises `MissingListedTransactionError` instead of dropping that signature.

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
