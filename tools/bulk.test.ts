import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  COMPLETENESS,
  COMPLETENESS_NOTE,
  CSV_COLUMNS,
  bundleToCsv,
  bundleToJson,
  buildRecordFromIndexed,
  buildScope,
  filterIndexed,
  formatBulkReport,
  inferFormat,
  makeBundle,
  parseBundle,
  parseCsv,
  parseExportText,
  parseTimeBound,
  type DecisionBundle,
  type IndexedDecision,
} from "./bulk.js";
import { parseRecord, type DecisionRecord, type MandateAccount } from "./lib.js";

const SAMPLE = {
  schema_version: 1,
  cluster: "devnet",
  genesis_hash: "5NrLCg7BRzhkDYxbiDy966tfYmVPfpprZamwXLALe3L5",
  program_id: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  mandate: "CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g",
  limits: {
    cap: 500000000,
    per_tx_max: 60000000,
    expires_at: 1792465093,
    merchant: "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG",
    purpose: "charging",
  },
  kind: "refused",
  amount: 180000000,
  counterparty: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  timestamp: 1789871742,
  nonce: 2,
  reason_code: 5,
  reason_text: "over per-payment maximum",
  suggested_override: 180000000,
  signature: "3TtZbJJFYDGc29GemFgyMeJXc188MiZ7LfJnUUe1Y3vGrtYtZFZyyF9mwZAt31999nMdMFXBKvzThwXugHUm7cJp",
};

const PAID = {
  ...SAMPLE,
  kind: "paid",
  amount: 50000000,
  nonce: 1,
  reason_code: 0,
  reason_text: "ok",
  suggested_override: 0,
  timestamp: 1789870000,
  signature: "4N13AokSVj2A9fJyCZiypzhG9P6mdpMvpjcnDvzVUi2Qp6jUx1Ud34tHUDt1TQENzXu7TFWTfrKHHCLfrpKTBJ9a",
};

function rec(over: Record<string, unknown> = {}): DecisionRecord {
  return parseRecord({ ...SAMPLE, ...over });
}

function indexed(over: Partial<IndexedDecision> = {}): IndexedDecision {
  return {
    signature: SAMPLE.signature,
    timestamp: SAMPLE.timestamp,
    mandate: SAMPLE.mandate,
    amount: BigInt(SAMPLE.amount),
    nonce: BigInt(SAMPLE.nonce),
    counterparty: SAMPLE.counterparty,
    kind: "refused",
    reason: 5,
    suggestedOverride: 180000000n,
    ...over,
  };
}

function bundleOf(decisions: DecisionRecord[], scope = buildScope({ mandate: SAMPLE.mandate })): DecisionBundle {
  return makeBundle({
    cluster: SAMPLE.cluster,
    genesisHash: SAMPLE.genesis_hash,
    programId: SAMPLE.program_id,
    scope,
    decisions,
  });
}

test("default rule scope keeps refused rows; it does not drop them", () => {
  const rows = [
    indexed({ kind: "paid", nonce: 1n, amount: 50n, signature: "paidSig", timestamp: 100, reason: 0, suggestedOverride: 0n }),
    indexed({ kind: "refused", nonce: 2n, amount: 180n, signature: "refusedSig", timestamp: 200 }),
  ];
  const got = filterIndexed(rows, { mandate: SAMPLE.mandate });
  assert.equal(got.length, 2);
  assert.equal(got.filter((r) => r.kind === "refused").length, 1);
  assert.equal(got[1]?.signature, "refusedSig");
});

test("date range keeps the rows that landed in the window and does not invent a row for a gap", () => {
  const rows = [
    indexed({ signature: "a", timestamp: 100, nonce: 1n, kind: "paid", reason: 0, suggestedOverride: 0n }),
    indexed({ signature: "c", timestamp: 300, nonce: 3n, kind: "refused" }),
  ];
  const got = filterIndexed(rows, { from: 100, to: 300 });
  assert.deepEqual(
    got.map((r) => r.signature),
    ["a", "c"],
  );
  assert.ok(!got.some((r) => r.timestamp === 200));
});

