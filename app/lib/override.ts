import {
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  REASON_OVER_CAP,
  REASON_OVER_PER_TX_MAX,
  STATUS_ACTIVE,
  STATUS_EXHAUSTED,
  STATUS_REVOKED,
  reasonText,
  statusName,
} from './constants';
import { formatBaseUnits } from './format';
import { isActive, mandateRemaining, type MandateAccount } from './mandate';

export const CAP_OVERRIDE_REFUSAL =
  'An override cannot raise the cap because the program will not accept one.';

export type OverrideSource = {
  kind: number;
  reason: number;
  nonce: bigint;
  amount: bigint;
  suggestedOverride: bigint;
};

export type OverrideOffer =
  | { offer: true; amount: bigint }
  | { offer: false; why: string };

export type OverrideGuard = { ok: true } | { ok: false; why: string };

export type OverrideCommit = {
  title: string;
  amount: string;
  nonce: string;
  paragraphs: string[];
};

export type OverrideAssessment =
  | { status: 'none'; why: string }
  | { status: 'already'; amount: bigint; nonce: bigint; why: string }
  | { status: 'blocked'; why: string }
  | { status: 'ready'; amount: bigint; nonce: bigint; commit: OverrideCommit };

export type OverrideRowView = {
  say: string;
  italic: string;
  why: string;
  amount: string;
};

export type NonceSequence = {
  nonce: bigint;
  asked: bigint | null;
  refused: boolean;
  waived: boolean;
  paid: boolean;
  reason: number | null;
};

export function overrideOfferForReason(reason: number, suggestedOverride: bigint): OverrideOffer {
  if (reason === REASON_OVER_CAP) {
    return { offer: false, why: CAP_OVERRIDE_REFUSAL };
  }
  if (reason === REASON_OVER_PER_TX_MAX && suggestedOverride <= 0n) {
    return { offer: false, why: CAP_OVERRIDE_REFUSAL };
  }
  if (reason === REASON_OVER_PER_TX_MAX && suggestedOverride > 0n) {
    return { offer: true, amount: suggestedOverride };
  }
  return {
    offer: false,
    why: `The program records no override for this reason (${reasonText(reason)}).`,
  };
}

export function overrideGuard(
  mandate: MandateAccount,
  nonce: bigint,
  amount: bigint,
  nowSec?: bigint,
): OverrideGuard {
  if (nonce === 0n) {
    return { ok: false, why: 'This row has no nonce. The program will not accept an override.' };
  }
  if (amount === 0n) {
    return {
      ok: false,
      why: 'This row has no override amount. The program will not accept an override.',
    };
  }
  if (mandate.status === STATUS_REVOKED) {
    return {
      ok: false,
      why: 'This rule is revoked on chain. An override cannot be granted.',
    };
  }
  if (mandate.status === STATUS_EXHAUSTED) {
    return {
      ok: false,
      why: `This rule is exhausted on chain. ${CAP_OVERRIDE_REFUSAL}`,
    };
  }
  if (mandate.status !== STATUS_ACTIVE) {
    return {
      ok: false,
      why: `This rule is ${statusName(mandate.status)} on chain. An override cannot be granted.`,
    };
  }
  if (nowSec !== undefined && !isActive(mandate, nowSec)) {
    return {
      ok: false,
      why: 'This rule is expired on chain. An override cannot be granted.',
    };
  }
  if (nonce <= mandate.lastNonce) {
    return {
      ok: false,
      why: 'This nonce is already settled on chain. An override cannot be granted.',
    };
  }
  const remaining = mandateRemaining(mandate);
  if (amount > remaining) {
    return {
      ok: false,
      why: `The remaining cap is now below this amount. ${CAP_OVERRIDE_REFUSAL}`,
    };
  }
  return { ok: true };
}

export function overrideCommitCopy(args: {
  amount: bigint;
  nonce: bigint;
  perTxMax: bigint;
  remaining: bigint;
  cap: bigint;
  decimals: number;
  pendingOtherNonce?: bigint;
}): OverrideCommit {
  const amount = formatBaseUnits(args.amount, args.decimals);
  const perTxMax = formatBaseUnits(args.perTxMax, args.decimals);
  const remaining = formatBaseUnits(args.remaining, args.decimals);
  const cap = formatBaseUnits(args.cap, args.decimals);
  const paragraphs = [
    `You are about to grant an override of ${amount} for nonce ${args.nonce.toString()}.`,
    `The per-payment maximum on this rule is ${perTxMax}. It does not change. This override allows this one payment of ${amount}, used once, never above the remaining cap (${remaining} remaining of ${cap}). ${CAP_OVERRIDE_REFUSAL}`,
    'This is written to the ledger as an override, a recorded decision. It is not a settings change.',
    'The owner signs once. The agent can then retry this nonce.',
  ];
  if (args.pendingOtherNonce != null && args.pendingOtherNonce !== 0n) {
    paragraphs.splice(
      2,
      0,
      `This replaces the pending override for nonce ${args.pendingOtherNonce.toString()}.`,
    );
  }
  return {
    title: 'Grant this override',
    amount,
    nonce: args.nonce.toString(),
    paragraphs,
  };
}

