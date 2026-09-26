import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { configFromExtra } from './appConfig';
import type { MwaWallet } from './wallet';

const OWNER = new PublicKey(Buffer.alloc(32, 3)).toBase58();
const PROGRAM = new PublicKey(Buffer.alloc(32, 1)).toBase58();

// Path 1 and 4. On mainnet-beta the RPC url is baked into the build config
// from the dedicated VETO_MAINNET_PREVIEW_RPC secret (app.config.js extra);
// the EXPO_PUBLIC_VETO_RPC fallback is refused. The chain named to the wallet
// still follows the configured cluster instead of a fixed devnet constant.
const MAINNET_EXTRA = {
  vetoRpc: 'https://api.mainnet-beta.solana.com',
  vetoProgramId: PROGRAM,
  vetoExplorerCluster: 'mainnet-beta',
};

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: MAINNET_EXTRA } } });

test('the wallet chain follows the configured cluster instead of a fixed devnet constant', async () => {
  const { authorize } = await import('./wallet');
  const config = configFromExtra(MAINNET_EXTRA);
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
