import { liveRulesLabel } from './grade';
import { isActive, type MandateAccount } from './mandate';

export type MandateReadStatus = 'not-read' | 'failed' | 'empty' | 'present' | 'rate-limited';

export type ReadFace = 'reading' | 'unavailable' | 'proven';

export const RATE_LIMIT_RETRY_MS = [500, 1000, 2000] as const;

export const CHAIN_BUSY = 'The blockchain is busy right now. Veto keeps trying.';

export const CHAIN_UNREACHABLE = 'Could not reach the blockchain. Pull down to try again.';

export const PILL_READING = 'Reading...';

export const PILL_UNREAD = 'Could not read';

export const RATE_LIMIT_GAVE_UP = CHAIN_UNREACHABLE;

export function mayClaimAbsence(status: MandateReadStatus): boolean {
  return status === 'empty' || status === 'present';
}

export function mandateReadStatus(args: {
  checkedOwner: string | null;
  ownerPublicKey: string | null;
  loading: boolean;
  error: string | null;
  hasMandate: boolean;
  rateLimited?: boolean;
}): MandateReadStatus {
  const forThisOwner =
    args.ownerPublicKey != null && args.checkedOwner === args.ownerPublicKey;
  if (args.hasMandate && forThisOwner) {
    return 'present';
  }
  if (args.rateLimited) {
    return 'rate-limited';
  }
  if (!forThisOwner || args.loading) {
    return 'not-read';
  }
  if (args.error) {
    return 'failed';
  }
  return 'empty';
}

export function readFace(status: MandateReadStatus): ReadFace {
  if (status === 'failed') {
    return 'unavailable';
  }
  if (status === 'present' || status === 'empty') {
    return 'proven';
  }
  return 'reading';
}

export function tabPillFace(status: MandateReadStatus, nowMs: number): ReadFace {
  const face = readFace(status);
  if (face === 'proven' && nowMs <= 0) {
    return 'reading';
  }
  return face;
}

export function showRulePill(status: MandateReadStatus, loading: boolean): boolean {
  return loading || status !== 'not-read';
}

export function liveMandateCount(mandates: readonly MandateAccount[], nowMs: number): number {
  if (nowMs <= 0) {
    return 0;
  }
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  return mandates.filter((row) => isActive(row, nowSec)).length;
}

export function rulePillLabel(face: ReadFace, liveCount: number): string {
  if (face === 'reading') {
    return PILL_READING;
  }
  if (face === 'unavailable') {
    return PILL_UNREAD;
  }
  return liveRulesLabel(liveCount);
}

export function mandateAbsenceCopy(status: MandateReadStatus, empty: string): string | null {
  if (status === 'present') {
    return null;
  }
  if (status === 'not-read') {
    return 'Reading the chain for this owner.';
  }
  if (status === 'rate-limited') {
    return CHAIN_BUSY;
  }
  if (status === 'failed') {
    return CHAIN_UNREACHABLE;
  }
  return empty;
}
