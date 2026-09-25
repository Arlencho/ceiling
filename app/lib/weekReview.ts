import { REASON_OVER_PER_TX_MAX } from './constants';
import { formatTokenAmount } from './tokens';
import {
  addLocalDays,
  localDate,
  localDayDelta,
  localDayKey,
  narrowWeekday,
  ruleTotalDays,
  weekReasonTitle,
  type GradeDecision,
  type LocalDate,
  type RuleSnapshot,
} from './grade';

export type WeekDay = {
  key: string;
  narrow: string;
  paid: number;
  refused: number;
  label: string;
};

export type WeekReason = {
  reason: number;
  ruleAddress: string;
  title: string;
  count: number;
  detail: string;
};

export type WeekReview = {
  agentName: string;
  ruleAddress: string;
  purpose: string;
  weekIndex: number | null;
  weekCount: number | null;
  kicker: string;
  heading: string;
  days: WeekDay[];
  paidCount: number;
  paidAmount: bigint;
  paidAmountLabel: string;
  refusedCount: number;
  allowances: number;
  reasons: WeekReason[];
  remainingLabel: string;
  capLabel: string;
  dayLabel: string;
};

function sameAmounts(rows: readonly GradeDecision[]): boolean {
  if (rows.length === 0) {
    return true;
  }
  const first = rows[0]?.amount;
  return rows.every((row) => row.amount === first);
}

function amountSpan(
  rows: readonly GradeDecision[],
  decimals: number,
  mint: string | null | undefined,
): { min: string; max: string; minRaw: bigint; maxRaw: bigint } | null {
  if (rows.length === 0) {
    return null;
  }
  let min = rows[0]!.amount;
  let max = rows[0]!.amount;
  for (const row of rows) {
    if (row.amount < min) {
      min = row.amount;
    }
    if (row.amount > max) {
      max = row.amount;
    }
  }
  return {
    min: formatTokenAmount(min, decimals, mint),
    max: formatTokenAmount(max, decimals, mint),
    minRaw: min,
    maxRaw: max,
  };
}

export function weekReasonDetail(
  rows: readonly GradeDecision[],
  decimals: number,
  perTxMaxLabel: string,
  reason: number,
  mint?: string | null,
): string {
  const count = rows.length;
  const span = amountSpan(rows, decimals, mint);
  const times = count === 1 ? '1 time' : `${count} times`;
  if (reason === REASON_OVER_PER_TX_MAX && span) {
    if (span.minRaw === span.maxRaw) {
      return count === 1
        ? `Asked ${span.min}. Limit stayed ${perTxMaxLabel}.`
        : `Asked ${span.min}, ${times}. Limit stayed ${perTxMaxLabel}.`;
    }
    return `${times}, asked between ${span.min} and ${span.max}. Limit stayed ${perTxMaxLabel}.`;
  }
  if (!span || sameAmounts(rows)) {
    return span && span.minRaw !== 0n ? `${times}, asked ${span.min}.` : times;
  }
  return `${times}, asked between ${span.min} and ${span.max}.`;
}

function dayLabel(paid: number, refused: number): string {
  if (paid === 0 && refused === 0) {
    return 'quiet';
  }
  const parts: string[] = [];
  if (paid > 0) {
    parts.push(paid === 1 ? '1 paid' : `${paid} paid`);
  }
  if (refused > 0) {
    parts.push(refused === 1 ? '1 ref.' : `${refused} ref.`);
  }
  return parts.join('\n');
}

