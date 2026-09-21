import { PURPOSE_MAX_LEN } from './constants';
import type { MandateFields } from './templates';

export type Ruleset = {
  id: string;
  name: string;
  version: number;
  cap: string;
  perTxMax: string;
  expiryDays: string;
  merchant: string;
  purpose: string;
};

export type PurposeStamp = {
  purpose: string;
  rulesetId: string | null;
  version: number | null;
};

export type AppliedRule = MandateFields & {
  rulesetId: string;
  rulesetVersion: number;
};

const STAMP_RE = /^(.*) \[([a-z0-9]+(?:-[a-z0-9]+)*) v(\d+)\]$/;

export function rulesetSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'ruleset';
}

export function stampPurpose(purpose: string, id: string, version: number): string {
  const stamp = ` [${id} v${version}]`;
  if (stamp.length > PURPOSE_MAX_LEN) {
    throw new Error('ruleset identity and version cannot fit in the on-chain purpose');
  }
  const room = PURPOSE_MAX_LEN - stamp.length;
  const body = purpose.trim().slice(0, room).trimEnd();
  return `${body}${stamp}`;
}

export function parsePurposeStamp(purpose: string): PurposeStamp {
  const match = STAMP_RE.exec(purpose);
  if (!match) {
    return { purpose, rulesetId: null, version: null };
  }
  return {
    purpose: match[1] ?? purpose,
    rulesetId: match[2] ?? null,
    version: match[3] ? Number.parseInt(match[3], 10) : null,
  };
}

export function applyRuleset(ruleset: Ruleset): AppliedRule {
  return {
    cap: ruleset.cap,
    perTxMax: ruleset.perTxMax,
    expiryDays: ruleset.expiryDays,
    merchant: ruleset.merchant,
    purpose: stampPurpose(ruleset.purpose, ruleset.id, ruleset.version),
    rulesetId: ruleset.id,
    rulesetVersion: ruleset.version,
  };
}

export function nextRulesetVersion(existing: readonly Ruleset[], id: string): number {
  let max = 0;
  for (const row of existing) {
    if (row.id === id && row.version > max) {
      max = row.version;
    }
  }
  return max + 1;
}

export function addRuleset(existing: readonly Ruleset[], draft: Ruleset): Ruleset[] {
  if (existing.some((row) => row.id === draft.id && row.version === draft.version)) {
    throw new Error('a ruleset version cannot be overwritten');
  }
  return [...existing, { ...draft }];
}
