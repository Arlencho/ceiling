import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

const PROGRAM = new PublicKey(Buffer.alloc(32, 1)).toBase58();
const OWNER = new PublicKey(Buffer.alloc(32, 3)).toBase58();

mock.module('expo-constants', {
  defaultExport: {
    expoConfig: {
      extra: {
        vetoRpc: 'https://api.mainnet-beta.solana.com',
        vetoProgramId: PROGRAM,
        vetoExplorerCluster: 'mainnet-beta',
      },
    },
  },
});

const walletModule = import('./wallet');

test('authorize names the chain from app config when the env still says devnet', async () => {
  const previous = process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER;
  process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER = 'devnet';
  try {
    const { authorize } = await walletModule;
    const chains: string[] = [];
    await authorize({
      async authorize(params) {
        chains.push(params.chain ?? '');
        return { accounts: [{ address: OWNER }], auth_token: 'token' };
      },
      async deauthorize() {
        return null;
      },
    });
    assert.equal(chains[0], 'solana:mainnet-beta');
  } finally {
    if (previous === undefined) {
      delete process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER;
    } else {
      process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER = previous;
    }
  }
});
