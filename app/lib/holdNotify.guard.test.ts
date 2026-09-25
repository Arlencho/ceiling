import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Keypair } from '@solana/web3.js';
import type { HoldVaultBundle } from './holdChain';
import type { HoldScheduler } from './holdNotify';
import { holdAlertPlan, futureHoldAlerts } from './holdAlerts';

const guardian = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;
const destination = Keypair.generate().publicKey;
const created = 1_700_000_000n;
const row = { id: 4n, amount: 400n, destination, unlockAt: created + 172_800n, status: 1 };
const bundle = {
  account: { address: vault, guardian, mint: destination, pending: [row], known: [], delaySecs: 172_800n, change: { active: false } },
  decimals: 0,
  ledger: { entries: [{ kind: 3, withdrawalId: 4n, ts: created }] },
} as unknown as HoldVaultBundle;
const memory = new Map<string, string>();
let ownerError: Error | null = null;
let guardianError: Error | null = null;
let guarded = [bundle.account];
const notices: { identifier: string; content: { data: unknown } }[] = [];
mock.module('./chain', { namedExports: { fetchMintDecimals: async () => 0 } });
mock.module('./config', { namedExports: { tryLoadConfig: () => ({ ok: true, config: { mint: destination.toBase58() } }) } });
mock.module('./mwa', { namedExports: { secureStore: {
  getItem: async (key: string) => memory.get(key) ?? null,
  setItem: async (key: string, value: string) => { memory.set(key, value); },
} } });
mock.module('./wallet', { namedExports: { loadSession: async () => ({ ownerPublicKey: guardian.toBase58() }) } });
mock.module('./holdChain', { namedExports: {
  holdClient: () => ({ connection: {} }),
  readChainClock: async () => created,
  listHoldVaults: async () => { if (ownerError) throw ownerError; return []; },
  listGuardedVaults: async () => { if (guardianError) throw guardianError; return guarded; },
  readHoldVaults: async () => { if (guardianError) throw guardianError; return guarded; },
  readHoldVault: async () => bundle,
} });
mock.module('expo-notifications', { namedExports: {
  AndroidImportance: { HIGH: 4 }, SchedulableTriggerInputTypes: { DATE: 'date' },
  setNotificationChannelAsync: async () => {}, getPermissionsAsync: async () => ({ granted: true }),
  scheduleNotificationAsync: async (notice: typeof notices[number]) => { notices.push(notice); },
  cancelScheduledNotificationAsync: async () => {},
} });



test('the guardian schedules the full remaining plan and every notice opens the named guarded withdrawal', async () => {
  const { raiseHoldAlertsForGuardian, expoHoldScheduler, holdPathFromNoticeData } = await import('./holdNotify');
  memory.clear(); notices.length = 0;
  await raiseHoldAlertsForGuardian({ guardian, scheduler: expoHoldScheduler() });
  const expected = futureHoldAlerts(holdAlertPlan({ vault: vault.toBase58(), withdrawalId: '4', amountLabel: '400 tokens', destinationLabel: '', createdAt: created, unlockAt: row.unlockAt, newAddress: true }), created);
  assert.deepEqual(notices.filter(n => n.identifier.includes(':4:')).map(n => n.identifier), expected.map(a => `guard:${a.key}`));
  for (const notice of notices) {
    assert.equal(holdPathFromNoticeData(notice.content.data), `/hold/guard?vault=${vault.toBase58()}&id=4`);
  }
  assert.ok(expected.some(a => a.name === 'every_12h'));
});

test('an owner scan preserves guardian reminders and cancels only stale owner reminders', async () => {
  const { raiseHoldAlertsForOwner } = await import('./holdNotify');
  memory.set('veto.hold.alerts.scheduled', JSON.stringify(['guard:V:4:1h:42', 'V:4:1h:42']));
  const canceled: string[] = [];
  const scheduler: HoldScheduler = { ensureChannel: async () => {}, present: async () => {}, schedule: async () => {}, cancel: async key => { canceled.push(key); } };
  await raiseHoldAlertsForOwner({ owner: guardian, scheduler, nowSec: created });
  assert.deepEqual(canceled, ['V:4:1h:42']);
  assert.deepEqual(JSON.parse(memory.get('veto.hold.alerts.scheduled')!), ['guard:V:4:1h:42']);
});

test('the scan reports the owner failure before a guardian read failure', async () => {
  const { raiseHoldAlertsOnScan } = await import('./holdNotify');
  memory.set('veto.hold.guarded', JSON.stringify({ guardian: guardian.toBase58(), vaults: [vault.toBase58()] }));
  ownerError = new Error('owner read failed'); guardianError = new Error('guardian read failed');
  try { await assert.rejects(raiseHoldAlertsOnScan(), /owner read failed/); }
  finally { ownerError = null; guardianError = null; }
});

test('a guardian failure is reported when the owner scan succeeds', async () => {
  const { raiseHoldAlertsOnScan } = await import('./holdNotify');
  guardianError = new Error('guardian read failed');
  try { await assert.rejects(raiseHoldAlertsOnScan(), /guardian read failed/); }
  finally { guardianError = null; }
});

test('a guardian scan cancels reminders for withdrawals that are no longer pending', async () => {
  const { raiseHoldAlertsForGuardian } = await import('./holdNotify');
  const canceled: string[] = [];
  guarded = [];
  const scheduler: HoldScheduler = { ensureChannel: async () => {}, present: async () => {}, schedule: async () => {}, cancel: async key => { canceled.push(key); } };
  memory.set('veto.hold.alerts.scheduled', JSON.stringify(['guard:V:4:1h:42', 'owner:keep']));
  try {
    await raiseHoldAlertsForGuardian({ guardian, scheduler });
    assert.deepEqual(canceled, ['guard:V:4:1h:42']);
    assert.deepEqual(JSON.parse(memory.get('veto.hold.alerts.scheduled')!), ['owner:keep']);
  } finally { guarded = [bundle.account]; }
});
