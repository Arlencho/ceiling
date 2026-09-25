import { PublicKey } from '@solana/web3.js';

import { fetchMintDecimals, type ChainClient, type SignAndSend } from './chain';
import {
  daysFromDelay,
  formatChainInstant,
  formatHoldAmount,
  isDefaultKey,
  shortKey,
  waitLabel,
} from './hold';
import { freezeHoldVault, recoverHoldVault, stopHoldWithdrawal } from './holdActions';
import { listGuardedVaults, readHoldVaults, readHoldVault, readChainClock, type HoldVaultBundle } from './holdChain';
import { holdCreatedAt, type HoldAccount } from './holdRead';
import { futureHoldAlerts, holdAlertPlan } from './holdAlerts';
import type { HoldScheduler } from './holdNotify';
import { tokenSymbol } from './tokens';
import type { WalletStore } from './wallet';

export const GUARDED_KEY = 'veto.hold.guarded';
export const HOLD_SCHEDULED_KEY = 'veto.hold.alerts.scheduled';
export const GUARD_SEEN_KEY = 'veto.hold.guard.seen';
const SEEN_CAP = 500;

const CHANGE_DAILY = 1;
const CHANGE_DELAY = 2;
const CHANGE_SHARE = 4;
const CHANGE_GUARDIAN = 8;
const CHANGE_SAFE = 16;

export type GuardState = 'normal' | 'waiting' | 'frozen';

export type GuardAlert = {
  key: string;
  kind: 'held' | 'change';
  vault: string;
  withdrawalId: string | null;
  title: string;
  body: string;
};

export type GuardBrake = 'stop' | 'freeze' | 'recover';

export function guardPath(vault: string, withdrawalId?: string | null): string {
  const base = `/hold/guard?vault=${encodeURIComponent(vault)}`;
  return withdrawalId ? `${base}&id=${encodeURIComponent(withdrawalId)}` : base;
}

export function guardState(account: HoldAccount): GuardState {
  if (account.frozen) return 'frozen';
  if (account.pending.length > 0 || account.change.active) return 'waiting';
  return 'normal';
}

export function guardStateLabel(account: HoldAccount, decimals: number, tokenName: string): string {
  const state = guardState(account);
  if (state === 'frozen') return 'Frozen. Nothing can leave.';
  if (state === 'normal') return 'Normal. Nothing is waiting.';
  const first = account.pending[0];
  if (account.pending.length > 1) return `${account.pending.length} withdrawals are waiting.`;
  if (first) {
    return `Waiting: ${formatHoldAmount(first.amount, decimals)} ${tokenName} to ${shortKey(first.destination.toBase58())}.`;
  }
  return 'Waiting: a settings change that loosens the rules.';
}

function waitText(delaySecs: bigint): string {
  const days = daysFromDelay(delaySecs);
  if (days) return waitLabel(days);
  const hours = delaySecs / 3_600n;
  return hours === 1n ? '1 hour' : `${hours.toString()} hours`;
}

function percent(bps: number): string {
  const whole = bps / 100;
  return `${Number.isInteger(whole) ? whole.toString() : whole.toFixed(2)}%`;
}

/** Each rule the proposed change loosens, in plain words, with the token named on every amount. */
export function changeLoosenLines(args: {
  account: HoldAccount;
  decimals: number;
  tokenName: string;
  viewer?: PublicKey | null;
}): string[] {
  const { account, decimals, tokenName } = args;
  const change = account.change;
  if (!change.active) return [];
  const lines: string[] = [];
  if (change.fields & CHANGE_DAILY) {
    lines.push(
      `The everyday limit goes up from ${formatHoldAmount(account.dailyLimit, decimals)} ${tokenName} to ${formatHoldAmount(change.dailyLimit, decimals)} ${tokenName} a day`,
    );
  }
  if (change.fields & CHANGE_DELAY) {
    lines.push(`The wait gets shorter, from ${waitText(account.delaySecs)} to ${waitText(change.delaySecs)}`);
  }
  if (change.fields & CHANGE_SHARE) {
    lines.push(
      `The big share goes up from ${percent(account.bigShareBps)} to ${percent(change.bigShareBps)} of the vault`,
    );
  }
  if (change.fields & CHANGE_GUARDIAN) {
    const you = args.viewer ? account.guardian.equals(args.viewer) : false;
    if (isDefaultKey(change.guardian.toBase58())) {
      lines.push(you ? 'You stop being the guardian' : 'The guardian key is removed');
    } else {
      lines.push(
        you
          ? `The guardian changes from you to ${shortKey(change.guardian.toBase58())}`
          : `The guardian key changes to ${shortKey(change.guardian.toBase58())}`,
      );
    }
  }
  if (change.fields & CHANGE_SAFE) {
    lines.push(`The safe address changes to ${shortKey(change.safeAddress.toBase58())}`);
  }
  return lines;
}

