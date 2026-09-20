import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Decision = "paid" | "refused" | "gap" | "skipped";

export type JournalRow = {
  ts: string;
  window_start: string;
  window_end: string | null;
  sek_per_kwh: string | null;
  kwh_milli: string;
  amount: string;
  nonce: string;
  decision: Decision;
  reason: string;
  reason_code: number | null;
  signature: string | null;
  suggested_override: string | null;
};

// Only a decision the chain actually made settles a window. A gap is an
// outage note, not a decision: the feed was unreachable, nothing was submitted,
// and the window is still owed a charge. Treating a gap as terminal meant one
// transient fetch failure permanently burned that window, and over an
// eighteen-day run each burned window is a row missing from the demo ledger.
const TERMINAL: ReadonlySet<Decision> = new Set(["paid", "refused", "skipped"]);

// A gap row already exists for this window, so a retry should not append a
// second one. The window stays retryable; the outage is recorded once.
const GAP: Decision = "gap";

export class JsonlJournal {
  constructor(readonly path: string) {}

  load(): JournalRow[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    const rows: JournalRow[] = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        rows.push(JSON.parse(line) as JournalRow);
      } catch {
        // A torn line is skipped so a crash mid-write cannot brick the process.
      }
    }
    return rows;
  }

  hasNonce(nonce: bigint): boolean {
    const key = nonce.toString();
    for (const row of this.load()) {
      if (row.nonce === key && TERMINAL.has(row.decision)) return true;
    }
    return false;
  }

  /// The highest nonce that actually settled on chain. Nonces are monotonic on
  /// payment, so a window below this can never pay again and retrying it would
  /// only produce a meaningless "nonce already settled" refusal.
  maxSettledNonce(): bigint {
    let max = 0n;
    for (const row of this.load()) {
      if (row.signature !== null && (row.decision === "paid" || row.decision === "refused")) {
        const n = BigInt(row.nonce);
        if (n > max) max = n;
      }
    }
    return max;
  }

  /// True when an outage was already recorded for this window. The window is
  /// still retryable; this only stops the journal filling with duplicate gaps.
  hasGap(nonce: bigint): boolean {
    const key = nonce.toString();
    for (const row of this.load()) {
      if (row.nonce === key && row.decision === GAP) return true;
    }
    return false;
  }

  counts(): { paid: number; refused: number; gap: number; skipped: number; total: number } {
    const rows = this.load();
    const out = { paid: 0, refused: 0, gap: 0, skipped: 0, total: rows.length };
    for (const row of rows) {
      if (row.decision === "paid") out.paid += 1;
      else if (row.decision === "refused") out.refused += 1;
      else if (row.decision === "gap") out.gap += 1;
      else if (row.decision === "skipped") out.skipped += 1;
    }
    return out;
  }

  append(row: JournalRow): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, "utf8");
  }
}
