import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

const OWNER = new PublicKey(Buffer.alloc(32, 3)).toBase58();
const MANDATE = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const MINT = new PublicKey(Buffer.alloc(32, 5)).toBase58();
const MERCHANT = new PublicKey(Buffer.alloc(32, 7)).toBase58();

const order: string[] = [];
let task: (() => Promise<number>) | null = null;

mock.module('expo-notifications', {
  namedExports: {
    setNotificationHandler: () => undefined,
    scheduleNotificationAsync: async () => 'id',
    setNotificationChannelAsync: async () => null,
    getPermissionsAsync: async () => ({ granted: true }),
    requestPermissionsAsync: async () => ({ granted: true }),
    AndroidImportance: { DEFAULT: 3 },
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  },
});
mock.module('expo-background-task', {
  namedExports: {
    getStatusAsync: async () => 2,
    registerTaskAsync: async () => undefined,
    BackgroundTaskStatus: { Available: 2, Restricted: 1 },
    BackgroundTaskResult: { Success: 1, Failed: 2 },
  },
});
mock.module('expo-task-manager', {
  namedExports: {
    defineTask: (_name: string, fn: () => Promise<number>) => {
      task = fn;
    },
    isTaskRegisteredAsync: async () => false,
  },
});
mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async () => null,
      setItem: async () => undefined,
      deleteItem: async () => undefined,
    },
  },
});
mock.module('./wallet', {
  namedExports: {
    loadSession: async () => ({ ownerPublicKey: OWNER, authToken: 'token' }),
  },
});
mock.module('./config', {
  namedExports: {
    tryLoadConfig: () => ({ ok: true, config: { mintDecimals: 6 } }),
  },
});
mock.module('./chain', {
  namedExports: {
    createClient: () => ({}),
    fetchOwnerMandates: async () => [
      { address: MANDATE, mint: MINT, merchant: MERCHANT, perTxMax: 500_000n },
    ],
    fetchMintDecimals: async () => 6,
    fetchLedger: async () => {
      order.push('ledger');
      return { entries: [] };
    },
  },
});
mock.module('../widgets/register', {
  namedExports: {
    refreshHomeWidgets: async () => {
      order.push('refresh');
    },
    registerHomeWidgets: () => undefined,
  },
});

const taskModule = import('./decisionNotifyTask');

test('the background decision check refreshes the home widget after it reads the rules', async () => {
  await taskModule;
  assert.ok(task);
  order.length = 0;
  const result = await task();
  assert.equal(result, 1);
  assert.deepEqual(order, ['ledger', 'refresh']);
});
