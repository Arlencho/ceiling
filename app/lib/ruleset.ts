import { PURPOSE_MAX_LEN } from './constants';
import { parseBaseUnits } from './format';
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

export function purposeHasStampSuffix(purpose: string): boolean {
  return STAMP_RE.test(purpose.trim());
}

export function assertPurposeMayOpen(purpose: string, applying: boolean): void {
  if (!applying && purposeHasStampSuffix(purpose)) {
    throw new Error(
      'Do not type a ruleset stamp into purpose. Apply a saved ruleset to stamp identity and version. The ruleset file itself is not on chain.',
    );
  }
}

export type StampAlignment = 'match' | 'limits-differ' | 'missing';

export function stampAlignment(args: {
  purpose: string;
  cap: bigint;
  perTxMax: bigint;
  merchant: string;
  decimals: number;
  rulesets: readonly Ruleset[];
}): { id: string; version: number; alignment: StampAlignment } | null {
  const parsed = parsePurposeStamp(args.purpose);
  if (!parsed.rulesetId || parsed.version == null) {
    return null;
  }
  const found = args.rulesets.find(
    (row) => row.id === parsed.rulesetId && row.version === parsed.version,
  );
  if (!found) {
    return { id: parsed.rulesetId, version: parsed.version, alignment: 'missing' };
  }
  let cap: bigint;
  let perTxMax: bigint;
  try {
    cap = parseBaseUnits(found.cap, args.decimals);
    perTxMax = parseBaseUnits(found.perTxMax, args.decimals);
  } catch {
    return { id: parsed.rulesetId, version: parsed.version, alignment: 'limits-differ' };
  }
  const same =
    cap === args.cap && perTxMax === args.perTxMax && found.merchant === args.merchant;
  return {
    id: parsed.rulesetId,
    version: parsed.version,
    alignment: same ? 'match' : 'limits-differ',
  };
}

export function stampAlignmentLine(alignment: StampAlignment, version: number): string {
  if (alignment === 'match') {
    return `matches ruleset v${version} on this phone`;
  }
  if (alignment === 'limits-differ') {
    return `limits differ from ruleset v${version} on this phone`;
  }
  return 'no ruleset with this stamp on this phone';
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