/** What the guardian phone announces for one vault. One alert per held withdrawal and per proposed change. */
export function guardAlertsFor(args: {
  account: HoldAccount;
  decimals: number;
  tokenName: string;
  guardian: PublicKey;
  timeZone?: string;
}): GuardAlert[] {
  const { account, decimals, tokenName } = args;
  const vault = account.address.toBase58();
  const alerts: GuardAlert[] = [];
  for (const row of account.pending) {
    const amount = `${formatHoldAmount(row.amount, decimals)} ${tokenName}`;
    alerts.push({
      key: `guard:${vault}:held:${row.id.toString()}`,
      kind: 'held',
      vault,
      withdrawalId: row.id.toString(),
      title: `Held: ${amount} to ${shortKey(row.destination.toBase58())}`,
      body: `Waits until ${formatChainInstant(row.unlockAt, args.timeZone)}. You guard this vault. Tap to stop it or freeze the vault.`,
    });
  }
  const lines = changeLoosenLines({ account, decimals, tokenName, viewer: args.guardian });
  if (account.change.active && lines.length > 0) {
    alerts.push({
      key: `guard:${vault}:change:${account.change.effectiveAt.toString()}:${account.change.fields}`,
      kind: 'change',
      vault,
      withdrawalId: null,
      title: 'A settings change was proposed for a vault you guard',
      body: `${lines.join('. ')}. Applies ${formatChainInstant(account.change.effectiveAt, args.timeZone)}. Tap to freeze the vault or move everything to the safe address.`,
    });
  }
  return alerts;
}

export function unseenGuardAlerts(alerts: readonly GuardAlert[], seen: ReadonlySet<string>): GuardAlert[] {
  return alerts.filter((alert) => !seen.has(alert.key));
}

