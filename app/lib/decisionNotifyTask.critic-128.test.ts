import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX } from './constants';
import { encodeDecisionId } from './exportRecord';

// Critic fixtures for PR 138 (issue 128), round 1. A stored seen key that is
// not a JSON array must take the same quiet seed path as a missing key. On
// main, scanOnce treats it as an empty seen set and announces the whole ring.
// The mocks mirror lib/decisionNotifyTask.test.ts; module mocks are per
// process, so this file carries its own copy.

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
const paidRow = { ...refusedRow, kind: KIND_PAID, nonce: 5n, ts: 1_700_000_010n, amount: 400_000n, reason: 0 };
const secondRefused = { ...refusedRow, nonce: 6n, ts: 1_700_000_020n };
const ring = [refusedRow, paidRow, secondRefused];
const ringIds = ring.map((row) => encodeDecisionId(MANDATE, row));

const scheduled: { identifier?: string; content: { title: string; body: string; data: unknown } }[] = [];
const store = new Map<string, string>();
let ledgerRows: readonly (typeof refusedRow)[] = ring;

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
    truncateAddress: (address: string) => `${address.slice(0, 4)}...${address.slice(-4)}`,
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
    fetchLedger: async () => ({ entries: ledgerRows }),
  },
});

const taskModule = import('./decisionNotifyTask');
const notifyModule = import('./notify');

function reset(): void {
  scheduled.length = 0;
  store.clear();
  ledgerRows = ring;
}

async function seededKey(): Promise<string> {
  const { serializeSeenIds } = await notifyModule;
  return serializeSeenIds(MANDATE, ringIds);
}

const corrupt: [label: string, value: string][] = [
  ['a JSON object', '{"seen":["x"]}'],
  ['a JSON number', '42'],
  ['non-JSON text', 'not json'],
  ['an empty string', ''],
];

for (const [label, value] of corrupt) {
  test(`128: a seen key holding ${label} announces nothing and is rewritten to the ring`, async () => {
    const { runDecisionNotifyScan } = await taskModule;
    const { seenStorageKey } = await notifyModule;
    reset();
    const key = seenStorageKey(MANDATE);
    store.set(key, value);

    await runDecisionNotifyScan();

    assert.equal(scheduled.length, 0, `${label}: the ring of ${ring.length} must not be announced`);
    assert.equal(store.get(key), await seededKey(), `${label}: the key is rewritten as a real seed`);

    // The rewrite is a live seed, not a stuck value: the next new row is announced once.
    const fresh = { ...refusedRow, nonce: 7n, ts: 1_700_000_030n };
    ledgerRows = [...ring, fresh];
    await runDecisionNotifyScan();
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.identifier, encodeDecisionId(MANDATE, fresh));
  });
}

test('128 regression: a missing key seeds quietly, as on main', async () => {
  const { runDecisionNotifyScan } = await taskModule;
  const { seenStorageKey } = await notifyModule;
  reset();
  const key = seenStorageKey(MANDATE);

  await runDecisionNotifyScan();

  assert.equal(scheduled.length, 0);
  assert.equal(store.get(key), await seededKey());
});

test('128 regression: a valid key announces only the row it does not hold, as on main', async () => {
  const { runDecisionNotifyScan } = await taskModule;
  const { seenStorageKey, serializeSeenIds, parseSeenIds } = await notifyModule;
  reset();
  const key = seenStorageKey(MANDATE);
  store.set(key, serializeSeenIds(MANDATE, [ringIds[0]!, ringIds[1]!]));

  await runDecisionNotifyScan();

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.identifier, ringIds[2]);
  const remembered = parseSeenIds(MANDATE, store.get(key) ?? null);
  assert.ok(remembered);
  assert.deepEqual([...remembered].sort(), [...ringIds].sort());

  // A valid empty array is a real empty seen set, not corruption: every row is announced.
  reset();
  store.set(key, '[]');
  await runDecisionNotifyScan();
  assert.equal(scheduled.length, ring.length);
});
