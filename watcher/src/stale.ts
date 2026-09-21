import { STALE_AFTER_MS } from "./cadence.js";
import type { JournalRow } from "./journal.js";

export function lastDecisionAt(rows: JournalRow[]): Date | null {
  let max: Date | null = null;
  for (const row of rows) {
    const ms = Date.parse(row.ts);
    if (Number.isNaN(ms)) continue;
    if (max === null || ms > max.getTime()) max = new Date(ms);
  }
  return max;
}

export function isJournalStale(args: {
  rows: JournalRow[];
  now: Date;
  emptySince: Date | null;
}): boolean {
  const last = lastDecisionAt(args.rows);
  const origin = last ?? args.emptySince;
  if (origin === null) return true;
  return args.now.getTime() - origin.getTime() > STALE_AFTER_MS;
}
