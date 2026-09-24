# Veto Android app

Expo custom-dev-client app for a Solana Seeker. Android only. Expo Go cannot
load Mobile Wallet Adapter native modules, so this project is built as a
custom dev client APK.

Do not add an iOS or web target.

## Headless checks

From this directory:

```bash
npm run typecheck
npx expo config
npm test
```

`npm test` runs the pure module tests (wallet, templates, reason text, ring
decode, amount formatting, config, ruleset apply, purpose stamping, export
scope, read states). They do not need a device. Mobile Wallet Adapter
`authorize` and the Seed Vault signature for `open_mandate` /
`grant_override` / `revoke_mandate` still have to be checked on a Seeker.

## Devnet journey

From the repo root:

```bash
make e2e-devnet
```

That runs `app/e2e/devnetJourney.test.ts` with `VETO_E2E=1`. Without that
variable the file skips, so `npm test` does not talk to a cluster. The target
installs `app`, `sdk`, `indexer`, and `tools`, then drives devnet.

It needs `keys/deployer.json` (gitignored). That key is the mint authority for
the demo mint in `docs/DEVNET.md`. The run generates a fresh owner and a fresh
agent, funds the owner with SOL and that mint, and funds the agent with SOL
for fees. The payee is the merchant already on devnet.

Owner transactions go through `openMandate`, `grantOverride`, `revokeMandate`,
`closeMandate`, `readRuleFunds`, and `probeOverride`, signed by a keypair
stand-in for the Mobile Wallet Adapter `signAndSendTransactions` interface.
Charges go through `veto-agent-sdk`. Each step is checked against token
balances, delegates, account existence, ledger rows, and events. Every charge
is then exported with `tools/export.ts` and checked with `tools/verify.ts`.

The run prints a summary table and writes the same table to
`app/e2e/last-run.md`. This does not replace the Seeker check above. Seed
Vault is still required for a signature on a device.

## Sign-in

Connect runs `transact`, then `authorize`, against the Seed Vault wallet through
Mobile Wallet Adapter. The owner public key is shown truncated. The
authorization token is stored in `expo-secure-store` so a returning user is not
prompted again. Disconnect deauthorizes that token and clears it.

When the new rule screen leaves the agent address empty, the phone generates
an agent keypair with `@solana/web3.js` and stores it in `expo-secure-store`.
A filled address is the public key of an agent that runs elsewhere, and this
phone does not store a secret for it. The agent is a different key from the
owner. It holds authority and no funds. The owner private key is never written
to storage.

## Owner screens

Three tabs, all Android. Share is an action on a decision. Revoke is an
action on a rule. Neither is a tab. Help is reachable from every tab.

- **Overview.** Which rule first, then spent against cap, paid and refused
  counts, time left, then today. A refusal is the inverted block: "Your
  rule held. No payment made." Never styled as an error.
- **Rules.** Every rule the owner holds, each with purpose, spent against
  cap, time left, its own agent key, and its state. Switching one makes
  Overview and Decisions about it. Templates still prefill a blank form
  and never ship history or prices. A ruleset is authored on the phone;
  applying one to a new agent is one action. The ruleset itself is not on
  chain. Its name and version are written into the purpose, which is.
- **Decisions.** Every paid, refused, and override row under the selected
  rule, with the reason in plain language. Ordinary rows say "Paid within
  rule". A refusal that names a suggested override offers granting it as
  one action, after a live check that the rule is still active and the
  nonce still unsettled. The owner sees what they are about to sign. The
  result is read back from chain as its own kind of decision, never as a
  settings change. A charge blocked by the total cap offers nothing and
  says an override cannot raise the cap. The payee lives on the rule, not
  as an unlabelled address on the row. A transaction signature, when
  present, is labelled as a transaction. Share is the full-width primary
  action on a paid or refused decision, never an overflow menu.

Export offers three scopes (this decision, a date range, everything under
this rule) and two shapes (CSV with the documented columns, JSON as in
`docs/DECISION_RECORD.md`). The file states the honest limit: complete
over payments, never over attempts.

A rate-limited RPC read is its own state and says so. It is not a stalled
fetch and it is not an absence of a rule.

Chain reads and writes live in `lib/`. RPC url and program id come from config
(`EXPO_PUBLIC_VETO_*` via `app.config.js` extra). The app does not hardcode an
RPC url.

## Cluster config

Copy `app/.env.example` to `app/.env` (gitignored) and fill the values from
`docs/DEVNET.md` / `keys/devnet-addresses.env`. Restart Metro after changing
them.

```bash
cd app
cp .env.example .env
```

Required:

- `EXPO_PUBLIC_VETO_RPC` (the cluster RPC, never committed as a default)
- `EXPO_PUBLIC_VETO_PROGRAM_ID`
- `EXPO_PUBLIC_VETO_MINT` (needed to open a mandate)

Optional:

- `EXPO_PUBLIC_VETO_EXPLORER_CLUSTER` (default `devnet`)
- `EXPO_PUBLIC_VETO_MINT_DECIMALS` (fallback if the mint account cannot be read)

## Connect an agent

The rule screen copies one JSON block and shows the same block as a QR code
while the rule can still pay. `loadAgentConfig` reads that block.
`VetoAgent.fromConfig` checks it against the chain. The mandate must be owned
by the program bundled with the SDK, and a block whose `programId` differs is
refused. A different program id is accepted only as an argument passed in
code. The mandate agent must be the key in the key file. The mint, source,
and payee token account must agree, and `mintDecimals` must match the mint
account. The cluster name must match the endpoint's genesis hash. A
connection passed to `fromConfig` is used instead of `rpcUrl`. The example
then charges:

```bash
npx tsx examples/pay-once.ts <agent-key.json> <config.json> <amount>
```

This is the shape:

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
  "rpcUrl": "<rpc url this app uses>"
}
```

`mintDecimals` is checked against the mint account. `payeeTokenAccount` is the
token account a charge pays: the payee's associated token account for this
mint when that account exists, otherwise the payee's only token account for
the mint. `cluster` is checked against the endpoint's genesis hash (`devnet`,
`testnet`, or `mainnet-beta`). `rpcUrl` is the RPC this app uses, copied as
configured, including any query string. It is the endpoint when the caller
does not pass a connection. A provider URL with a key in that query is on the
clipboard and in the QR.

## One-time: Expo account

These commands are interactive. Do not run them from an unattended agent.
Do not commit a keystore, a `.jks`, or `credentials.json`.

```bash
cd app
npm install
npx eas-cli login
```

The first Android cloud build will ask Expo to create a project if one is
not linked, and will ask EAS to generate a keystore. Let EAS store the
keystore.

## Development client APK

Builds a custom dev client APK (not Expo Go, not an AAB):

```bash
cd app
npx eas-cli build --profile development --platform android
```

When the build finishes, EAS prints a download URL.

1. Put the APK on the Seeker. Either open the URL on the device or copy it
   with adb:

   ```bash
   adb install path/to/the-downloaded.apk
   ```

2. Start Metro from this directory:

   ```bash
   npx expo start --dev-client
   ```

3. Open the installed Veto app on the Seeker and connect it to the bundler.

Test on the Seekers. Seed Vault is not available on an emulator.

## Production APK

Release APK, still Android only:

```bash
cd app
npx eas-cli build --profile production --platform android
```

Install that APK the same way. A production build is not a dev client, so
it does not talk to Metro.

## Entry file

`package.json` `main` is `index.js`. That file installs the Buffer and
crypto polyfills, then imports `expo-router/entry`. That order is required
for `@solana/web3.js`. See the comment at the top of `index.js`.
