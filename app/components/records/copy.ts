import { KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import { KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX } from '../../lib/constants';
import { formatBaseUnits, formatClock, formatDayHeading, formatUnix } from '../../lib/format';
import { overrideRowView } from '../../lib/override';
import { refusalWhyLine } from '../../lib/reasons';
import type { LedgerRow } from '../../lib/ring';
import { truncateAddress } from '../../lib/wallet';

export type RowTone = 'paid' | 'refused' | 'allowed' | 'advisory';

export type DecisionFace = {
  tone: RowTone;
  badge: string | null;
  title: string;
  detail: string;
  figure: string;
  when: string;
};

const DAY_MS = 86_400_000;

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function relativeDay(ts: bigint, nowMs: number | undefined): string {
  if (nowMs == null) {
    return formatDayHeading(ts);
  }
  const then = new Date(Number(ts) * 1000);
  const now = new Date(nowMs);
  if (Number.isNaN(then.getTime()) || Number.isNaN(now.getTime())) {
    return formatDayHeading(ts);
  }
  const days = Math.round((dayStart(now) - dayStart(then)) / DAY_MS);
  if (days === 0) {
    return 'Today';
  }
  if (days === 1) {
    return 'Yesterday';
  }
  return formatDayHeading(ts);
}

export function decisionWhen(ts: bigint, nowMs: number | undefined): string {
  const day = relativeDay(ts, nowMs);
  const clock = formatClock(ts);
  if (day === 'Today') {
    return `Today at ${clock}`;
  }
  if (day === 'Yesterday') {
    return `Yesterday ${clock}`;
  }
  return formatUnix(ts);
}

export function rowWhen(ts: bigint, nowMs: number | undefined): string {
  const day = relativeDay(ts, nowMs);
  const clock = formatClock(ts);
  if (day === 'Today') {
    return clock;
  }
  if (day === 'Yesterday') {
    return `Yesterday ${clock}`;
  }
  return day;
}

export function clusterPillLabel(cluster: string | null | undefined): string {
  const raw = cluster?.trim() || 'devnet';
  if (raw === 'mainnet-beta') {
    return 'Mainnet';
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function refusedTitle(args: {
  amount: bigint;
  decimals: number;
  perTxMax?: bigint;
  reason: number;
  suggestedOverride: bigint;
}): string {
  if (args.reason === REASON_OVER_PER_TX_MAX && args.perTxMax != null) {
    const asked = formatBaseUnits(args.amount, args.decimals);
    const limit = formatBaseUnits(args.perTxMax, args.decimals);
    return `Refused: your agent asked ${asked}, your limit is ${limit} per payment`;
  }
  const why = refusalWhyLine({
    reason: args.reason,
    amount: args.amount,
    suggestedOverride: args.suggestedOverride,
    decimals: args.decimals,
    perTxMax: args.perTxMax,
  }).replace(/\.$/, '');
  return `Refused: ${why}`;
}

const MISSING_SIGNATURE =
  'This RPC did not return a transaction signature for this row. The row itself is from the on-chain ledger, not invented.';

export function decisionFace(
  row: LedgerRow,
  decimals: number,
  perTxMax: bigint | undefined,
  nowMs: number | undefined,
): DecisionFace {
  const when = rowWhen(row.ts, nowMs);
  if (row.kind === KIND_ADVISORY_DECLINE) {
    const amount = formatBaseUnits(row.amount, decimals);
    const reason = row.reasonText.trim();
    return {
      tone: 'advisory',
      badge: "Your agent's own note",
      title: reason.length > 0 ? `Your agent declined on its own: ${reason}` : 'Your agent declined on its own',
      detail: 'Not a refusal by the rule. Your agent signed this note itself.',
      figure: amount,
      when,
    };
  }
  if (row.kind === KIND_REFUSED) {
    return {
      tone: 'refused',
      badge: null,
      title: refusedTitle({
        amount: row.amount,
        decimals,
        perTxMax,
        reason: row.reason,
        suggestedOverride: row.suggestedOverride,
      }),
      detail: row.signature
        ? 'No money moved. Reason saved on the blockchain.'
        : `No money moved. ${MISSING_SIGNATURE}`,
      figure: formatBaseUnits(0n, decimals),
      when,
    };
  }
  if (row.kind === KIND_OVERRIDE) {
    const view = overrideRowView(row, decimals);
    return {
      tone: 'allowed',
      badge: null,
      title: `Allowed once: this payment of ${view.amount}`,
      detail: row.signature ? view.why : `${view.why} ${MISSING_SIGNATURE}`,
      figure: view.amount,
      when,
    };
  }
  if (row.kind === KIND_PAID) {
    const amount = formatBaseUnits(row.amount, decimals);
    const payee = truncateAddress(row.counterparty);
    const limit = perTxMax != null ? formatBaseUnits(perTxMax, decimals) : null;
    const inside = limit != null ? `Inside your limit of ${limit} per payment.` : 'Inside the rule.';
    return {
      tone: 'paid',
      badge: null,
      title: `Paid ${amount} to ${payee}`,
      detail: row.signature ? inside : `${inside} ${MISSING_SIGNATURE}`,
      figure: `-${amount}`,
      when,
    };
  }
  return {
    tone: 'paid',
    badge: null,
    title: 'Decision',
    detail: '',
    figure: '',
    when,
  };
}

export function refusalBody(args: {
  amount: bigint;
  decimals: number;
  perTxMax?: bigint;
  reason: number;
  suggestedOverride: bigint;
}): string {
  if (args.reason === REASON_OVER_PER_TX_MAX && args.perTxMax != null) {
    const asked = formatBaseUnits(args.amount, args.decimals);
    const limit = formatBaseUnits(args.perTxMax, args.decimals);
    return `Your agent asked to pay ${asked}. Your rule allows ${limit} per payment, so the program refused.`;
  }
  return refusalWhyLine({
    reason: args.reason,
    amount: args.amount,
    suggestedOverride: args.suggestedOverride,
    decimals: args.decimals,
    perTxMax: args.perTxMax,
  });
}

export function whyRefused(args: {
  reason: number;
  decimals: number;
  perTxMax?: bigint;
  fallback: string;
}): string {
  if (args.reason === REASON_OVER_PER_TX_MAX && args.perTxMax != null) {
    return `Over your per-payment limit of ${formatBaseUnits(args.perTxMax, args.decimals)}`;
  }
  return args.fallback.replace(/\.$/, '');
}

export function barSplit(asked: bigint, limit: bigint): { allowedPct: number; overPct: number } | null {
  if (asked <= 0n || limit < 0n) {
    return null;
  }
  if (asked <= limit) {
    if (limit === 0n) {
      return { allowedPct: 0, overPct: 0 };
    }
    const allowedPct = Number((asked * 1000n) / limit) / 10;
    return { allowedPct, overPct: 0 };
  }
  const allowedPct = Number((limit * 1000n) / asked) / 10;
  const overPct = Math.max(0, Math.round((100 - allowedPct) * 10) / 10);
  return { allowedPct, overPct };
}

export function networkFoot(): string {
  const cluster = process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER?.trim() || 'devnet';
  if (cluster === 'mainnet-beta') {
    return 'You sign in Seed Vault. Veto never sees your key.';
  }
  return `You sign in Seed Vault. Veto never sees your key. This is Solana ${cluster} with test tokens, not real money.`;
}
