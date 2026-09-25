import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Keypair } from '@solana/web3.js';

import { KIND_PAID, KIND_REFUSED, STATUS_ACTIVE } from './constants';
import type { MandateAccount } from './mandate';
import {
  QUIET_NOTE_HONEST,
  QUIET_NOTE_RULE_KEY,
  applyQuietPlan,
  daysToGoPhrase,
  defaultQuietSettings,
  parseQuietSettings,
  planQuietNote,
  quietActionLabel,
  quietNoteCopy,
  refreshQuietNote,
  shiftClock,
  type QuietNoteScheduler,
  type QuietSettings,
} from './quietNote';
import type { WalletStore } from './wallet';

const DAY_MS = 86_400_000;
const NOW = new Date(2026, 5, 15, 18, 30, 0, 0);
const EXPIRES = BigInt(Math.floor(NOW.getTime() / 1000) + 40 * 86_400);

function storeFrom(raw: string | null = null): WalletStore & { saved: string | null } {
  const state = { saved: raw };
  return {
    get saved() {
      return state.saved;
    },
    set saved(value: string | null) {
      state.saved = value;
    },
    getItem: async (key) => (key === 'veto.quietNote' ? state.saved : null),
    setItem: async (key, value) => {
      if (key === 'veto.quietNote') {
        state.saved = value;
      }
    },
    deleteItem: async () => undefined,
  };
}

function settings(partial: Partial<QuietSettings> = {}): QuietSettings {
  return { ...defaultQuietSettings(), ...partial };
}

function mandate(): MandateAccount {
  return {
    address: 'rule',
    owner: 'owner',
    agent: Keypair.generate().publicKey.toBase58(),
    mint: 'mint',
    source: 'source',
    merchant: Keypair.generate().publicKey.toBase58(),
    mandateId: 1n,
    cap: 9n,
    spent: 5n,
    perTxMax: 2n,
    expiresAt: EXPIRES,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 1n,
    purpose: 'Depot agent',
    status: STATUS_ACTIVE,
    spendCount: 1,
    refusalCount: 1,
    bump: 1,
  };
}

function copyFor(rows: { ts: bigint; kind: number; amount: bigint }[], total: number | null = rows.length) {
  return quietNoteCopy({
    name: 'Depot agent',
    cap: 9n,
    spent: 5n,
    expiresAt: EXPIRES,
    decimals: 0,
    rows,
    ledgerTotal: total,
    now: NOW,
  });
}

test('the quiet note is off until the owner turns it on', () => {
  assert.equal(defaultQuietSettings().enabled, false);
  assert.equal(defaultQuietSettings().send, 'every-evening');
  assert.equal(defaultQuietSettings().hour, 21);
  assert.equal(parseQuietSettings(null).enabled, false);
  assert.equal(parseQuietSettings('nope').enabled, false);
  assert.equal(parseQuietSettings(JSON.stringify({ enabled: true, send: 'later', hour: 21, minute: 0 })).enabled, false);
  assert.equal(parseQuietSettings(JSON.stringify({ enabled: true, send: 'moved', hour: 99, minute: 0 })).enabled, false);
  const saved = parseQuietSettings(JSON.stringify({ enabled: true, send: 'moved', hour: 7, minute: 5 }));
  assert.equal(saved.enabled, true);
  assert.equal(saved.send, 'moved');
  assert.equal(saved.hour, 7);
  assert.equal(quietActionLabel('every-evening', false), 'Turn on the quiet note');
  assert.equal(quietActionLabel('never', false), 'Keep the quiet note off');
  assert.deepEqual(shiftClock(21, 0, -5), { hour: 20, minute: 55 });
  assert.match(QUIET_NOTE_HONEST, /every 15 minutes/);
  assert.match(QUIET_NOTE_HONEST, /Battery saving can delay a check/);
  const source = readFileSync(new URL('./useChain.ts', import.meta.url), 'utf8');
  assert.match(source, /SELECTED_MANDATE_KEY = 'veto\.mandate\.selected'/);
  assert.equal(QUIET_NOTE_RULE_KEY, 'veto.mandate.selected');
});

test('the note text is computed from today, and a quiet day with moved mode stays silent', () => {
  const today = BigInt(Math.floor(NOW.getTime() / 1000));
  const yesterday = BigInt(Math.floor((NOW.getTime() - DAY_MS) / 1000));
  const quiet = copyFor([
    { ts: yesterday, kind: KIND_REFUSED, amount: 8n },
    { ts: yesterday, kind: KIND_PAID, amount: 2n },
  ]);
  assert.equal(quiet.moved, false);
  assert.match(quiet.headline, /Nothing paid, nothing moved/);
  assert.match(quiet.detail, /4 of 9 left/);
  assert.match(quiet.detail, /Last check 18:30/);
  assert.doesNotMatch(quiet.body, /258 of 300/);
  assert.equal(daysToGoPhrase(EXPIRES, BigInt(Math.floor(NOW.getTime() / 1000))) != null, true);

  const refused = copyFor([{ ts: today, kind: KIND_REFUSED, amount: 8n }]);
  assert.equal(refused.moved, true);
  assert.match(refused.headline, /Depot agent asked once outside the rule and was refused/);
  assert.match(refused.headline, /Nothing paid, nothing moved/);

  const paid = copyFor([
    { ts: today, kind: KIND_PAID, amount: 2n },
    { ts: today, kind: KIND_REFUSED, amount: 8n },
  ]);
  assert.match(paid.headline, /paid once and refused once/);
  assert.doesNotMatch(paid.headline, /Nothing paid/);

  const before = planQuietNote({
    settings: settings({ enabled: true, send: 'moved' }),
    copy: quiet,
    now: NOW,
    permissionGranted: true,
  });
  assert.equal(before.schedule, null);

  const evening = planQuietNote({
    settings: settings({ enabled: true, send: 'every-evening' }),
    copy: quiet,
    now: NOW,
    permissionGranted: true,
  });
  assert.ok(evening.schedule);
  assert.equal(evening.schedule.when === 'now', false);
  assert.match(evening.schedule.body, /Nothing paid, nothing moved/);
  assert.match(evening.schedule.body, /4 of 9 left/);
});