function headingFor(start: LocalDate, end: LocalDate): string {
  const leftDay = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][start.weekday]} ${start.day}`;
  const rightDay = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][end.weekday]} ${end.day}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (start.year !== end.year) {
    return `${leftDay} ${months[start.month]} ${start.year} to ${rightDay} ${months[end.month]} ${end.year}`;
  }
  if (start.month !== end.month) {
    return `${leftDay} ${months[start.month]} to ${rightDay} ${months[end.month]}`;
  }
  return `${leftDay} to ${rightDay} ${months[end.month]}`;
}

function weekWindow(rule: RuleSnapshot, nowSec: bigint, weekIndex: number | null): {
  index: number | null;
  count: number | null;
  days: LocalDate[];
} {
  const start = rule.startedAt == null ? null : localDate(rule.startedAt);
  const now = localDate(nowSec);
  if (!start || !now) {
    const today = now ?? localDate(nowSec);
    if (!today) {
      return { index: null, count: null, days: [] };
    }
    return {
      index: null,
      count: null,
      days: Array.from({ length: 7 }, (_, i) => addLocalDays(today, i - 6)),
    };
  }
  const total = ruleTotalDays(rule.startedAt, rule.expiresAt);
  const count = total == null ? null : Math.max(1, Math.ceil(total / 7));
  const delta = localDayDelta(start, now);
  const current = delta < 0 ? 1 : Math.floor(delta / 7) + 1;
  const index = weekIndex != null && weekIndex > 0 ? weekIndex : current;
  const offset = (index - 1) * 7;
  return {
    index,
    count,
    days: Array.from({ length: 7 }, (_, i) => addLocalDays(start, offset + i)),
  };
}

export function weekReviewFor(
  rule: RuleSnapshot,
  agentName: string,
  nowSec: bigint,
  weekIndex: number | null = null,
): WeekReview {
  const window = weekWindow(rule, nowSec, weekIndex);
  const keys = new Set(window.days.map((day) => localDayKey(day)));
  const inWeek = (row: GradeDecision) => {
    const date = localDate(row.ts);
    return date != null && keys.has(localDayKey(date));
  };
  const paidRows = rule.classified.paidInside.filter(inWeek);
  const refusedRows = rule.classified.refused.filter(inWeek);
  const allowanceRows = rule.classified.allowances.filter(inWeek);
  const days: WeekDay[] = window.days.map((day) => {
    const key = localDayKey(day);
    const paid = paidRows.filter((row) => {
      const date = localDate(row.ts);
      return date != null && localDayKey(date) === key;
    }).length;
    const refused = refusedRows.filter((row) => {
      const date = localDate(row.ts);
      return date != null && localDayKey(date) === key;
    }).length;
    return { key, narrow: narrowWeekday(day), paid, refused, label: dayLabel(paid, refused) };
  });
  const paidAmount = paidRows.reduce((sum, row) => sum + row.amount, 0n);
  const byReason = new Map<number, GradeDecision[]>();
  for (const row of refusedRows) {
    const list = byReason.get(row.reason);
    if (list) {
      list.push(row);
    } else {
      byReason.set(row.reason, [row]);
    }
  }
  const reasons: WeekReason[] = [...byReason.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
    .map(([reason, rows]) => ({
      reason,
      ruleAddress: rule.address,
      title: weekReasonTitle(reason, rule.perTxMaxLabel),
      count: rows.length,
      detail: weekReasonDetail(rows, rule.decimals, rule.perTxMaxLabel, reason, rule.mint),
    }));
  const heading =
    window.days.length === 7
      ? headingFor(window.days[0]!, window.days[6]!)
      : 'These seven days';
  const kicker =
    window.index != null && window.count != null
      ? `${agentName}, week ${window.index} of ${window.count}`
      : `${agentName}, these seven days`;
  return {
    agentName,
    ruleAddress: rule.address,
    purpose: rule.purpose,
    weekIndex: window.index,
    weekCount: window.count,
    kicker,
    heading,
    days,
    paidCount: paidRows.length,
    paidAmount,
    paidAmountLabel: formatTokenAmount(paidAmount, rule.decimals, rule.mint),
    refusedCount: refusedRows.length,
    allowances: allowanceRows.length,
    reasons,
    remainingLabel: rule.remainingLabel,
    capLabel: rule.capLabel,
    dayLabel: rule.dayLabel,
  };
}

export function weekFileText(review: WeekReview): string {
  const lines = [
    'Week in review',
    review.agentName,
    review.heading,
    review.kicker,
    '',
  ];
  for (const day of review.days) {
    lines.push(`${day.narrow} ${day.key}: ${day.paid} paid, ${day.refused} refused`);
  }
  lines.push(
    '',
    `Paid: ${review.paidCount} payments, ${review.paidAmountLabel} in total, all within the rule`,
    review.allowances === 0
      ? `Refused: ${review.refusedCount} payments, 0 moved, none allowed after`
      : `Refused: ${review.refusedCount} payments, 0 moved, ${review.allowances} allowed after`,
    '',
    'Why it was refused',
  );
  if (review.reasons.length === 0) {
    lines.push('Nothing was refused.');
  } else {
    for (const reason of review.reasons) {
      lines.push(`${reason.title}: ${reason.count}. ${reason.detail}`);
    }
  }
  lines.push(
    '',
    `Your agent can still spend ${review.remainingLabel} of ${review.capLabel}, ${review.dayLabel}`,
    '',
    'Every line is read from the blockchain.',
    `Rule ${review.ruleAddress}`,
  );
  return lines.join('\n');
}

export function weekAria(review: WeekReview): string {
  const days = review.days
    .map((day) => {
      if (day.paid === 0 && day.refused === 0) {
        return `${day.narrow}: quiet`;
      }
      return `${day.narrow}: ${day.paid} paid, ${day.refused} refused`;
    })
    .join('. ');
  return `Seven days. ${days}.`;
}
