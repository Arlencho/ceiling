import assert from 'node:assert/strict';
import test from 'node:test';

import { KIND_PAID, KIND_REFUSED } from './constants';
import {
  CSV_COLUMNS,
  COMPLETENESS,
  COMPLETENESS_NOTE,
  bundleToCsv,
  findLedgerDecision,
  formatExport,
  loadedRuleMatchesDecision,
  parseDayBound,
  parseDecisionId,
  rowToExportable,
  selectExportRows,
  type ExportContext,
  type ExportableDecision,
} from './exportRecord';
import type { MandateAccount } from './mandate';
import type { LedgerRow } from './ring';

function mandate(): MandateAccount {
  return {
    address: 'Mandate1111111111111111111111111111111111111',
    owner: 'Owner111111111111111111111111111111111111111',
    agent: 'Agent111111111111111111111111111111111111111',
    mint: 'Mint1111111111111111111111111111111111111111',
    source: 'Source11111111111111111111111111111111111111',
    merchant: '6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG',
    mandateId: 1n,
    cap: 100_000_000n,
    spent: 666_000n,
    perTxMax: 500_000n,
    expiresAt: 1_797_713_870n,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 1n,
    purpose: 'SE3 home charging [se3-charging v1]',
    status: 0,
    spendCount: 3,
    refusalCount: 1,
    bump: 255,
  };
}

function row(args: Partial<ExportableDecision> & Pick<ExportableDecision, 'kind' | 'nonce' | 'timestamp'>): ExportableDecision {
  return {
    signature: args.signature === undefined ? `sig-${args.nonce.toString()}` : args.signature,
    slot: args.slot ?? 1,
    kind: args.kind,
    amount: args.amount ?? 1n,
    counterparty: args.counterparty ?? 'Dest111111111111111111111111111111111111111',
    timestamp: args.timestamp,
    nonce: args.nonce,
    reason_code: args.reason_code ?? 0,
    reason_text: args.reason_text ?? 'ok',
    suggested_override: args.suggested_override ?? 0n,
    mandate: args.mandate ?? mandate().address,
  };
}

const population: ExportableDecision[] = [
  row({ kind: 'paid', nonce: 1n, timestamp: 1_000n, amount: 446_000n, signature: 'sig-a' }),
  row({ kind: 'paid', nonce: 2n, timestamp: 2_000n, amount: 214_500n, signature: 'sig-b' }),
  row({
    kind: 'refused',
    nonce: 3n,
    timestamp: 3_000n,
    amount: 6_232_500n,
    reason_code: 5,
    reason_text: 'over per-payment maximum',
    suggested_override: 6_232_500n,
    signature: 'sig-c',
  }),
  row({ kind: 'paid', nonce: 4n, timestamp: 4_000n, amount: 5_500n, signature: null }),
];

const ctx: ExportContext = {
  cluster: 'devnet',
  genesisHash: 'Genesis1111111111111111111111111111111111111',
  programId: 'Pid11111111111111111111111111111111111111111',
  mandate: mandate(),
};

test('scope this decision returns only the matching row', () => {
  const selected = selectExportRows(population, {
    type: 'decision',
    nonce: 3n,
    kind: 'refused',
    timestamp: 3_000n,
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.signature, 'sig-c');
  assert.equal(selected[0]?.kind, 'refused');
});

test('scope a date range returns every charge in the inclusive window', () => {
  const selected = selectExportRows(population, { type: 'date_range', from: 2_000, to: 3_000 });
  assert.equal(selected.length, 2);
  assert.deepEqual(
    selected.map((r) => r.nonce),
    [2n, 3n],
  );
});

test('scope everything under this rule returns the whole population, including unsigned rows', () => {
  const selected = selectExportRows(population, { type: 'rule' });
  assert.equal(selected.length, 4);
});

test('CSV columns match the documented export header, in order', () => {
  assert.deepEqual(Array.from(CSV_COLUMNS), [
    'completeness',
    'scope_type',
    'scope_mandate',
    'scope_from',
    'scope_to',
    'schema_version',
    'cluster',
    'genesis_hash',
    'program_id',
    'mandate',
    'limits_cap',
    'limits_per_tx_max',
    'limits_expires_at',
    'limits_merchant',
    'limits_purpose',
    'kind',
    'amount',
    'counterparty',
    'timestamp',
    'nonce',
    'reason_code',
    'reason_text',
    'suggested_override',
    'signature',
  ]);
  const csv = formatExport({ rows: population, scope: { type: 'rule' }, shape: 'csv', ctx });
  assert.ok(csv.includes(CSV_COLUMNS.join(',')));
  assert.ok(csv.includes(`# completeness=${COMPLETENESS}`));
  assert.ok(csv.includes(COMPLETENESS_NOTE));
  assert.ok(csv.includes('sig-a'));
  assert.equal(csv.includes('sig-4'), false);
  const header = csv
    .split('\n')
    .find((line) => line.startsWith('completeness,'));
  assert.equal(header, CSV_COLUMNS.join(','));
  assert.equal(csv.includes('sig-c'), true);
  const dataRows = csv
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('completeness,'));
  assert.equal(dataRows.length, 3, 'unsigned rows are omitted so every exported line can be checked');
  assert.ok(dataRows.every((line) => line.includes('sig-')));
});

