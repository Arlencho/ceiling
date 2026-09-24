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

`charge` reads `last_nonce` for the next nonce when the example asks for it, submits one `charge`, and reads the decision in that transaction.