export function assessOverride(args: {
  row: OverrideSource;
  mandate: MandateAccount;
  decimals: number;
  nowSec?: bigint;
}): OverrideAssessment {
  if (args.row.kind !== KIND_REFUSED) {
    return {
      status: 'none',
      why: 'An override is granted from a refused decision, not from this row.',
    };
  }
  const offer = overrideOfferForReason(args.row.reason, args.row.suggestedOverride);
  if (!offer.offer) {
    return { status: 'none', why: offer.why };
  }
  const guard = overrideGuard(args.mandate, args.row.nonce, offer.amount, args.nowSec);
  if (!guard.ok) {
    return { status: 'blocked', why: guard.why };
  }
  if (args.mandate.overrideNonce === args.row.nonce && args.mandate.overrideAmount > 0n) {
    const amount = formatBaseUnits(args.mandate.overrideAmount, args.decimals);
    return {
      status: 'already',
      amount: args.mandate.overrideAmount,
      nonce: args.row.nonce,
      why: `This nonce already has an override of ${amount} on chain. The agent can retry it.`,
    };
  }
  const pending =
    args.mandate.overrideNonce !== 0n && args.mandate.overrideNonce !== args.row.nonce
      ? args.mandate.overrideNonce
      : undefined;
  return {
    status: 'ready',
    amount: offer.amount,
    nonce: args.row.nonce,
    commit: overrideCommitCopy({
      amount: offer.amount,
      nonce: args.row.nonce,
      perTxMax: args.mandate.perTxMax,
      remaining: mandateRemaining(args.mandate),
      cap: args.mandate.cap,
      decimals: args.decimals,
      pendingOtherNonce: pending,
    }),
  };
}

export type OverrideProbeRow = {
  ts: bigint;
  kind: number;
  nonce: bigint;
  reason: number;
  suggestedOverride: bigint;
};

export function overrideRowProbeKey(row: OverrideProbeRow): string {
  return `${row.ts.toString()}:${row.kind}:${row.nonce.toString()}:${row.reason}:${row.suggestedOverride.toString()}`;
}

export function overrideMandateProbeKey(mandate: MandateAccount, nowSec?: bigint): string {
  const clock = nowSec === undefined ? '' : isActive(mandate, nowSec) ? 'live' : 'expired';
  return `${mandate.address}:${mandate.status}:${mandate.lastNonce.toString()}:${mandate.overrideNonce.toString()}:${mandate.spent.toString()}:${clock}`;
}

export function overrideProbeKey(
  row: OverrideProbeRow,
  mandate: MandateAccount,
  nowSec?: bigint,
): string {
  return `${overrideRowProbeKey(row)}|${overrideMandateProbeKey(mandate, nowSec)}`;
}

export function overrideProbeIsCurrent(
  currentKey: string | null | undefined,
  nextKey: string,
): boolean {
  return currentKey === nextKey;
}

export function overrideRowView(row: OverrideSource, decimals: number): OverrideRowView {
  const amount = formatBaseUnits(row.amount, decimals);
  return {
    say: 'Waived',
    italic: 'by the owner',
    why: `An override of ${amount} for nonce ${row.nonce.toString()}. This is a recorded decision, not a settings change. It allows this one payment, used once, never above the remaining cap. The per-payment maximum does not change. The total cap is unchanged.`,
    amount,
  };
}

export function nonceSequence<T extends OverrideSource>(
  rows: readonly T[],
  nonce: bigint,
): NonceSequence {
  let asked: bigint | null = null;
  let refused = false;
  let waived = false;
  let paid = false;
  let reason: number | null = null;
  for (const row of rows) {
    if (row.nonce !== nonce) {
      continue;
    }
    if (row.kind === KIND_REFUSED) {
      refused = true;
      asked = row.amount;
      reason = row.reason;
    } else if (row.kind === KIND_OVERRIDE) {
      waived = true;
      if (asked == null) {
        asked = row.amount;
      }
    } else if (row.kind === KIND_PAID) {
      paid = true;
      if (asked == null) {
        asked = row.amount;
      }
    }
  }
  return { nonce, asked, refused, waived, paid, reason };
}

export function sequenceLine(seq: NonceSequence, decimals: number): string | null {
  const steps = Number(seq.refused) + Number(seq.waived) + Number(seq.paid);
  if (steps < 2) {
    return null;
  }
  const parts: string[] = [];
  if (seq.asked != null) {
    parts.push(`Asked for ${formatBaseUnits(seq.asked, decimals)}.`);
  }
  if (seq.refused) {
    const why = seq.reason != null ? ` (${reasonText(seq.reason)})` : '';
    parts.push(`Refused${why}.`);
  }
  if (seq.waived) {
    parts.push('Waived by the owner.');
  }
  if (seq.paid) {
    parts.push('Then paid.');
  } else if (seq.waived) {
    parts.push('The agent can retry this nonce.');
  }
  return parts.join(' ');
}
