import { KIND_PAID, KIND_REFUSED } from './constants';
import { isLocalDay, formatBaseUnits, remainingCap } from './format';
import { isActive, type MandateAccount } from './mandate';
import { parseAddressBook, ADDRESS_BOOK_KEY } from './addressBook';
import { canonicalAddress } from './ruleRequest';
import { displayPurpose } from './ruleView';
import type { WalletStore } from './wallet';

export const QUIET_NOTE_KEY = 'veto.quietNote';
export const QUIET_NOTE_ID = 'veto-quiet-note';
export const QUIET_NOTE_CHANNEL = 'quiet-note';
/** Same storage key as SELECTED_MANDATE_KEY in useChain.ts. */
export const QUIET_NOTE_RULE_KEY = 'veto.mandate.selected';

export const QUIET_NOTE_HONEST =
  'The phone checks the blockchain about every 15 minutes in the background. Battery saving can delay a check, so the note says when it last looked. It never asks you to do anything.';

export const QUIET_NOTE_INTRO =
  'One line, at a time you choose, and never more than one. It is off until you turn it on. Refusals still reach you the moment they happen, whatever you pick here.';

export const QUIET_NOTE_CAPTION = "Example of tonight's note";

export type QuietSend = 'every-evening' | 'moved' | 'never';

export const QUIET_SEND_OPTIONS: readonly {
  id: QuietSend;
  title: string;
  detail: string | null;
}[] = [
  {
    id: 'every-evening',
    title: 'Every evening',
    detail: 'Even on a quiet day, so you know the rule is still live.',
  },
  {
    id: 'moved',
    title: 'Only on days something moved',
    detail: 'Silence means no payments and no refusals today.',
  },
  { id: 'never', title: 'Never', detail: null },
];

export type QuietSettings = {
  enabled: boolean;
  send: QuietSend;
  hour: number;
  minute: number;
  lastSentDay: string | null;
  scheduledForDay: string | null;
  scheduledBody: string | null;
  scheduledAt: number | null;
};

export type QuietNoteCopy = {
  headline: string;
  detail: string;
  body: string;
  moved: boolean;
  daysPhrase: string | null;
  truncated: boolean;
};

export type QuietLedger = {
  mandate: string;
  rows: readonly { ts: bigint; kind: number; amount: bigint }[];
  total: number | null;
  decimals: number;
};

export type QuietNoteScheduler = {
  cancel(id: string): Promise<void>;
  schedule(args: { id: string; body: string; when: 'now' | number }): Promise<void>;
};

export type QuietPlan = {
  cancel: boolean;
  schedule: { body: string; when: 'now' | number } | null;
  settings: QuietSettings;
  persist: boolean;
};

export function defaultQuietSettings(): QuietSettings {
  return {
    enabled: false,
    send: 'every-evening',
    hour: 21,
    minute: 0,
    lastSentDay: null,
    scheduledForDay: null,
    scheduledBody: null,
    scheduledAt: null,
  };
}

function isSend(value: unknown): value is QuietSend {
  return value === 'every-evening' || value === 'moved' || value === 'never';
}

function clockNumber(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    return null;
  }
  return value;
}

function optionalDay(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  return value;
}

export function parseQuietSettings(raw: string | null): QuietSettings {
  const fallback = defaultQuietSettings();
  if (!raw) {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fallback;
    }
    const row = parsed as Record<string, unknown>;
    const hour = clockNumber(row.hour, 23);
    const minute = clockNumber(row.minute, 59);
    if (!isSend(row.send) || hour == null || minute == null || typeof row.enabled !== 'boolean') {
      return fallback;
    }
    return {
      enabled: row.enabled,
      send: row.send,
      hour,
      minute,
      lastSentDay: optionalDay(row.lastSentDay),
      scheduledForDay: optionalDay(row.scheduledForDay),
      scheduledBody: typeof row.scheduledBody === 'string' ? row.scheduledBody : null,
      scheduledAt: typeof row.scheduledAt === 'number' && Number.isFinite(row.scheduledAt) ? row.scheduledAt : null,
    };
  } catch {
    return fallback;
  }
}

