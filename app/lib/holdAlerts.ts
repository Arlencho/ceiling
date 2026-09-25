import { formatChainInstant } from './hold';

const HOUR = 3_600n;

export type HoldAlertName =
  | 'created'
  | '1h'
  | '12h'
  | 'every_12h'
  | '6h_before'
  | '1h_before'
  | 'end';

export type HoldAlert = {
  key: string;
  name: HoldAlertName;
  at: bigint;
  title: string;
  body: string;
  row: string;
};

/**
 * The times a held withdrawal is announced.
 * The vault client does not export this plan. The marks match the watcher:
 * at once, at 1 hour, at 12 hours, every 12 hours after that, at 6 hours
 * and 1 hour before the end, and when the wait ends.
 */
export function holdAlertPlan(args: {
  vault: string;
  withdrawalId: string;
  amountLabel: string;
  destinationLabel: string;
  createdAt: bigint;
  unlockAt: bigint;
  newAddress: boolean;
  timeZone?: string;
}): HoldAlert[] {
  const alerts: HoldAlert[] = [];
  const push = (name: HoldAlertName, at: bigint, title: string, body: string, row: string) => {
    alerts.push({
      key: `${args.vault}:${args.withdrawalId}:${name}:${at.toString()}`,
      name,
      at,
      title,
      body,
      row,
    });
  };
  const when = (at: bigint) => formatChainInstant(at, args.timeZone);
  const createdTitle = args.newAddress
    ? `Held: ${args.amountLabel} to a new address`
    : `Held: ${args.amountLabel} to ${args.destinationLabel}`;
  push(
    'created',
    args.createdAt,
    createdTitle,
    `Goes ${when(args.unlockAt)} unless you stop it. Tap to stop.`,
    'Held. What, where, when it goes.',
  );
  const hourAt = args.createdAt + HOUR;
  if (hourAt < args.unlockAt) {
    push(
      '1h',
      hourAt,
      'Reminder, 1 hour in',
      `${args.amountLabel} to ${args.destinationLabel} is still waiting.`,
      'Reminder, 1 hour in.',
    );
  }
  const twelveAt = args.createdAt + 12n * HOUR;
  if (twelveAt < args.unlockAt) {
    push(
      '12h',
      twelveAt,
      'Reminder, 12 hours in',
      `${args.amountLabel} to ${args.destinationLabel} is still waiting.`,
      'Reminder, 12 hours in.',
    );
  }
  for (let hours = 24n; args.createdAt + hours * HOUR < args.unlockAt; hours += 12n) {
    const at = args.createdAt + hours * HOUR;
    const left = args.unlockAt - at;
    const row = left === 86_400n ? 'Reminder, 1 day left.' : leftReminder(left);
    push('every_12h', at, row.replace(/\.$/, ''), `${args.amountLabel} to ${args.destinationLabel} is still waiting.`, row);
  }
  const sixAt = args.unlockAt - 6n * HOUR;
  if (args.unlockAt > args.createdAt + 6n * HOUR) {
    push(
      '6h_before',
      sixAt,
      'Last calls: 6 hours left',
      `${args.amountLabel} to ${args.destinationLabel} goes in 6 hours unless you stop it.`,
      'Last calls: 6 hours left.',
    );
  }
  const oneAt = args.unlockAt - HOUR;
  if (args.unlockAt > args.createdAt + HOUR) {
    push(
      '1h_before',
      oneAt,
      'Goes in 1 hour unless stopped',
      `${args.amountLabel} to ${args.destinationLabel} goes in 1 hour unless you stop it.`,
      'Goes in 1 hour unless stopped.',
    );
  }
  push(
    'end',
    args.unlockAt,
    'Paid or stopped',
    `The wait for ${args.amountLabel} to ${args.destinationLabel} ended. Check whether it was paid or stopped.`,
    'Paid or stopped. On the blockchain.',
  );
  return alerts;
}

function leftReminder(left: bigint): string {
  const hours = left / HOUR;
  if (hours % 24n === 0n) {
    const days = hours / 24n;
    return days === 1n ? 'Reminder, 1 day left.' : `Reminder, ${days.toString()} days left.`;
  }
  return hours === 1n ? 'Reminder, 1 hour left.' : `Reminder, ${hours.toString()} hours left.`;
}

export function nextAlertIndex(plan: readonly HoldAlert[], nowSec: bigint): number {
  return plan.findIndex((alert) => alert.at > nowSec);
}

export function dueHoldAlerts(plan: readonly HoldAlert[], nowSec: bigint, seen: ReadonlySet<string>): HoldAlert[] {
  return plan.filter((alert) => alert.at <= nowSec && !seen.has(alert.key));
}

export function futureHoldAlerts(plan: readonly HoldAlert[], nowSec: bigint): HoldAlert[] {
  return plan.filter((alert) => alert.at > nowSec);
}