async function readList(store: WalletStore, key: string): Promise<unknown> {
  const raw = await store.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export async function rememberGuardedVaults(
  store: WalletStore,
  guardian: PublicKey,
  vaults: readonly string[],
): Promise<void> {
  await store.setItem(GUARDED_KEY, JSON.stringify({ guardian: guardian.toBase58(), vaults: [...vaults] }));
}

export async function rememberedGuardedVaults(store: WalletStore, guardian: PublicKey): Promise<string[]> {
  const parsed = await readList(store, GUARDED_KEY);
  if (typeof parsed !== 'object' || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  if (record.guardian !== guardian.toBase58()) return [];
  return strings(record.vaults);
}

/**
 * Finds the vaults this wallet guards and remembers them. When the search fails,
 * for example on a busy public node, the remembered vaults are read directly instead.
 */
export async function discoverGuardedVaults(args: {
  client: ChainClient;
  store: WalletStore;
  guardian: PublicKey;
}): Promise<HoldAccount[]> {
  try {
    const found = await listGuardedVaults(args.client, args.guardian);
    await rememberGuardedVaults(
      args.store,
      args.guardian,
      found.map((vault) => vault.address.toBase58()),
    );
    return found;
  } catch {
    const remembered = await rememberedGuardedVaults(args.store, args.guardian);
    if (remembered.length === 0) return [];
    const keys: PublicKey[] = [];
    for (const text of remembered) {
      try {
        keys.push(new PublicKey(text));
      } catch {
        // A damaged entry is skipped.
      }
    }
    const read = await readHoldVaults(args.client, keys);
    return read.filter((vault) => vault.guardian.equals(args.guardian));
  }
}

/**
 * The background read for a guardian phone: find guarded vaults, then announce each
 * held withdrawal and each proposed change once, and schedule remaining reminders.
 * Returns the keys that were announced.
 */
export async function raiseGuardAlerts(args: {
  client: ChainClient;
  store: WalletStore;
  guardian: PublicKey;
  present: (alert: GuardAlert) => Promise<void>;
  scheduler?: HoldScheduler;
  nowSec?: bigint;
  ensureChannel?: () => Promise<void>;
  decimalsOf?: (mint: PublicKey) => Promise<number>;
  timeZone?: string;
}): Promise<string[]> {
  const vaults = await discoverGuardedVaults(args);
  const scheduled = new Set(strings(await readList(args.store, HOLD_SCHEDULED_KEY)));
  const liveKeys = new Set<string>();
  const nowSec = args.scheduler && vaults.length > 0 ? args.nowSec ?? await readChainClock(args.client.connection) : 0n;
  const decimalsOf = args.decimalsOf ?? ((mint: PublicKey) => fetchMintDecimals(args.client, mint));
  const seenList = strings(await readList(args.store, GUARD_SEEN_KEY));
  const seen = new Set(seenList);
  const decimalsByMint = new Map<string, number>();
  const raised: string[] = [];
  let channelReady = false;
  for (let account of vaults) {
    if (account.pending.length === 0 && !account.change.active) continue;
    const bundle = args.scheduler ? await readHoldVault(args.client, account.address) : null;
    if (bundle) account = bundle.account;
    const mintKey = account.mint.toBase58();
    let decimals = decimalsByMint.get(mintKey);
    if (decimals == null) {
      decimals = bundle?.decimals ?? await decimalsOf(account.mint);
      decimalsByMint.set(mintKey, decimals);
    }
    if (bundle && args.scheduler) {
      await args.scheduler.ensureChannel();
      channelReady = true;
      for (const row of account.pending) {
        const plan = holdAlertPlan({
          vault: account.address.toBase58(),
          withdrawalId: row.id.toString(),
          amountLabel: `${formatHoldAmount(row.amount, decimals)} ${tokenSymbol(mintKey)}`,
          destinationLabel: shortKey(row.destination.toBase58()),
          createdAt: holdCreatedAt(account, row, bundle.ledger.entries),
          unlockAt: row.unlockAt,
          newAddress: !account.known.some(key => key.equals(row.destination)),
          timeZone: args.timeZone,
        }).map(alert => ({ ...alert, key: `guard:${alert.key}` }));
        for (const alert of plan) liveKeys.add(alert.key);
        for (const alert of futureHoldAlerts(plan, nowSec)) {
          await args.scheduler.schedule(alert, account.address.toBase58(), row.id.toString());
          scheduled.add(alert.key);
        }
      }
    }
    const alerts = guardAlertsFor({
      account,
      decimals,
      tokenName: tokenSymbol(mintKey),
      guardian: args.guardian,
      timeZone: args.timeZone,
    });
    for (const alert of unseenGuardAlerts(alerts, seen)) {
      if (!channelReady) {
        await args.ensureChannel?.();
        channelReady = true;
      }
      await args.present(alert);
      seen.add(alert.key);
      seenList.push(alert.key);
      raised.push(alert.key);
    }
  }
  if (args.scheduler) {
    for (const key of scheduled) {
      if (key.startsWith('guard:') && !liveKeys.has(key)) {
        await args.scheduler.cancel(key);
        scheduled.delete(key);
      }
    }
    await args.store.setItem(HOLD_SCHEDULED_KEY, JSON.stringify([...scheduled]));
  }
  if (raised.length > 0) {
    await args.store.setItem(GUARD_SEEN_KEY, JSON.stringify(seenList.slice(-SEEN_CAP)));
  }
  return raised;
}

/**
 * One brake, signed by the guardian key through the connected wallet.
 * Refuses before the wallet opens when the connected key is not this vault's guardian.
 */
export async function guardBrake(args: {
  kind: GuardBrake;
  client: ChainClient;
  signAndSend: SignAndSend;
  guardian: PublicKey;
  bundle: HoldVaultBundle;
  withdrawalId?: bigint | null;
}): Promise<string> {
  const { account } = args.bundle;
  if (isDefaultKey(account.guardian.toBase58()) || !account.guardian.equals(args.guardian)) {
    throw new Error('The connected key is not the guardian of this vault.');
  }
  const common = {
    client: args.client,
    signAndSend: args.signAndSend,
    authority: args.guardian,
    owner: account.owner,
    vaultId: account.vaultId,
  };
  if (args.kind === 'stop') {
    if (args.withdrawalId == null) throw new Error('No withdrawal is waiting.');
    return stopHoldWithdrawal({ ...common, id: args.withdrawalId });
  }
  if (args.kind === 'freeze') {
    if (account.frozen) throw new Error('The vault is already frozen.');
    return freezeHoldVault(common);
  }
  if (args.bundle.balance <= 0n) throw new Error('The vault is empty. There is nothing to move.');
  return recoverHoldVault({
    ...common,
    safeAddress: account.safeAddress,
    mint: account.mint,
    tokenProgram: args.bundle.tokenProgram,
  });
}

export function guardResultLine(args: {
  kind: GuardBrake;
  amountLabel: string;
  tokenName: string;
  destinationLabel: string;
  safeLabel: string;
}): string {
  if (args.kind === 'stop') {
    return `Stopped. ${args.amountLabel} ${args.tokenName} to ${args.destinationLabel} will not be paid.`;
  }
  if (args.kind === 'freeze') {
    return 'Frozen. Nothing can leave this vault until the owner and you unfreeze it.';
  }
  return `Moved. ${args.amountLabel} ${args.tokenName} went to the safe address ${args.safeLabel}.`;
}
