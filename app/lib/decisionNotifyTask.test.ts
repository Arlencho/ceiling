import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { KIND_REFUSED, REASON_OVER_PER_TX_MAX } from './constants';
import { encodeDecisionId } from './exportRecord';
import { refusalWhyLine } from './reasons';

// Critic fixtures, round 1. These exercise lib/decisionNotifyTask.ts, which
// notify.test.ts never imports. The expo modules and the chain reads are
// mocked so the scan runs under the same runner as the rest of the suite.

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

const scheduled: { identifier?: string; content: { title: string; body: string; data: unknown } }[] = [];
const store = new Map<string, string>();
let ledgerReads = 0;
let releaseLedger: (() => void) | null = null;

mock.module('expo-notifications', {
  namedExports: {
    setNotificationHandler: () => undefined,
    scheduleNotificationAsync: async (request: (typeof scheduled)[number]) => {
      scheduled.push(request);
      return request.identifier ?? 'generated';
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
    fetchOwnerMandates: async () => [
      { address: MANDATE, mint: MINT, merchant: MERCHANT, perTxMax: 500_000n },
    ],
    fetchMintDecimals: async () => 6,
    fetchLedger: async () => {
      ledgerReads += 1;
      if (releaseLedger) {
        await new Promise<void>((resolve) => {
          releaseLedger = resolve;
        });
      }
      return { entries: [refusedRow] };
    },
  },
});

const taskModule = import('./decisionNotifyTask');

test('a notification carries the decision id as its identifier so a repeat replaces instead of stacking', async () => {
  // expo-notifications substitutes uuid.v4() when identifier is omitted
  // (build/scheduleNotificationAsync.js:69) and Android posts with
  // notify(identifier, ANDROID_NOTIFICATION_ID, ...) so only a stable
  // identifier makes a second present of the same decision a replace.
  const { presentDecisionNotice } = await taskModule;
  scheduled.length = 0;
  const id = encodeDecisionId(MANDATE, refusedRow);
  await presentDecisionNotice({
    id,
    path: `/decision/${encodeURIComponent(id)}`,
    title: 'Refused',
    body: 'why',
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.identifier, id);
});

test('two overlapping scans in one JS context announce a decision once and persist it', async () => {
  const { runDecisionNotifyScan } = await taskModule;
  scheduled.length = 0;
  store.clear();
  ledgerReads = 0;
  releaseLedger = () => undefined;

  const first = runDecisionNotifyScan();
  const second = runDecisionNotifyScan();
  // The first scan is parked inside fetchLedger. The second must not have
  // read the ledger yet, or it would plan against the same empty seen set.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ledgerReads, 1);
  const release = releaseLedger;
  releaseLedger = null;
  release();
  await Promise.all([first, second]);

  assert.equal(ledgerReads, 2);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.content.body, refusalWhyLine({ ...refusedRow, decimals: 6, perTxMax: 500_000n }));
  assert.deepEqual(scheduled[0]?.content.data, { decisionId: encodeDecisionId(MANDATE, refusedRow) });

  // A restart reads the same secure-store value and stays quiet.
  await runDecisionNotifyScan();
  assert.equal(scheduled.length, 1);
});
