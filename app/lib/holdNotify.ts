import * as Notifications from 'expo-notifications';
import { PublicKey } from '@solana/web3.js';

import { tryLoadConfig } from './config';
import { secureStore } from './mwa';
import { dueHoldAlerts, futureHoldAlerts, holdAlertPlan, type HoldAlert } from './holdAlerts';
import { formatHoldAmount, shortKey } from './hold';
import { tokenSymbol } from './tokens';
import { holdClient, listHoldVaults, readChainClock, readHoldVault } from './holdChain';
import { guardPath, raiseGuardAlerts, HOLD_SCHEDULED_KEY, type GuardAlert } from './holdGuard';
import { holdCreatedAt } from './holdRead';
import { loadSession } from './wallet';

export const HOLD_CHANNEL_ID = 'hold';
const SEEN_KEY = 'veto.hold.alerts.seen';
const SCHEDULED_KEY = HOLD_SCHEDULED_KEY;

export type HoldScheduler = {
  ensureChannel(): Promise<void>;
  present(alert: HoldAlert, vault: string, withdrawalId: string): Promise<void>;
  schedule(alert: HoldAlert, vault: string, withdrawalId: string): Promise<void>;
  cancel(identifier: string): Promise<void>;
};

export function holdPathFromNoticeData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const vault = record.holdVault;
  const id = record.holdWithdrawal;
  if (typeof vault !== 'string' || vault.length === 0) return null;
  if (record.holdGuard === true) return guardPath(vault, typeof id === 'string' ? id : null);
  if (typeof id !== 'string' || id.length === 0) return `/hold/frozen?vault=${encodeURIComponent(vault)}`;
  return `/hold/held?vault=${encodeURIComponent(vault)}&id=${encodeURIComponent(id)}`;
}

export function expoHoldScheduler(): HoldScheduler {
  const importance = Notifications.AndroidImportance.HIGH ?? Notifications.AndroidImportance.DEFAULT;
  const dateType = Notifications.SchedulableTriggerInputTypes?.DATE ?? 'date';
  return {
    async ensureChannel() {
      await Notifications.setNotificationChannelAsync(HOLD_CHANNEL_ID, {
        name: 'Hold',
        importance,
        description: 'A waiting withdrawal. Hold alerts cannot be muted in the app.',
      });
    },
    async present(alert, vault, withdrawalId) {
      await Notifications.scheduleNotificationAsync({
        identifier: alert.key,
        content: noticeContent(alert, vault, withdrawalId),
        trigger: { channelId: HOLD_CHANNEL_ID },
      });
    },
    async schedule(alert, vault, withdrawalId) {
      await Notifications.scheduleNotificationAsync({
        identifier: alert.key,
        content: noticeContent(alert, vault, withdrawalId),
        trigger: {
          type: dateType,
          date: new Date(Number(alert.at) * 1000),
          channelId: HOLD_CHANNEL_ID,
        },
      });
    },
    async cancel(identifier) {
      try {
        await Notifications.cancelScheduledNotificationAsync(identifier);
      } catch {
        // Nothing scheduled under that id is a valid state.
      }
    },
  };
}

export function guardNoticeContent(alert: GuardAlert) {
  return {
    title: alert.title,
    body: alert.body,
    data: {
      holdVault: alert.vault,
      holdWithdrawal: alert.withdrawalId ?? '',
      holdGuard: true,
      holdAlert: alert.kind,
    },
  };
}

export async function presentGuardAlert(alert: GuardAlert): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: alert.key,
    content: guardNoticeContent(alert),
    trigger: { channelId: HOLD_CHANNEL_ID },
  });
}

function noticeContent(alert: HoldAlert, vault: string, withdrawalId: string) {
  return {
    title: alert.title,
    body: alert.body,
    data: { holdVault: vault, holdWithdrawal: withdrawalId, holdAlert: alert.name, holdGuard: alert.key.startsWith('guard:') },
  };
}