export function clockLabel(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function localDayKeyFromDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear().toString()}-${month}-${day}`;
}

export function shiftClock(
  hour: number,
  minute: number,
  deltaMinutes: number,
): { hour: number; minute: number } {
  const total = (hour * 60 + minute + deltaMinutes + 1440) % 1440;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

export function quietFire(now: Date, hour: number, minute: number): Date {
  const fire = new Date(now.getTime());
  fire.setHours(hour, minute, 0, 0);
  return fire;
}

export function quietActionLabel(send: QuietSend, enabled: boolean): string {
  if (send === 'never') {
    return 'Keep the quiet note off';
  }
  if (enabled) {
    return 'Save the quiet note';
  }
  return 'Turn on the quiet note';
}

export function daysToGoPhrase(expiresAt: bigint, nowSec: bigint): string | null {
  if (nowSec >= expiresAt) {
    return null;
  }
  const days = (expiresAt - nowSec) / 86400n;
  if (days <= 0n) {
    return 'Less than a day to go';
  }
  if (days === 1n) {
    return '1 day to go';
  }
  return `${days.toString()} days to go`;
}

export function agentLabel(names: Readonly<Record<string, string>>, agent: string, purpose: string): string {
  const key = canonicalAddress(agent);
  const saved = key ? names[key] : undefined;
  if (saved && saved.trim().length > 0) {
    return saved.trim();
  }
  const shown = displayPurpose(purpose).trim();
  return shown.length > 0 ? shown : 'Your agent';
}

function countPhrase(count: number): string {
  return count === 1 ? 'once' : `${count.toString()} times`;
}

export function quietNoteCopy(args: {
  name: string;
  cap: bigint;
  spent: bigint;
  expiresAt: bigint;
  decimals: number;
  rows: readonly { ts: bigint; kind: number; amount: bigint }[];
  ledgerTotal: number | null;
  now: Date;
}): QuietNoteCopy {
  const nowMs = args.now.getTime();
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  let paidCount = 0;
  let refusedCount = 0;
  let paidAmount = 0n;
  for (const row of args.rows) {
    if (!isLocalDay(row.ts, nowMs)) {
      continue;
    }
    if (row.kind === KIND_PAID) {
      paidCount += 1;
      paidAmount += row.amount;
    } else if (row.kind === KIND_REFUSED) {
      refusedCount += 1;
    }
  }
  const oldest = args.rows[0];
  const truncated =
    args.ledgerTotal != null &&
    args.ledgerTotal > args.rows.length &&
    oldest != null &&
    isLocalDay(oldest.ts, nowMs);
  let headline: string;
  if (paidCount === 0 && refusedCount === 0) {
    headline = 'All good today. Nothing paid, nothing moved.';
  } else if (paidCount === 0) {
    headline = `All good today. ${args.name} asked ${countPhrase(refusedCount)} outside the rule and was refused. Nothing paid, nothing moved.`;
  } else if (refusedCount === 0) {
    const amount = formatBaseUnits(paidAmount, args.decimals);
    headline = `${args.name} was paid ${countPhrase(paidCount)} today. ${amount} left the rule.`;
  } else {
    headline = `${args.name} was paid ${countPhrase(paidCount)} and refused ${countPhrase(refusedCount)} today.`;
  }
  if (truncated) {
    headline = `From the decisions still stored on this rule. ${headline}`;
  }
  const left = formatBaseUnits(remainingCap(args.cap, args.spent), args.decimals);
  const cap = formatBaseUnits(args.cap, args.decimals);
  const daysPhrase = daysToGoPhrase(args.expiresAt, nowSec);
  const detail = `${left} of ${cap} left. ${daysPhrase ?? 'The rule has ended.'} Last check ${clockLabel(args.now)}.`;
  return {
    headline,
    detail,
    body: `${headline}\n${detail}`,
    moved: paidCount + refusedCount > 0,
    daysPhrase,
    truncated,
  };
}

function usableMandate(mandate: MandateAccount, nowSec: bigint): boolean {
  if (typeof mandate.expiresAt !== 'bigint' || typeof mandate.cap !== 'bigint' || typeof mandate.spent !== 'bigint') {
    return false;
  }
  if (typeof mandate.status !== 'number' || typeof mandate.agent !== 'string' || typeof mandate.purpose !== 'string') {
    return false;
  }
  return isActive(mandate, nowSec);
}

export function quietRuleFor(args: {
  mandates: readonly MandateAccount[];
  ledgers: readonly QuietLedger[];
  selectedAddress: string | null;
  names: Readonly<Record<string, string>>;
  now: Date;
}): { copy: QuietNoteCopy; address: string } | null {
  const nowSec = BigInt(Math.floor(args.now.getTime() / 1000));
  const live = args.mandates.filter((mandate) => usableMandate(mandate, nowSec));
  const chosen = live.find((mandate) => mandate.address === args.selectedAddress) ?? live[0] ?? null;
  if (!chosen) {
    return null;
  }
  const ledger = args.ledgers.find((item) => item.mandate === chosen.address);
  if (!ledger) {
    return null;
  }
  const copy = quietNoteCopy({
    name: agentLabel(args.names, chosen.agent, chosen.purpose),
    cap: chosen.cap,
    spent: chosen.spent,
    expiresAt: chosen.expiresAt,
    decimals: ledger.decimals,
    rows: ledger.rows,
    ledgerTotal: ledger.total,
    now: args.now,
  });
  return { copy, address: chosen.address };
}

export function planQuietNote(args: {
  settings: QuietSettings;
  copy: QuietNoteCopy | null;
  now: Date;
  permissionGranted: boolean;
}): QuietPlan {
  const today = localDayKeyFromDate(args.now);
  const base = args.settings;
  const idle: QuietPlan = { cancel: false, schedule: null, settings: base, persist: false };

  if (!base.enabled || base.send === 'never') {
    if (!base.enabled && base.scheduledForDay == null && base.send !== 'never') {
      return idle;
    }
    if (base.send === 'never' && !base.enabled && base.scheduledForDay == null) {
      return idle;
    }
    const next = { ...base, enabled: false, scheduledForDay: null, scheduledBody: null, scheduledAt: null };
    return {
      cancel: base.scheduledForDay != null || base.enabled,
      schedule: null,
      settings: next,
      persist: base.enabled || base.scheduledForDay != null || base.send === 'never',
    };
  }

  if (!args.permissionGranted) {
    return {
      cancel: true,
      schedule: null,
      settings: { ...base, scheduledForDay: null, scheduledBody: null, scheduledAt: null },
      persist: true,
    };
  }

  if (!args.copy || args.copy.daysPhrase == null) {
    return {
      cancel: base.scheduledForDay != null,
      schedule: null,
      settings: { ...base, scheduledForDay: null, scheduledBody: null, scheduledAt: null },
      persist: base.scheduledForDay != null,
    };
  }

  if (base.lastSentDay === today) {
    return idle;
  }

  const fire = quietFire(args.now, base.hour, base.minute);
  const want = base.send === 'every-evening' || args.copy.moved;
  const body = args.copy.body;

  if (args.now.getTime() >= fire.getTime()) {
    if (base.scheduledForDay === today) {
      return {
        cancel: false,
        schedule: null,
        settings: { ...base, lastSentDay: today, scheduledForDay: null, scheduledBody: null, scheduledAt: null },
        persist: true,
      };
    }
    if (!want) {
      return {
        cancel: base.scheduledForDay != null,
        schedule: null,
        settings: { ...base, scheduledForDay: null, scheduledBody: null, scheduledAt: null },
        persist: base.scheduledForDay != null,
      };
    }
    return {
      cancel: true,
      schedule: { body, when: 'now' },
      settings: { ...base, lastSentDay: today, scheduledForDay: null, scheduledBody: null, scheduledAt: null },
      persist: true,
    };
  }

  if (!want) {
    return {
      cancel: base.scheduledForDay != null,
      schedule: null,
      settings: { ...base, scheduledForDay: null, scheduledBody: null, scheduledAt: null },
      persist: base.scheduledForDay != null,
    };
  }

  const at = fire.getTime();
  if (base.scheduledForDay === today && base.scheduledBody === body && base.scheduledAt === at) {
    return idle;
  }
  return {
    cancel: true,
    schedule: { body, when: at },
    settings: { ...base, scheduledForDay: today, scheduledBody: body, scheduledAt: at },
    persist: true,
  };
}

export async function loadQuietSettings(store: WalletStore): Promise<QuietSettings> {
  return parseQuietSettings(await store.getItem(QUIET_NOTE_KEY));
}

export async function applyQuietPlan(
  plan: QuietPlan,
  scheduler: QuietNoteScheduler,
  store: WalletStore,
): Promise<void> {
  if (plan.schedule) {
    await scheduler.cancel(QUIET_NOTE_ID);
    await scheduler.schedule({ id: QUIET_NOTE_ID, body: plan.schedule.body, when: plan.schedule.when });
  } else if (plan.cancel) {
    await scheduler.cancel(QUIET_NOTE_ID);
  }
  if (plan.persist) {
    await store.setItem(QUIET_NOTE_KEY, JSON.stringify(plan.settings));
  }
}

export async function refreshQuietNote(args: {
  mandates: readonly MandateAccount[];
  ledgers: readonly QuietLedger[];
  now: Date;
  selectedAddress: string | null;
  store: WalletStore;
  scheduler: QuietNoteScheduler;
  permissionGranted: boolean;
  settingsOverride?: QuietSettings;
}): Promise<QuietPlan> {
  const names = parseAddressBook(await args.store.getItem(ADDRESS_BOOK_KEY));
  const settings = args.settingsOverride ?? (await loadQuietSettings(args.store));
  const picked = quietRuleFor({
    mandates: args.mandates,
    ledgers: args.ledgers,
    selectedAddress: args.selectedAddress,
    names,
    now: args.now,
  });
  const plan = planQuietNote({
    settings,
    copy: picked?.copy ?? null,
    now: args.now,
    permissionGranted: args.permissionGranted,
  });
  if (args.settingsOverride) {
    plan.persist = true;
    if (!plan.settings.enabled) {
      plan.cancel = true;
    }
  }
  await applyQuietPlan(plan, args.scheduler, args.store);
  return plan;
}

export async function expoQuietScheduler(): Promise<QuietNoteScheduler> {
  const Notifications = await import('expo-notifications');
  return {
    async cancel(id) {
      try {
        await Notifications.cancelScheduledNotificationAsync(id);
      } catch {
        // Nothing scheduled is a valid quiet state.
      }
    },
    async schedule({ id, body, when }) {
      await Notifications.setNotificationChannelAsync(QUIET_NOTE_CHANNEL, {
        name: 'Quiet note',
        importance: Notifications.AndroidImportance.DEFAULT,
        description: 'One daily note about your rule. It never asks you to do anything.',
      });
      await Notifications.scheduleNotificationAsync({
        identifier: id,
        content: {
          title: 'Veto',
          body,
          data: { quietNote: '1' },
        },
        trigger:
          when === 'now'
            ? { channelId: QUIET_NOTE_CHANNEL }
            : {
                type: Notifications.SchedulableTriggerInputTypes.DATE,
                date: when,
                channelId: QUIET_NOTE_CHANNEL,
              },
      });
    },
  };
}