test("date range does not guess a timestamp for a row that has none", () => {
  const rows = [indexed({ signature: "unknown", timestamp: null })];
  assert.equal(filterIndexed(rows, { from: 1, to: 9 }).length, 0);
  assert.equal(filterIndexed(rows, { mandate: SAMPLE.mandate }).length, 1);
});

test("rule scope excludes a different mandate rather than filling the range from elsewhere", () => {
  const rows = [
    indexed({ signature: "mine", mandate: SAMPLE.mandate }),
    indexed({ signature: "other", mandate: "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG" }),
  ];
  const got = filterIndexed(rows, { mandate: SAMPLE.mandate });
  assert.deepEqual(
    got.map((r) => r.signature),
    ["mine"],
  );
});

test("empty filter result stays empty; nothing is synthesized", () => {
  const rows = [indexed({ timestamp: 50 })];
  assert.deepEqual(filterIndexed(rows, { from: 100, to: 200 }), []);
});

test("parseTimeBound treats a calendar day as UTC midnight, and --to as the end of that day", () => {
  assert.equal(parseTimeBound("2026-09-20", false), Math.floor(Date.UTC(2026, 8, 20) / 1000));
  assert.equal(parseTimeBound("2026-09-20", true), Math.floor(Date.UTC(2026, 8, 20, 23, 59, 59) / 1000));
  assert.equal(parseTimeBound("1789871742", false), 1789871742);
});

test("buildScope names a rule versus a date range", () => {
  assert.equal(buildScope({ mandate: SAMPLE.mandate }).type, "rule");
  assert.equal(buildScope({ from: 1, to: 2 }).type, "date_range");
  assert.throws(() => buildScope({}), /mandate/);
});

test("JSON bundle carries completeness=payments and a signature on every decision", () => {
  const paid = rec(PAID);
  const refused = rec();
  const json = bundleToJson(bundleOf([paid, refused]));
  const parsed = parseBundle(JSON.parse(json));
  assert.equal(parsed.completeness, COMPLETENESS);
  assert.match(parsed.completeness_note, /Never complete over attempts/);
  assert.equal(parsed.decisions.length, 2);
  assert.equal(parsed.decisions[0]?.signature, paid.signature);
  assert.equal(parsed.decisions[1]?.signature, refused.signature);
  assert.equal(parsed.decisions[1]?.kind, "refused");
});

test("parseBundle rejects a file that omits completeness or claims attempts", () => {
  const good = JSON.parse(bundleToJson(bundleOf([rec()])));
  const { completeness: _drop, ...rest } = good;
  assert.throws(() => parseBundle(rest), /completeness/);
  assert.throws(() => parseBundle({ ...good, completeness: "attempts" }), /payments/);
});

