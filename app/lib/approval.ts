import { PublicKey } from '@solana/web3.js';

import { PURPOSE_MAX_LEN } from './constants';
import { parseBaseUnits } from './format';
import { showsIntroduction } from './onboarding';
import { canonicalAddress } from './ruleRequest';
import type { MandateTemplate } from './templates';
import { truncateAddress } from './wallet';

export const DURATION_DAYS = [7, 30, 90] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export type ApprovalLimits = {
  cap: bigint;
  max: bigint;
  expiresAt: bigint;
};

export function approvalSentence(args: {
  agent: string;
  payee: string;
  max: string;
  cap: string;
  until: string;
}): string {
  return `${args.agent} may pay ${args.payee} up to ${args.max} per payment and ${args.cap} in total, until ${args.until}`;
}

export function formatUntilDate(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    return unixSeconds.toString();
  }
  const month = MONTHS[date.getMonth()] ?? '';
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function expiryFromDays(days: number, nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000) + days * 86400);
}

export function expiryFromIsoDate(iso: string): bigint | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 23, 59, 59);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return BigInt(Math.floor(date.getTime() / 1000));
}

export function customDateWithin(iso: string, nowMs: number, ceilingSec: bigint | null): bigint | null {
  const at = expiryFromIsoDate(iso);
  if (at == null) {
    return null;
  }
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  if (at <= nowSec) {
    return null;
  }
  if (ceilingSec != null && at > ceilingSec) {
    return null;
  }
  return at;
}

export function durationChipAllowed(days: number, ceilingDays: number | null): boolean {
  if (ceilingDays == null) {
    return true;
  }
  return days <= ceilingDays;
}

export function clampToRequest(ceiling: ApprovalLimits, chosen: ApprovalLimits): ApprovalLimits {
  let cap = chosen.cap;
  if (cap > ceiling.cap) {
    cap = ceiling.cap;
  }
  if (cap < 0n) {
    cap = 0n;
  }
  let max = chosen.max;
  if (max > ceiling.max) {
    max = ceiling.max;
  }
  if (max > cap) {
    max = cap;
  }
  if (max < 0n) {
    max = 0n;
  }
  let expiresAt = chosen.expiresAt;
  if (expiresAt > ceiling.expiresAt) {
    expiresAt = ceiling.expiresAt;
  }
  return { cap, max, expiresAt };
}

export function templateCapCeiling(cap: bigint): bigint {
  if (cap < 1n) {
    return 1n;
  }
  const scaled = cap * 4n;
  return scaled > cap ? scaled : cap;
}

export function clampTemplate(args: { capCeiling: bigint; chosen: ApprovalLimits }): ApprovalLimits {
  let cap = args.chosen.cap;
  if (cap > args.capCeiling) {
    cap = args.capCeiling;
  }
  if (cap < 0n) {
    cap = 0n;
  }
  let max = args.chosen.max;
  if (max > cap) {
    max = cap;
  }
  if (max < 0n) {
    max = 0n;
  }
  return { cap, max, expiresAt: args.chosen.expiresAt };
}

export function capFromRing(args: { ceiling: bigint; fraction: number }): bigint {
  const ceiling = args.ceiling < 1n ? 1n : args.ceiling;
  if (ceiling <= 1n) {
    return 1n;
  }
  const raw = Number.isFinite(args.fraction) ? args.fraction : 0;
  const fraction = Math.min(1, Math.max(0, raw));
  const bps = BigInt(Math.round(fraction * 10000));
  return 1n + ((ceiling - 1n) * bps) / 10000n;
}

export function fractionFromAmount(value: bigint, ceiling: bigint): number {
  if (ceiling <= 1n || value >= ceiling) {
    return 1;
  }
  if (value <= 1n) {
    return 0;
  }
  const span = ceiling - 1n;
  const pos = value - 1n;
  return Number((pos * 10000n) / span) / 10000;
}

export function templateLimits(
  template: MandateTemplate,
  decimals: number,
): { cap: bigint; max: bigint; days: number; purpose: string } {
  const cap = parseBaseUnits(template.fields.cap, decimals);
  const max = parseBaseUnits(template.fields.perTxMax, decimals);
  const days = Number.parseInt(template.fields.expiryDays, 10);
  if (cap <= 0n || max <= 0n || max > cap || !Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error(`template ${template.id} has no usable defaults`);
  }
  if (template.fields.purpose.trim().length === 0) {
    throw new Error(`template ${template.id} has no purpose`);
  }
  return { cap, max, days, purpose: template.fields.purpose };
}

export type PartyDisplay = {
  savedName: string | null;
  shortAddress: string | null;
  claim: string | null;
  fullAddress: string | null;
};

export function partyDisplay(args: {
  address: string | null;
  claimedLabel?: string | null;
  savedName?: string | null;
}): PartyDisplay {
  const claim = claimLine(args.claimedLabel);
  const saved = args.savedName?.trim() ?? '';
  const canonical = args.address ? canonicalAddress(args.address) : null;
  if (!canonical) {
    return { savedName: null, shortAddress: null, claim, fullAddress: null };
  }
  return {
    savedName: saved.length > 0 ? saved : null,
    shortAddress: truncateAddress(canonical),
    claim,
    fullAddress: canonical,
  };
}

export function addressLine(
  party: PartyDisplay,
  revealed: boolean,
): { primary: string; beside: string | null; full: string | null } {
  return {
    primary: party.savedName ?? party.shortAddress ?? '',
    beside: party.claim,
    full: revealed ? party.fullAddress : null,
  };
}

export function agentFieldReady(text: string, owner: string | null, payee: string | null): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const agent = canonicalAddress(trimmed);
  if (!agent) {
    return false;
  }
  if (owner && agent === (canonicalAddress(owner) ?? owner)) {
    return false;
  }
  const payeeKey = payee ? canonicalAddress(payee) : null;
  if (payeeKey && agent === payeeKey) {
    return false;
  }
  return true;
}

export function payeeFieldReady(text: string): boolean {
  const key = canonicalAddress(text.trim());
  if (!key) {
    return false;
  }
  return key !== PublicKey.default.toBase58();
}

export function purposeFieldReady(purpose: string): boolean {
  const length = Array.from(purpose).length;
  return length > 0 && length <= PURPOSE_MAX_LEN;
}

export function canApprove(args: {
  checks: readonly { ok: boolean }[];
  payeeReady: boolean;
  agentReady: boolean;
  purposeReady: boolean;
  expiryReady: boolean;
}): boolean {
  return (
    args.payeeReady &&
    args.agentReady &&
    args.purposeReady &&
    args.expiryReady &&
    args.checks.length > 0 &&
    args.checks.every((check) => check.ok)
  );
}

export function introductionHidesTabBar(args: {
  walletReady: boolean;
  onboardingReady: boolean;
  connected: boolean;
  seen: boolean;
}): boolean {
  if (!args.walletReady || !args.onboardingReady) {
    return false;
  }
  return showsIntroduction({ connected: args.connected, seen: args.seen });
}

function claimLine(label: string | null | undefined): string | null {
  const trimmed = label?.trim() ?? '';
  if (trimmed.length === 0) {
    return null;
  }
  return `calls itself ${trimmed}`;
}

/** Round non-negative decimal input to the nearest base unit, with ties rounded up. */
export function parseLimitAmount(text: string, decimals: number): bigint | null {
  const raw = text.trim().replace(',', '.');
  if (raw.length > 100 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const scale = 10n ** BigInt(decimals);
  const units = BigInt(whole || '0') * scale + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0') || '0');
  return units + ((fraction[decimals] ?? '0') >= '5' ? 1n : 0n);
}
