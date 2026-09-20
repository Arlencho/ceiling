import { KIND_PAID, KIND_REFUSED, kindName } from "./constants.js";
import type { Comparison, Decision, OverlapRow, RingEntry } from "./types.js";

export function decisionFieldsMatch(ring: RingEntry, indexed: Decision): boolean {
  return (
    ring.amount === indexed.amount &&
    ring.nonce === indexed.nonce &&
    ring.counterparty === indexed.counterparty &&
    kindName(ring.kind) === indexed.kind &&
    ring.reason === indexed.reason &&
    ring.suggestedOverride === indexed.suggestedOverride
  );
}

export function fieldDiffs(ring: RingEntry, indexed: Decision | null): string[] {
  if (!indexed) return ["missing from indexer"];
  const diffs: string[] = [];
  const checks: [string, string, string][] = [
    ["amount", ring.amount.toString(), indexed.amount.toString()],
    ["nonce", ring.nonce.toString(), indexed.nonce.toString()],
    ["counterparty", ring.counterparty, indexed.counterparty],
    ["kind", kindName(ring.kind), indexed.kind],
    ["reason", String(ring.reason), String(indexed.reason)],
    ["suggestedOverride", ring.suggestedOverride.toString(), indexed.suggestedOverride.toString()],
  ];
  for (const [name, left, right] of checks) {
    if (left !== right) diffs.push(`${name}: ring=${left} indexer=${right}`);
  }
  const ringTs = Number(ring.ts);
  if (indexed.timestamp !== null && ringTs !== indexed.timestamp) {
    diffs.push(`timestamp: ring=${ringTs} indexer=${indexed.timestamp}`);
  }
  return diffs;
}

export function compareRingToHistory(ringEntries: RingEntry[], history: Decision[]): Comparison {
  const decisions = ringEntries.filter(
    (entry) => entry.kind === KIND_PAID || entry.kind === KIND_REFUSED,
  );
  const unused = [...history];
  const rows: OverlapRow[] = [];
  for (const ring of decisions) {
    let idx = unused.findIndex((item) => decisionFieldsMatch(ring, item));
    if (idx === -1) {
      idx = unused.findIndex(
        (item) =>
          item.nonce === ring.nonce &&
          item.kind === kindName(ring.kind) &&
          item.amount === ring.amount,
      );
    }
    if (idx === -1) {
      rows.push({ ring, indexed: null, equal: false, diffs: fieldDiffs(ring, null) });
      continue;
    }
    const indexed = unused.splice(idx, 1)[0] ?? null;
    const diffs = fieldDiffs(ring, indexed);
    const equal = diffs.filter((d) => !d.startsWith("timestamp:")).length === 0;
    rows.push({ ring, indexed, equal, diffs });
  }
  return {
    ringDecisions: decisions.length,
    matched: rows.filter((row) => row.equal).length,
    ok: rows.every((row) => row.equal),
    rows,
    extraInIndexer: unused,
  };
}
