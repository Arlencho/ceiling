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
const MANDATE_B = new PublicKey(Buffer.alloc(32, 11)).toBase58();
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
let permissionGranted = true;
let registerCalls = 0;
type MandateStub = { address: string; mint: string; merchant: string; perTxMax: bigint };
let ownerMandates: MandateStub[] = [
  { address: MANDATE, mint: MINT, merchant: MERCHANT, perTxMax: 500_000n },
];
let ledgerRows: (address: string) => readonly (typeof refusedRow)[] = () => [refusedRow];

mock.module('expo-notifications', {
  namedExports: {
    setNotificationHandler: () => undefined,
    scheduleNotificationAsync: async (request: (typeof scheduled)[number]) => {
      scheduled.push(request);
      return request.identifier ?? 'generated';
    },
    setNotificationChannelAsync: async () => null,
    getPermissionsAsync: async () => ({ granted: permissionGranted }),
    requestPermissionsAsync: async () => {
      permissionGranted = true;
      return { granted: true };
    },
    AndroidImportance: { DEFAULT: 3 },
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  },
});
mock.module('expo-background-task', {
  namedExports: {
    getStatusAsync: async () => 2,
    registerTaskAsync: async () => {
      registerCalls += 1;
    },
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
    fetchOwnerMandates: async () => ownerMandates,
    fetchMintDecimals: async () => 6,
    fetchLedger: async (_client: unknown, mandate: PublicKey) => {
      ledgerReads += 1;
      if (releaseLedger) {
        await new Promise<void>((resolve) => {
          releaseLedger = resolve;
        });
      }
      return { entries: ledgerRows(mandate.toBase58()) };
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
  const { seenStorageKey, serializeSeenIds } = await import('./notify');
  scheduled.length = 0;
  store.clear();
  ledgerReads = 0;
  releaseLedger = null;
  ownerMandates = [{ address: MANDATE, mint: MINT, merchant: MERCHANT, perTxMax: 500_000n }];
  const fresh = { ...refusedRow, nonce: 8n, ts: 1_700_000_080n };
  // The historical row is already stored. The overlap is about the row that
  // arrived afterwards: both scans must not present it.
  store.set(seenStorageKey(MANDATE), serializeSeenIds(MANDATE, [encodeDecisionId(MANDATE, refusedRow)]));
  ledgerRows = () => [refusedRow, fresh];
  releaseLedger = () => undefined;

  const first = runDecisionNotifyScan();
  const second = runDecisionNotifyScan();
  // The first scan is parked inside fetchLedger. The second must not have
  // read the ledger yet, or it would plan against the same seen set.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ledgerReads, 1);
  const release = releaseLedger;
  releaseLedger = null;
  release();
  await Promise.all([first, second]);

  assert.equal(ledgerReads, 2);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.content.body, refusalWhyLine({ ...fresh, decimals: 6, perTxMax: 500_000n }));
  assert.deepEqual(scheduled[0]?.content.data, { decisionId: encodeDecisionId(MANDATE, fresh) });

  // A restart reads the same secure-store value and stays quiet.
  await runDecisionNotifyScan();
  assert.equal(scheduled.length, 1);
});

function resetNotifyHarness(): void {
  scheduled.length = 0;
  store.clear();
  ledgerReads = 0;
  releaseLedger = null;
  permissionGranted = true;
  registerCalls = 0;
  ownerMandates = [{ address: MANDATE, mint: MINT, merchant: MERCHANT, perTxMax: 500_000n }];
  ledgerRows = () => [refusedRow];
}

function mandateStub(address: string): { address: string; mint: string; merchant: string; perTxMax: bigint } {
  return { address, mint: MINT, merchant: MERCHANT, perTxMax: 500_000n };
}

test('the first scan after notification permission is granted stores every current decision and announces none', async () => {
  const { askAfterFirstRuleOpened } = await taskModule;
  const { parseSeenIds, seenStorageKey } = await import('./notify');
  resetNotifyHarness();
  permissionGranted = false;
  const laterRow = { ...refusedRow, nonce: 9n, ts: 1_700_000_050n };
  ownerMandates = [mandateStub(MANDATE), mandateStub(MANDATE_B)];
  ledgerRows = (address) => (address === MANDATE_B ? [laterRow] : [refusedRow]);

  await askAfterFirstRuleOpened();

  assert.equal(scheduled.length, 0);
  assert.equal(
    parseSeenIds(MANDATE, store.get(seenStorageKey(MANDATE)) ?? null).has(encodeDecisionId(MANDATE, refusedRow)),
    true,
  );
  assert.equal(
    parseSeenIds(MANDATE_B, store.get(seenStorageKey(MANDATE_B)) ?? null).has(
      encodeDecisionId(MANDATE_B, laterRow),
    ),
    true,
  );
});

test('a rule added later stores the decisions already on it and announces none', async () => {
  const { runDecisionNotifyScan } = await taskModule;
  const { parseSeenIds, seenStorageKey, serializeSeenIds } = await import('./notify');
  resetNotifyHarness();
  const existingId = encodeDecisionId(MANDATE, refusedRow);
  store.set(seenStorageKey(MANDATE), serializeSeenIds(MANDATE, [existingId]));
  const laterRow = { ...refusedRow, nonce: 9n, ts: 1_700_000_050n };
  ownerMandates = [mandateStub(MANDATE), mandateStub(MANDATE_B)];
  ledgerRows = (address) => (address === MANDATE_B ? [laterRow] : [refusedRow]);

  await runDecisionNotifyScan();

  assert.equal(scheduled.length, 0);
  assert.equal(
    parseSeenIds(MANDATE_B, store.get(seenStorageKey(MANDATE_B)) ?? null).has(
      encodeDecisionId(MANDATE_B, laterRow),
    ),
    true,
  );
  assert.equal(parseSeenIds(MANDATE, store.get(seenStorageKey(MANDATE)) ?? null).has(existingId), true);
});

test('a decision that appears after a rule was seeded is announced once', async () => {
  const { runDecisionNotifyScan } = await taskModule;
  resetNotifyHarness();
  await runDecisionNotifyScan();
  const fresh = { ...refusedRow, nonce: 8n, ts: 1_700_000_080n };
  ledgerRows = () => [refusedRow, fresh];
  await runDecisionNotifyScan();

  assert.equal(scheduled.length, 1);
  assert.deepEqual(scheduled[0]?.content.data, { decisionId: encodeDecisionId(MANDATE, fresh) });
  assert.equal(
    scheduled[0]?.content.body,
    refusalWhyLine({ ...fresh, decimals: 6, perTxMax: 500_000n }),
  );
});

test('opening another rule after permission was granted does not read the chain again', async () => {
  const { askAfterFirstRuleOpened } = await taskModule;
  resetNotifyHarness();
  await askAfterFirstRuleOpened();
  assert.equal(ledgerReads > 0, true);
  const reads = ledgerReads;
  const registers = registerCalls;
  await askAfterFirstRuleOpened();
  assert.equal(ledgerReads, reads);
  assert.equal(registerCalls, registers + 1);
});
