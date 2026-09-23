import { PublicKey } from '@solana/web3.js';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { createClient, fetchLedger, fetchMintDecimals, fetchOwnerMandates } from './chain';
import { tryLoadConfig } from './config';
import type { MandateAccount } from './mandate';
import { secureStore } from './mwa';
import {
  DECISION_NOTIFY_INTERVAL_MINUTES,
  deliverDecisionNotices,
  parseSeenIds,
  seenStorageKey,
  serializeSeenIds,
  type DecisionNotice,
  type NotifyMandateLedger,
} from './notify';
import { loadSession } from './wallet';

export const DECISION_NOTIFY_TASK = 'veto-decision-notify';
export const DECISION_CHANNEL_ID = 'decisions';

const ASKED_KEY = 'veto.notify.asked';

// Reads ledgers and raises local notifications. It does not sign, and nothing
// in the payment path calls it.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

TaskManager.defineTask(DECISION_NOTIFY_TASK, async () => {
  try {
    await runDecisionNotifyScan();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

let scanTail: Promise<void> = Promise.resolve();

export function runDecisionNotifyScan(): Promise<void> {
  const run = scanTail.then(scanOnce, scanOnce);
  scanTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function decimalsForMint(
  client: ReturnType<typeof createClient>,
  mint: string,
  fallback: number,
  cache: Map<string, number>,
): Promise<number> {
  const cached = cache.get(mint);
  if (cached != null) {
    return cached;
  }
  let decimals = fallback;
  try {
    decimals = await fetchMintDecimals(client, new PublicKey(mint));
  } catch {
    decimals = fallback;
  }
  cache.set(mint, decimals);
  return decimals;
}

async function scanOnce(): Promise<void> {
  const session = await loadSession(secureStore);
  if (!session) {
    return;
  }
  const loaded = tryLoadConfig();
  if (!loaded.ok) {
    return;
  }
  const client = createClient(loaded.config);
  let owner: PublicKey;
  try {
    owner = new PublicKey(session.ownerPublicKey);
  } catch {
    return;
  }
  let mandates: MandateAccount[];
  try {
    mandates = await fetchOwnerMandates(client, owner);
  } catch {
    throw new Error('Could not read rules for this owner');
  }

  const decimalsCache = new Map<string, number>();
  const ledgers: NotifyMandateLedger[] = [];
  let unread = 0;
  for (const mandate of mandates) {
    try {
      const snapshot = await fetchLedger(client, new PublicKey(mandate.address));
      const decimals = await decimalsForMint(
        client,
        mandate.mint,
        loaded.config.mintDecimals,
        decimalsCache,
      );
      ledgers.push({
        mandate: mandate.address,
        merchant: mandate.merchant,
        perTxMax: mandate.perTxMax,
        decimals,
        rows: snapshot.entries,
      });
    } catch {
      unread += 1;
    }
  }

  const seenByMandate = new Map<string, Set<string>>();
  for (const ledger of ledgers) {
    const raw = await secureStore.getItem(seenStorageKey(ledger.mandate));
    // A missing key is not an empty seen set. deliverDecisionNotices stores
    // the rows already on that rule and does not announce them. Text that is
    // not a JSON array is the same case: seed quietly instead of announcing.
    if (raw === null) {
      continue;
    }
    const seen = parseSeenIds(ledger.mandate, raw);
    if (seen === null) {
      continue;
    }
    seenByMandate.set(ledger.mandate, seen);
  }
  await deliverDecisionNotices({
    ledgers,
    seenByMandate,
    present: presentDecisionNotice,
    saveSeen: async (mandate, ids) => {
      await secureStore.setItem(seenStorageKey(mandate), serializeSeenIds(mandate, ids));
    },
  });
  if (unread > 0) {
    throw new Error('A mandate ledger could not be read');
  }
}

export async function presentDecisionNotice(notice: DecisionNotice): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: notice.id,
    content: {
      title: notice.title,
      body: notice.body,
      data: { decisionId: notice.id },
    },
    trigger: { channelId: DECISION_CHANNEL_ID },
  });
}

async function ensureDecisionChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(DECISION_CHANNEL_ID, {
    name: 'Decisions',
    importance: Notifications.AndroidImportance.DEFAULT,
    description: 'Paid and refused decisions on rules you hold.',
  });
}

export async function registerDecisionNotifyTask(): Promise<void> {
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
    return;
  }
  const registered = await TaskManager.isTaskRegisteredAsync(DECISION_NOTIFY_TASK);
  if (registered) {
    return;
  }
  await BackgroundTask.registerTaskAsync(DECISION_NOTIFY_TASK, {
    minimumInterval: DECISION_NOTIFY_INTERVAL_MINUTES,
  });
}

async function registerQuietly(): Promise<void> {
  try {
    await registerDecisionNotifyTask();
  } catch {
    // A foreground read still runs when the background worker is refused.
  }
}

let asking: Promise<void> | null = null;

export function askAfterFirstRuleOpened(): Promise<void> {
  if (asking) {
    return asking;
  }
  asking = askOnce().finally(() => {
    asking = null;
  });
  return asking;
}

async function askOnce(): Promise<void> {
  const asked = await secureStore.getItem(ASKED_KEY);
  const current = await Notifications.getPermissionsAsync();
  if (asked === '1') {
    if (!current.granted) {
      return;
    }
    // The layout hook reads the chain on mount and when the app resumes.
    // Opening another rule only makes sure the background worker is registered.
    await registerQuietly();
    return;
  }
  await ensureDecisionChannel();
  const next = current.granted ? current : await Notifications.requestPermissionsAsync();
  await secureStore.setItem(ASKED_KEY, '1');
  if (!next.granted) {
    return;
  }
  await registerQuietly();
  await runDecisionNotifyScan();
}

export async function scanDecisionsIfAllowed(): Promise<void> {
  const current = await Notifications.getPermissionsAsync();
  if (!current.granted) {
    return;
  }
  await ensureDecisionChannel();
  await registerQuietly();
  await runDecisionNotifyScan();
}
