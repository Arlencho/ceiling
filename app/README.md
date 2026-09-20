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
```

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
