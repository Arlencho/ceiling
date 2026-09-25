import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { configFromExtra } from './appConfig';
import { authorize, type MwaWallet } from './wallet';

const OWNER = new PublicKey(Buffer.alloc(32, 3)).toBase58();
const PROGRAM = new PublicKey(Buffer.alloc(32, 1)).toBase58();

// Path 1 and 4. The RPC url and explorer cluster come from EXPO_PUBLIC_* at
// build time, but the chain named to the wallet is a constant. A build whose
// config points at another cluster still authorizes the wallet on devnet.
test('the wallet chain follows the configured cluster instead of a fixed devnet constant', async () => {
  const env = {
    EXPO_PUBLIC_VETO_RPC: 'https://api.mainnet-beta.solana.com',
    EXPO_PUBLIC_VETO_PROGRAM_ID: PROGRAM,
    EXPO_PUBLIC_VETO_EXPLORER_CLUSTER: 'mainnet-beta',
  };
  const previous = {
    EXPO_PUBLIC_VETO_RPC: process.env.EXPO_PUBLIC_VETO_RPC,
    EXPO_PUBLIC_VETO_PROGRAM_ID: process.env.EXPO_PUBLIC_VETO_PROGRAM_ID,
    EXPO_PUBLIC_VETO_EXPLORER_CLUSTER: process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER,
  };
  Object.assign(process.env, env);
  try {
    const config = configFromExtra({}, env);
    const chains: string[] = [];
    const wallet: MwaWallet = {
      async authorize(params) {
        chains.push(params.chain ?? '');
        return { accounts: [{ address: OWNER }], auth_token: 'token' };
      },
      async deauthorize() {
        return null;
      },
    };
    await authorize(wallet);
    assert.equal(config.explorerCluster, 'mainnet-beta');
    assert.equal(chains[0], 'solana:mainnet');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

// Path 4. The permissions in the release manifest come from Expo's bare
// template (expo/template.tgz, android/app/src/main/AndroidManifest.xml), not
// from the expo-dev-client plugin. Prebuild without that plugin still writes
// them. The config that removes them is android.blockedPermissions.
test('the release config blocks the template permissions the product does not use', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
    expo?: { android?: { blockedPermissions?: unknown } };
  };
  const raw = app.expo?.android?.blockedPermissions;
  const blocked = Array.isArray(raw) ? raw.map(String) : [];
  for (const permission of [
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ]) {
    assert.ok(blocked.includes(permission), `${permission} is not in android.blockedPermissions`);
  }
});
