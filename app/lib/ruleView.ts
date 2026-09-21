import { STATUS_ACTIVE, STATUS_EXHAUSTED, STATUS_EXPIRED, STATUS_REVOKED, statusName } from './constants';
import { formatBaseUnits } from './format';
import type { MandateAccount } from './mandate';
import { parsePurposeStamp } from './ruleset';
import { truncateAddress } from './wallet';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatExpiryDate(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    return unixSeconds.toString();
  }
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function displayPurpose(purpose: string): string {
  const parsed = parsePurposeStamp(purpose);
  const text = parsed.purpose.trim();
  return text.length > 0 ? text : purpose;
}

export function stampedRulesetLine(purpose: string): string | null {
  const parsed = parsePurposeStamp(purpose);
  if (!parsed.rulesetId || parsed.version == null) {
    return null;
  }
  return `${parsed.rulesetId} v${parsed.version}`;
}

export function ruleSentence(mandate: MandateAccount, decimals: number): string {
  const purpose = displayPurpose(mandate.purpose);
  const merchant = truncateAddress(mandate.merchant);
  const per = formatBaseUnits(mandate.perTxMax, decimals);
  const cap = formatBaseUnits(mandate.cap, decimals);
  const until = formatExpiryDate(mandate.expiresAt);
  return `Pay ${merchant} up to ${per} at a time and ${cap} in total, until ${until}, for ${purpose}.`;
}

export function ruleStatusLabel(mandate: MandateAccount, nowSec: bigint, current: boolean): string {
  if (current && mandate.status === STATUS_ACTIVE && nowSec < mandate.expiresAt) {
    return 'current';
  }
  if (mandate.status === STATUS_REVOKED) {
    return 'revoked';
  }
  if (mandate.status === STATUS_EXHAUSTED) {
    return 'exhausted';
  }
  if (mandate.status === STATUS_EXPIRED || nowSec >= mandate.expiresAt) {
    return 'expired';
  }
  return statusName(mandate.status);
}

export function spendRatio(spent: bigint, cap: bigint): number {
  if (cap <= 0n) {
    return 0;
  }
  const raw = Number(spent) / Number(cap);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  if (raw >= 1) {
    return 1;
  }
  return raw;
}