test('a note already scheduled for today is not sent a second time', () => {
  const today = quietNoteCopy({
    name: 'Depot agent',
    cap: 9n,
    spent: 5n,
    expiresAt: EXPIRES,
    decimals: 0,
    rows: [],
    ledgerTotal: 0,
    now: NOW,
  });
  const fire = planQuietNote({
    settings: settings({ enabled: true }),
    copy: today,
    now: NOW,
    permissionGranted: true,
  });
  assert.ok(fire.schedule && fire.schedule.when !== 'now');
  const again = planQuietNote({
    settings: fire.settings,
    copy: today,
    now: NOW,
    permissionGranted: true,
  });
  assert.equal(again.persist, false);
  assert.equal(again.schedule, null);

  const late = new Date(NOW.getTime());
  late.setHours(21, 10, 0, 0);
  const sent = planQuietNote({
    settings: fire.settings,
    copy: today,
    now: late,
    permissionGranted: true,
  });
  assert.equal(sent.schedule, null);
  assert.equal(sent.settings.lastSentDay != null, true);

  const duplicate = planQuietNote({
    settings: sent.settings,
    copy: today,
    now: late,
    permissionGranted: true,
  });
  assert.equal(duplicate.schedule, null);
  assert.equal(duplicate.persist, false);
});

test('turning the note off cancels the scheduled notification and writes no payment', async () => {
  const calls: string[] = [];
  const scheduler: QuietNoteScheduler = {
    cancel: async (id) => {
      calls.push(`cancel:${id}`);
    },
    schedule: async (args) => {
      calls.push(`schedule:${args.when === 'now' ? 'now' : 'later'}:${args.body}`);
    },
  };
  const memory = storeFrom(null);
  const rule = mandate();
  const today = BigInt(Math.floor(Date.now() / 1000));
  await refreshQuietNote({
    mandates: [rule],
    ledgers: [
      {
        mandate: rule.address,
        rows: [{ ts: today, kind: KIND_REFUSED, amount: 3n }],
        total: 1,
        decimals: 0,
      },
    ],
    now: new Date(),
    selectedAddress: rule.address,
    store: memory,
    scheduler,
    permissionGranted: true,
    settingsOverride: settings({ enabled: false, send: 'never' }),
  });
  assert.deepEqual(calls, ['cancel:veto-quiet-note']);
  const saved = parseQuietSettings(memory.saved);
  assert.equal(saved.enabled, false);
  assert.equal(saved.send, 'never');
  const scheduled = calls.filter((call) => call.startsWith('schedule:'));
  assert.equal(scheduled.length, 0);
});

test('an enabled evening note schedules the body from the day, and a denied permission does not', async () => {
  const calls: string[] = [];
  const scheduler: QuietNoteScheduler = {
    cancel: async () => {
      calls.push('cancel');
    },
    schedule: async (args) => {
      calls.push(args.body);
    },
  };
  const memory = storeFrom(null);
  const rule = mandate();
  const now = new Date(NOW.getTime());
  now.setHours(10, 0, 0, 0);
  const ts = BigInt(Math.floor(now.getTime() / 1000));
  await refreshQuietNote({
    mandates: [rule],
    ledgers: [
      {
        mandate: rule.address,
        rows: [{ ts, kind: KIND_PAID, amount: 2n }],
        total: 1,
        decimals: 0,
      },
    ],
    now,
    selectedAddress: rule.address,
    store: memory,
    scheduler,
    permissionGranted: false,
    settingsOverride: settings({ enabled: true, hour: 21, minute: 0 }),
  });
  assert.deepEqual(calls, ['cancel']);
  assert.equal(parseQuietSettings(memory.saved).enabled, true);

  calls.length = 0;
  await refreshQuietNote({
    mandates: [rule],
    ledgers: [
      {
        mandate: rule.address,
        rows: [{ ts, kind: KIND_PAID, amount: 2n }],
        total: 1,
        decimals: 0,
      },
    ],
    now,
    selectedAddress: rule.address,
    store: memory,
    scheduler,
    permissionGranted: true,
  });
  assert.equal(calls[0], 'cancel');
  assert.match(calls[1] ?? '', /Depot agent was paid once today/);
  assert.match(calls[1] ?? '', /2 left the rule/);
  assert.doesNotMatch(calls[1] ?? '', /258 of 300/);
  const kept = parseQuietSettings(memory.saved);
  assert.equal(kept.scheduledBody, calls[1]);
  await applyQuietPlan(
    {
      cancel: true,
      schedule: null,
      settings: { ...kept, enabled: false, scheduledForDay: null, scheduledBody: null, scheduledAt: null },
      persist: true,
    },
    scheduler,
    memory,
  );
  assert.equal(parseQuietSettings(memory.saved).enabled, false);
});
