import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { useOwnDatabase } from './db.js';

await useOwnDatabase('veto_index_perf_test');
const { migrate } = await import('../src/db/migrate.js');
const { pool, transaction } = await import('../src/db/transaction.js');
const { insertDecision, reverseDecision } = await import('../src/ingest.js');
import type { Decision } from '../src/ingest.js';

const ROWS = Number(process.env.INGEST_PERF_ROWS ?? 5000);
const WINDOW = Math.floor(ROWS / 10);
const BASE = Date.UTC(2026, 0, 1);

// One rule, mostly unique nonces, with allowances that suppress an earlier
// payment of the same nonce, standalone refusals, and opens, so nonce-scoped
// reclassification and every extreme are exercised.
function kindAndNonce(i: number): { kind: number; nonce: string } {
  if (i % 250 === 249) return { kind: 0, nonce: String(20_000_000 + i) };
  if (i % 100 === 99) return { kind: 2, nonce: String(10_000_000 + i) };
  if (i % 50 === 49) return { kind: 3, nonce: String(i - 49) };
  return { kind: 1, nonce: String(i) };
}

function event(i: number): Decision {
  const { kind, nonce } = kindAndNonce(i);
  return {
    signature: `sig${i}`, slot: String(1000 + i), block_time: new Date(BASE + i * 2000),
    instruction_index: 0, inner_index: -1, program_version: 1, rule_kind: 'mandate',
    rule: 'perf-rule', agent: 'perf-agent', owner: 'owner', kind, reason: 0,
    amount: '1000', nonce, counterparty: 'merchant',
    suggested_override: null, commitment: 'finalized', source: 'backfill',
  };
}

before(async () => { await migrate(); });
beforeEach(async () => { await pool.query('TRUNCATE decisions, decision_keys, deltas, rule_stats, agent_stats CASCADE'); });
after(() => pool.end());

// The expected state of a clean replay over the stored decisions: each row's
// contribution from its nonce group, summed counters, and extrema.
async function replay() {
  const { rows } = await pool.query(`SELECT signature, instruction_index, inner_index, kind, nonce::text AS nonce,
    block_time, slot::text AS slot FROM decisions WHERE rule = 'perf-rule'`);
  const groups = new Map<string, { allowance: boolean; refusal: boolean }>();
  for (const row of rows) {
    const group = groups.get(row.nonce) ?? { allowance: false, refusal: false };
    if (row.kind === 3) group.allowance = true;
    if (row.kind === 2) group.refusal = true;
    groups.set(row.nonce, group);
  }
  const totals = { requests: 0n, paid: 0n, outside: 0n, allowances: 0n, declines: 0n };
  const contributions = new Map<string, Record<string, bigint>>();
  for (const row of rows) {
    const group = groups.get(row.nonce)!;
    const contribution = {
      paid: row.kind === 1 && !group.allowance ? 1n : 0n,
      outside: row.kind === 2 || (row.kind === 3 && !group.refusal) ? 1n : 0n,
      allowances: row.kind === 3 ? 1n : 0n,
      declines: row.kind === 100 ? 1n : 0n,
    };
    const withRequests = { ...contribution, requests: contribution.paid + contribution.outside };
    contributions.set(`${row.signature}:${row.instruction_index}:${row.inner_index}`, withRequests);
    for (const [counter, value] of Object.entries(withRequests)) totals[counter as keyof typeof totals] += value;
  }
  const times = rows.map(row => row.block_time.getTime());
  const openTimes = rows.filter(row => row.kind === 0).map(row => row.block_time.getTime());
  return {
    totals, contributions,
    first_open_ts: openTimes.length ? new Date(Math.min(...openTimes)) : null,
    first_ts: times.length ? new Date(Math.min(...times)) : null,
    last_ts: times.length ? new Date(Math.max(...times)) : null,
    last_slot: rows.length ? String(Math.max(...rows.map(row => Number(row.slot)))) : null,
  };
}

async function assertMatchesReplay() {
  const expected = await replay();
  const stats = (await pool.query(`SELECT requests, paid, outside, allowances, declines,
    first_open_ts, first_ts, last_ts, last_slot::text AS last_slot FROM rule_stats WHERE rule = 'perf-rule'`)).rows[0];
  for (const counter of ['requests', 'paid', 'outside', 'allowances', 'declines'] as const) {
    assert.equal(stats?.[counter] ?? '0', expected.totals[counter].toString(), `rule_stats.${counter}`);
  }
  assert.deepEqual(stats?.first_open_ts ?? null, expected.first_open_ts, 'rule_stats.first_open_ts');
  assert.deepEqual(stats?.first_ts ?? null, expected.first_ts, 'rule_stats.first_ts');
  assert.deepEqual(stats?.last_ts ?? null, expected.last_ts, 'rule_stats.last_ts');
  assert.deepEqual(stats?.last_slot ?? null, expected.last_slot, 'rule_stats.last_slot');
  const agent = (await pool.query(`SELECT requests FROM agent_stats WHERE agent = 'perf-agent'`)).rows[0];
  assert.equal(agent?.requests ?? '0', expected.totals.requests.toString(), 'agent_stats.requests');
  const deltas = await pool.query('SELECT signature, instruction_index, inner_index, requests, paid, outside, allowances, declines FROM deltas');
  assert.equal(deltas.rowCount, expected.contributions.size, 'one delta per surviving decision');
  for (const row of deltas.rows) {
    const contribution = expected.contributions.get(`${row.signature}:${row.instruction_index}:${row.inner_index}`);
    assert.ok(contribution, `delta without a decision: ${row.signature}`);
    for (const counter of ['requests', 'paid', 'outside', 'allowances', 'declines'] as const) {
      assert.equal(row[counter], contribution[counter].toString(), `delta.${counter} of ${row.signature}`);
    }
  }
}

test(`${ROWS} inserts into one rule stay flat and match a clean replay`, async () => {
  const timings: number[] = [];
  for (let i = 0; i < ROWS; i++) {
    const start = performance.now();
    await transaction(tx => insertDecision(tx, event(i)));
    timings.push(performance.now() - start);
  }
  await assertMatchesReplay();
  // Reverse the oldest and the newest rows: both hold extrema, so their
  // removal must rescan those extrema and still match a clean replay.
  await reverseDecision(event(0));
  await reverseDecision(event(ROWS - 1));
  await assertMatchesReplay();
  const first = timings.slice(0, WINDOW).reduce((a, b) => a + b, 0);
  const last = timings.slice(ROWS - WINDOW).reduce((a, b) => a + b, 0);
  assert.ok(last <= first * 3,
    `the last ${WINDOW} inserts took ${last.toFixed(0)}ms, over 3x the first ${WINDOW} at ${first.toFixed(0)}ms`);
});
