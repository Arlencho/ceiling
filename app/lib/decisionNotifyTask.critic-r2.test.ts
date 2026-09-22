import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { KIND_REFUSED, REASON_OVER_PER_TX_MAX } from './constants';
import { encodeDecisionId } from './exportRecord';

// Critic fixtures, round 2 (PR 125). F1 asked for one tray entry per decision
// on two paths that present the same decision twice: the tray rejecting the
// first present, and two JS contexts (headless task and foreground app) that
// each read the seen set before either writes it. Android replaces on the
// identifier, so the tray here is a map keyed by identifier.

const OWNER = new PublicKey(Buffer.alloc(32, 3)).toBase58();
const MANDATE = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const MINT = new PublicKey(Buffer.alloc(32, 5)).toBase58();
const MERCHANT = new PublicKey(Buffer.alloc(32, 7)).toBase58();

const oldRow = {
  ts: 1_700_000_000n,
  kind: KIND_REFUSED,
  nonce: 4n,
  reason: REASON_OVER_PER_TX_MAX,
  amount: 6_232_500n,
  suggestedOverride: 6_232_500n,
};
const freshRow = { ...oldRow, nonce: 8n, ts: 1_700_000_080n };

type Request = { identifier?: string; content: { title: string; body: string; data: unknown } };
const presents: Request[] = [];
const rejectOnce = new Set<string>();
const store = new Map<string, string>();
let ledgerRows: readonly (typeof oldRow)[] = [oldRow];

mock.module('expo-notifications', {
  namedExports: {
    setNotificationHandler: () => undefined,
    scheduleNotificationAsync: async (request: Request) => {
      presents.push(request);
      if (request.identifier && rejectOnce.delete(request.identifier)) {
        throw new Error('tray rejected the present');
      }
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
    fetchLedger: async () => ({ entries: ledgerRows }),
  },
});

const taskModule = import('./decisionNotifyTask');

function tray(): Map<string, Request> {
  const out = new Map<string, Request>();
  for (const request of presents) {
    out.set(request.identifier ?? 'generated', request);
  }
  return out;
}

function reset(): void {
  presents.length = 0;
  rejectOnce.clear();
  store.clear();
  ledgerRows = [oldRow];
}

test('F1 rejected-present path: a present the tray rejected is retried under the same identifier, one entry', async () => {
  const { runDecisionNotifyScan } = await taskModule;
  reset();
  await runDecisionNotifyScan(); // seed, silent
  assert.equal(presents.length, 0);

  const freshId = encodeDecisionId(MANDATE, freshRow);
  ledgerRows = [oldRow, freshRow];
  rejectOnce.add(freshId);
  await assert.rejects(runDecisionNotifyScan());
  assert.equal(presents.length, 1);

  await runDecisionNotifyScan();
  assert.equal(presents.length, 2);
  assert.deepEqual(
    presents.map((p) => p.identifier),
    [freshId, freshId],
  );
  assert.equal(tray().size, 1);

  // A restart after the retry stays quiet.
  await runDecisionNotifyScan();
  assert.equal(presents.length, 2);
});

test('F1 two-context path: two contexts that both read the seen set before either writes it leave one tray entry', async () => {
  const { presentDecisionNotice } = await taskModule;
  const { deliverDecisionNotices, parseSeenIds, seenStorageKey, serializeSeenIds } = await import('./notify');
  reset();
  const key = seenStorageKey(MANDATE);
  store.set(key, serializeSeenIds(MANDATE, [encodeDecisionId(MANDATE, oldRow)]));
  const ledgers = [
    { mandate: MANDATE, merchant: MERCHANT, perTxMax: 500_000n, decimals: 6, rows: [oldRow, freshRow] },
  ];
  // Each JS context has its own scanTail, so nothing serialises these two reads.
  const seenHeadless = new Map([[MANDATE, parseSeenIds(MANDATE, store.get(key) ?? null)]]);
  const seenForeground = new Map([[MANDATE, parseSeenIds(MANDATE, store.get(key) ?? null)]]);
  const saveSeen = async (mandate: string, ids: readonly string[]) => {
    store.set(seenStorageKey(mandate), serializeSeenIds(mandate, ids));
  };

  await Promise.all([
    deliverDecisionNotices({ ledgers, seenByMandate: seenHeadless, present: presentDecisionNotice, saveSeen }),
    deliverDecisionNotices({ ledgers, seenByMandate: seenForeground, present: presentDecisionNotice, saveSeen }),
  ]);

  const freshId = encodeDecisionId(MANDATE, freshRow);
  assert.equal(presents.length, 2, 'both contexts present; the identifier is what collapses them');
  assert.equal(tray().size, 1);
  assert.equal(tray().get(freshId)?.content.title, 'Refused');
  assert.equal(parseSeenIds(MANDATE, store.get(key) ?? null).has(freshId), true);
});

test('regression: seed on first read, announce the next decision once, quiet after a restart', async () => {
  const { runDecisionNotifyScan } = await taskModule;
  reset();
  await runDecisionNotifyScan();
  assert.equal(presents.length, 0);
  ledgerRows = [oldRow, freshRow];
  await runDecisionNotifyScan();
  await runDecisionNotifyScan();
  assert.equal(presents.length, 1);
  assert.equal(presents[0]?.identifier, encodeDecisionId(MANDATE, freshRow));
});
