# Veto Android app

Expo custom-dev-client app for a Solana Seeker. Android only. Expo Go cannot
load Mobile Wallet Adapter native modules, so this project is built as a
custom dev client APK.

Do not add an iOS or web target.

## Headless checks

From this directory:

```bash
npx tsc --noEmit
npx expo config
npm test
```

`npm test` runs the pure module tests (wallet, templates, reason text, ring
decode, amount formatting, config). They do not need a device. Mobile Wallet
Adapter `authorize` and the Seed Vault signature for `open_mandate` /
`revoke_mandate` still have to be checked on a Seeker.

## Sign-in

Connect runs `transact`, then `authorize`, against the Seed Vault wallet through
Mobile Wallet Adapter. The owner public key is shown truncated. The
authorization token is stored in `expo-secure-store` so a returning user is not
prompted again. Disconnect deauthorizes that token and clears it.

The agent keypair is generated on the phone with `@solana/web3.js` and stored in
`expo-secure-store`. It is a different key from the owner. It holds authority
and no funds. The owner private key is never written to storage.

## Owner screens

Four tabs, all Android:

- **Mandate.** Templates a Seeker owner recognises (cap a mint bot, cap a
  quest-farm spend, cap an agent weekly outgoings, charge the car under a
  price) prefill cap, per-payment maximum, expiry, merchant and purpose. Every
  field stays editable. A template is an empty starting point and does not
  ship example transactions or prices. One Seed Vault signature runs
  `open_mandate`, which also delegates in the same transaction. The
  confirmation is read back from chain, not from the form.
- **Today.** What the agent paid and declined today, newest first, plus
  remaining cap and time left. Real history only. If nothing has happened it
  says so.
- **Ledger.** Every decision with the reason in plain language. A refusal
  shows the override that would have cleared it, is styled as a first-class
  outcome (not an error), and opens its transaction in an explorer when the
  RPC returns a signature.
- **Revoke.** One owner signature sets status to revoked and drops the SPL
  delegation. The UI states that the funds never moved and were not going to.
  The agent's next charge is refused with reason 1 (`mandate not active`).

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
