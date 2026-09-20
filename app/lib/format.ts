import { KIND_PAID, KIND_REFUSED, kindName, statusName } from './constants';
import type { RingEntry } from './ring';

export function formatBaseUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const sign = negative ? '-' : '';
  if (frac === 0n) {
    return `${sign}${whole.toString()}`;
  }
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${whole.toString()}.${fracStr}`;
}

export function parseBaseUnits(text: string, decimals: number): bigint {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('amount is empty');
  }
  const negative = trimmed.startsWith('-');
  const raw = negative ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('amount must be a non-negative decimal');
  }
  const [wholeRaw, fracRaw = ''] = raw.split('.');
  if (fracRaw.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimal places`);
  }
  const whole = BigInt(wholeRaw || '0');
  const frac = BigInt(fracRaw.padEnd(decimals, '0') || '0');
  const value = whole * 10n ** BigInt(decimals) + frac;
  return negative ? -value : value;
}

export function remainingCap(cap: bigint, spent: bigint): bigint {
  return cap > spent ? cap - spent : 0n;
}

export function formatTimeLeft(expiresAt: bigint, nowSec: bigint): string {
  if (nowSec >= expiresAt) {
    return 'expired';
  }
  const sec = expiresAt - nowSec;
  const days = sec / 86400n;
  const hours = (sec % 86400n) / 3600n;
  const minutes = (sec % 3600n) / 60n;
  if (days > 0n) {
    return `${days.toString()}d ${hours.toString()}h left`;
  }
  if (hours > 0n) {
    return `${hours.toString()}h ${minutes.toString()}m left`;
  }
  if (minutes > 0n) {
    return `${minutes.toString()}m left`;
  }
  return 'less than a minute left';
}

export function isLocalDay(unixSeconds: bigint, nowMs: number): boolean {
  const then = new Date(Number(unixSeconds) * 1000);
  const now = new Date(nowMs);
  return (
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  );
}

export function todaysAgentDecisions<T extends RingEntry>(entries: readonly T[], nowMs: number): T[] {
  const todays = entries.filter(
    (entry) =>
      (entry.kind === KIND_PAID || entry.kind === KIND_REFUSED) && isLocalDay(entry.ts, nowMs),
  );
  return todays.slice().reverse();
}

export function newestFirst<T>(entries: readonly T[]): T[] {
  return entries.slice().reverse();
}

export function explorerTxUrl(
  signature: string,
  cluster: string,
  rpcUrl: string,
): string {
  if (cluster === 'devnet' || cluster === 'testnet' || cluster === 'mainnet-beta') {
    return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
  }
  const custom = encodeURIComponent(rpcUrl);
  return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${custom}`;
}

export function formatKindLabel(kind: number): string {
  const name = kindName(kind);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function formatStatusLabel(status: number): string {
  return statusName(status);
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

export function formatUnix(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    return unixSeconds.toString();
  }
  const year = date.getFullYear().toString().padStart(4, '0');
  return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}