async function readKeys(key: string): Promise<string[]> {
  const raw = await secureStore.getItem(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

async function writeKeys(key: string, values: readonly string[]): Promise<void> {
  await secureStore.setItem(key, JSON.stringify(values));
}

export async function raiseHoldAlertsForOwner(args: {
  owner: PublicKey;
  scheduler: HoldScheduler;
  nowSec?: bigint;
}): Promise<string[]> {
  const loaded = tryLoadConfig();
  if (!loaded.ok || !loaded.config.mint) return [];
  const client = holdClient(loaded.config);
  const nowSec = args.nowSec ?? (await readChainClock(client.connection));
  const vaults = await listHoldVaults(client, args.owner);
  const seen = new Set(await readKeys(SEEN_KEY));
  const scheduled = new Set(await readKeys(SCHEDULED_KEY));
  const liveKeys = new Set<string>();
  const raised: string[] = [];
  await args.scheduler.ensureChannel();
  for (const listed of vaults) {
    const bundle = await readHoldVault(client, listed.address);
    const tokenName = tokenSymbol(bundle.account.mint.toBase58());
    for (const row of bundle.account.pending) {
      const createdAt = holdCreatedAt(bundle.account, row, bundle.ledger.entries);
      const amountLabel = `${formatHoldAmount(row.amount, bundle.decimals)} ${tokenName}`;
      const known = bundle.account.known.some((key) => key.equals(row.destination));
      const plan = holdAlertPlan({
        vault: bundle.account.address.toBase58(),
        withdrawalId: row.id.toString(),
        amountLabel,
        destinationLabel: shortKey(row.destination.toBase58()),
        createdAt,
        unlockAt: row.unlockAt,
        newAddress: !known,
      });
      for (const alert of plan) liveKeys.add(alert.key);
      for (const alert of dueHoldAlerts(plan, nowSec, seen)) {
        await args.scheduler.present(alert, bundle.account.address.toBase58(), row.id.toString());
        seen.add(alert.key);
        raised.push(alert.key);
      }
      for (const alert of futureHoldAlerts(plan, nowSec)) {
        await args.scheduler.schedule(alert, bundle.account.address.toBase58(), row.id.toString());
        scheduled.add(alert.key);
      }
    }
  }
  for (const key of scheduled) {
    if (!key.startsWith('guard:') && !liveKeys.has(key)) {
      await args.scheduler.cancel(key);
      scheduled.delete(key);
    }
  }
  await writeKeys(SEEN_KEY, [...seen]);
  await writeKeys(SCHEDULED_KEY, [...scheduled]);
  return raised;
}

/** Called from the 15 minute local check, in addition to the cloud watcher. */
export async function raiseHoldAlertsOnScan(): Promise<void> {
  const current = await Notifications.getPermissionsAsync();
  if (!current.granted) return;
  const session = await loadSession(secureStore);
  if (!session) return;
  let owner: PublicKey;
  try {
    owner = new PublicKey(session.ownerPublicKey);
  } catch {
    return;
  }
  const scheduler = expoHoldScheduler();
  let ownerError: unknown = null;
  try {
    await raiseHoldAlertsForOwner({ owner, scheduler });
  } catch (err) {
    ownerError = err;
  }
  try {
    await raiseHoldAlertsForGuardian({ guardian: owner, scheduler });
  } catch (err) {
    if (!ownerError) throw err;
  }
  if (ownerError) throw ownerError;
}

/** The same local read on the guardian phone: vaults that name this wallet as guardian. */
export async function raiseHoldAlertsForGuardian(args: {
  guardian: PublicKey;
  scheduler: HoldScheduler;
}): Promise<string[]> {
  const loaded = tryLoadConfig();
  if (!loaded.ok) return [];
  return raiseGuardAlerts({
    client: holdClient(loaded.config),
    store: secureStore,
    guardian: args.guardian,
    scheduler: args.scheduler,
    ensureChannel: () => args.scheduler.ensureChannel(),
    present: presentGuardAlert,
  });
}