test('JSON for this decision is a single record, not a population envelope', () => {
  const json = formatExport({
    rows: population,
    scope: { type: 'decision', nonce: 3n, kind: 'refused', timestamp: 3_000n },
    shape: 'json',
    ctx,
  });
  const parsed = JSON.parse(json) as { kind?: string; signature?: string; decisions?: unknown };
  assert.equal(parsed.kind, 'refused');
  assert.equal(parsed.signature, 'sig-c');
  assert.equal(parsed.decisions, undefined);
});

test('JSON for everything under this rule is a bundle that states the honest limit', () => {
  const json = formatExport({ rows: population, scope: { type: 'rule' }, shape: 'json', ctx });
  const parsed = JSON.parse(json) as DecisionBundleLike;
  assert.equal(parsed.completeness, 'payments');
  assert.equal(parsed.completeness_note, COMPLETENESS_NOTE);
  assert.equal(parsed.scope.type, 'rule');
  assert.equal(parsed.scope.mandate, mandate().address);
  assert.equal(parsed.decisions.length, 3);
  assert.ok(parsed.decisions.every((d) => typeof d.signature === 'string' && d.signature.length > 0));
});

test('a CSV with zero data rows still states completeness and scope', () => {
  const csv = bundleToCsv({
    schema_version: 1,
    completeness: COMPLETENESS,
    completeness_note: COMPLETENESS_NOTE,
    cluster: ctx.cluster,
    genesis_hash: ctx.genesisHash,
    program_id: ctx.programId,
    scope: { type: 'rule', mandate: mandate().address, from: null, to: null },
    decisions: [],
  });
  assert.ok(csv.includes('# completeness=payments'));
  assert.ok(csv.includes(CSV_COLUMNS.join(',')));
  const dataRows = csv
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('completeness,'));
  assert.equal(dataRows.length, 0);
});

test('YYYY-MM-DD bounds are UTC calendar days, inclusive', () => {
  assert.equal(parseDayBound('2026-09-20', false), Math.floor(Date.UTC(2026, 8, 20) / 1000));
  assert.equal(parseDayBound('2026-09-20', true), Math.floor(Date.UTC(2026, 8, 20, 23, 59, 59) / 1000));
});

test('a decision is only read from the ring of the rule named in its id', () => {
  const paid: LedgerRow = {
    ts: 1_000n,
    amount: 1n,
    counterparty: 'x',
    nonce: 1n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    kindName: 'paid',
    reason: 0,
    reasonText: 'ok',
    signature: 'sig',
  };
  const parsed = parseDecisionId(`${mandate().address}:1000:1:1`);
  assert.ok(parsed);
  assert.equal(findLedgerDecision([paid], parsed, mandate().address)?.nonce, 1n);
  assert.equal(findLedgerDecision([paid], parsed, 'OtherMandate1111111111111111111111111111111'), undefined);
  assert.equal(loadedRuleMatchesDecision(mandate().address, parsed.mandate), true);
  assert.equal(loadedRuleMatchesDecision(mandate().address, 'OtherMandate1111111111111111111111111111111'), false);
  assert.equal(loadedRuleMatchesDecision(undefined, parsed.mandate), false);
});

test('opened and override ring rows are not exportable charges', () => {
  const opened: LedgerRow = {
    ts: 1n,
    amount: 0n,
    counterparty: 'x',
    nonce: 0n,
    suggestedOverride: 0n,
    kind: 0,
    kindName: 'opened',
    reason: 0,
    reasonText: 'ok',
    signature: 'sig',
  };
  assert.equal(rowToExportable(opened, mandate().address), null);
  const paid: LedgerRow = {
    ...opened,
    kind: KIND_PAID,
    kindName: 'paid',
    amount: 1n,
    nonce: 1n,
  };
  const refused: LedgerRow = {
    ...opened,
    kind: KIND_REFUSED,
    kindName: 'refused',
    amount: 2n,
    nonce: 2n,
    reason: 5,
    reasonText: 'over per-payment maximum',
  };
  assert.equal(rowToExportable(paid, mandate().address)?.kind, 'paid');
  assert.equal(rowToExportable(refused, mandate().address)?.kind, 'refused');
});

type DecisionBundleLike = {
  completeness: string;
  completeness_note: string;
  scope: { type: string; mandate: string | null };
  decisions: Array<{ signature: string }>;
};
