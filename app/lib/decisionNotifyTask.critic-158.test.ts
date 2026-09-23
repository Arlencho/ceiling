import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { KIND_REFUSED, REASON_OVER_PER_TX_MAX } from './constants';

// Cross-vendor verification of issue 168, round 1. The audit fixture asserts
// on an error message that both callers discard (decisionNotifyTask.ts:41-43
// and useDecisionNotifications.ts:33). The observable gap is that the
// foreground read retries a 429 and the background scan does not. This case
// gives the RPC one 429 and then a good read, and expects the scan to finish.

const OWNER = new PublicKey(Buffer.alloc(32, 3)).toBase58();
const MANDATE = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const MINT = new PublicKey(Buffer.alloc(32, 5)).toBase58();
const MERCHANT = new PublicKey(Buffer.alloc(32, 7)).toBase58();

const refusedRow = {
  ts: 1_700_000_000n,
  kind: KIND_REFUSED,
  nonce: 4n,
  reason: REASON_OVER_PER_TX_MAX,
  amount: 6_232_500n,
  suggestedOverride: 6_232_500n,
};

const store = new Map<string, string>();
const scheduled: unknown[] = [];
const ownerReadErrors: Error[] = [];
let ownerReads = 0;

mock.module('expo-notifications', {
  namedExports: {
    setNotificationHandler: () => undefined,
    scheduleNotificationAsync: async (request: unknown) => {
      scheduled.push(request);
      return 'id';
    },
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
    defineTask: () => undefined,
    isTaskRegisteredAsync: async () => false,
  },
});
mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async (key: string) => store.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        store.set(key, value);
      },
      deleteItem: async (key: string) => {
        store.delete(key);
      },
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
    fetchOwnerMandates: async () => {
      ownerReads += 1;
      const failure = ownerReadErrors.shift();
      if (failure) {
        throw failure;
      }
      return [{ address: MANDATE, mint: MINT, merchant: MERCHANT, perTxMax: 500_000n }];
    },
    fetchMintDecimals: async () => 6,
    fetchLedger: async () => ({ entries: [refusedRow] }),
  },
});

const taskModule = import('./decisionNotifyTask');

test('a background scan retries one RPC 429 the way the foreground read does and then finishes', async () => {
  const { runDecisionNotifyScan } = await taskModule;
  store.clear();
  scheduled.length = 0;
  ownerReads = 0;
  ownerReadErrors.push(new Error('429 Too Many Requests'));

  await runDecisionNotifyScan();
  assert.equal(ownerReads, 2);
  // First read of this rule: seed the seen set, announce nothing.
  assert.equal(scheduled.length, 0);
});
