import { KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import { KIND_OPENED, KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, KIND_REVOKED } from '../../lib/constants';

const BREAKS_STREAK = new Set<number>([KIND_PAID, KIND_OVERRIDE, KIND_ADVISORY_DECLINE]);
const SKIP_STREAK = new Set<number>([KIND_OPENED, KIND_REVOKED]);

export function networkLabel(cluster: string): string {
  if (cluster === 'devnet') {
    return 'Devnet';
  }
  if (cluster === 'testnet') {
    return 'Testnet';
  }
  if (cluster === 'mainnet-beta') {
    return 'Mainnet';
  }
  return cluster;
}

/** Consecutive refusals at the newest end of the ledger. Payments and waivers break the run. */
export function refusalStreak(rows: readonly { kind: number }[]): number {
  let streak = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const kind = rows[index]!.kind;
    if (SKIP_STREAK.has(kind)) {
      continue;
    }
    if (kind !== KIND_REFUSED || BREAKS_STREAK.has(kind)) {
      break;
    }
    streak += 1;
  }
  return streak;
}

export function openedAtSec(rows: readonly { kind: number; ts: bigint }[]): bigint | null {
  let found: bigint | null = null;
  for (const row of rows) {
    if (row.kind !== KIND_OPENED) {
      continue;
    }
    if (found == null || row.ts < found) {
      found = row.ts;
    }
  }
  return found;
}

export function ruleDay(
  openedAt: bigint | null,
  expiresAt: bigint,
  nowSec: bigint,
): { day: number; total: number } | null {
  if (openedAt == null || expiresAt <= openedAt) {
    return null;
  }
  const span = expiresAt - openedAt;
  const total = Number((span + 86399n) / 86400n);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  const elapsed = nowSec <= openedAt ? 0n : nowSec - openedAt;
  let day = Number(elapsed / 86400n) + 1;
  if (day < 1) {
    day = 1;
  }
  if (day > total) {
    day = total;
  }
  return { day, total };
}

/** Integer pair for BlockBar. The ratio matches remaining/cap. The caller speaks the real amounts. */
export function barUnits(remaining: bigint, cap: bigint): { remaining: number; cap: number } {
  const scale = 1000;
  if (cap <= 0n) {
    return { remaining: 0, cap: scale };
  }
  if (remaining >= cap) {
    return { remaining: scale, cap: scale };
  }
  if (remaining <= 0n) {
    return { remaining: 0, cap: scale };
  }
  return { remaining: Number((remaining * BigInt(scale)) / cap), cap: scale };
}

export function wholePayments(cap: bigint, perPayment: bigint): bigint | null {
  if (perPayment <= 0n || cap < 0n) {
    return null;
  }
  return cap / perPayment;
}