test("CSV opens as one row per decision, with signature and completeness on every row", () => {
  const paid = rec(PAID);
  const refused = rec();
  const csv = bundleToCsv(bundleOf([paid, refused]));
  assert.match(csv, /^# completeness=payments/m);
  assert.match(csv, /Never complete over attempts/);
  for (const col of CSV_COLUMNS) {
    assert.match(csv, new RegExp(`(?:^|,)${col}(?:,|$)`, "m"));
  }
  const parsed = parseCsv(csv);
  assert.equal(parsed.completeness, COMPLETENESS);
  assert.equal(parsed.decisions.length, 2);
  assert.equal(parsed.decisions[0]?.signature, paid.signature);
  assert.equal(parsed.decisions[1]?.signature, refused.signature);
  assert.equal(parsed.decisions[1]?.kind, "refused");
  assert.equal(parsed.decisions[1]?.reason_text, "over per-payment maximum");
});

test("CSV round-trips a purpose that contains a comma", () => {
  const row = rec({ limits: { ...SAMPLE.limits, purpose: "charging, home" } });
  const parsed = parseCsv(bundleToCsv(bundleOf([row])));
  assert.equal(parsed.decisions[0]?.limits.purpose, "charging, home");
});

test("empty CSV still states completeness=payments and does not invent a decision", () => {
  const csv = bundleToCsv(bundleOf([]));
  const parsed = parseCsv(csv);
  assert.equal(parsed.completeness, COMPLETENESS);
  assert.equal(parsed.decisions.length, 0);
  assert.equal(parsed.scope.type, "rule");
  assert.equal(parsed.scope.mandate, SAMPLE.mandate);
});

test("parseExportText accepts a single record, a bundle, and CSV", () => {
  const single = parseExportText(JSON.stringify(SAMPLE));
  assert.equal(single.kind, "single");
  if (single.kind === "single") assert.equal(single.record.signature, SAMPLE.signature);

  const bulk = parseExportText(bundleToJson(bundleOf([rec(), rec(PAID)])));
  assert.equal(bulk.kind, "bulk");
  if (bulk.kind === "bulk") assert.equal(bulk.bundle.decisions.length, 2);

  const csv = parseExportText(bundleToCsv(bundleOf([rec()])));
  assert.equal(csv.kind, "bulk");
  if (csv.kind === "bulk") assert.equal(csv.bundle.decisions[0]?.kind, "refused");
});

test("formatBulkReport names every rejected row and why, and counts the confirmed ones", () => {
  const report = formatBulkReport([
    { index: 1, signature: "goodSig", kind: "paid", nonce: "1", ok: true, failures: [] },
    {
      index: 2,
      signature: "tamperedSig",
      kind: "refused",
      nonce: "2",
      ok: false,
      failures: ["amount (instruction): record has 1, chain has 180000000"],
    },
    { index: 3, signature: "alsoGood", kind: "paid", nonce: "3", ok: true, failures: [] },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.confirmed, 2);
  assert.equal(report.rejected, 1);
  assert.match(report.text, /VERDICT: REJECTED/);
  assert.match(report.text, /confirmed: 2/);
  assert.match(report.text, /rejected: 1/);
  assert.match(report.text, /REJECTED row 2 signature=tamperedSig/);
  assert.match(report.text, /amount \(instruction\): record has 1, chain has 180000000/);
  assert.doesNotMatch(report.text, /REJECTED row 1/);
  assert.doesNotMatch(report.text, /REJECTED row 3/);
});

test("formatBulkReport confirms an empty scope rather than inventing a failure", () => {
  const report = formatBulkReport([]);
  assert.equal(report.ok, true);
  assert.equal(report.confirmed, 0);
  assert.match(report.text, /VERDICT: CONFIRMED/);
  assert.match(report.text, /empty export/);
});

test("inferFormat uses the flag, then the file suffix, then json", () => {
  assert.equal(inferFormat("out.csv", undefined), "csv");
  assert.equal(inferFormat("out.json", undefined), "json");
  assert.equal(inferFormat("out.csv", "json"), "json");
  assert.equal(inferFormat(undefined, undefined), "json");
});

test("buildRecordFromIndexed writes the indexer signature onto the version-1 record", () => {
  const owner = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
  const merchant = new PublicKey(SAMPLE.limits.merchant);
  const mandateAccount = {
    owner,
    agent: owner,
    mint: owner,
    source: owner,
    merchant,
    mandateId: 1n,
    cap: 500000000n,
    spent: 0n,
    perTxMax: 60000000n,
    expiresAt: 1792465093n,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 1n,
    purpose: "charging",
    status: 1,
    spendCount: 0,
    refusalCount: 1,
    bump: 255,
  } satisfies MandateAccount;
  const record = buildRecordFromIndexed({
    cluster: SAMPLE.cluster,
    genesisHash: SAMPLE.genesis_hash,
    programId: new PublicKey(SAMPLE.program_id),
    mandateAccount,
    decision: indexed(),
  });
  assert.equal(record.signature, SAMPLE.signature);
  assert.equal(record.kind, "refused");
  assert.equal(record.amount, 180000000n);
});

test("completeness note is the honest limit, not a claim over attempts", () => {
  assert.equal(COMPLETENESS, "payments");
  assert.match(COMPLETENESS_NOTE, /paid and refused charges that landed on chain/);
  assert.match(COMPLETENESS_NOTE, /Never complete over attempts/);
  assert.doesNotMatch(COMPLETENESS_NOTE, /attempt that never/);
});
