import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { useOwnDatabase } from './db.js';

await useOwnDatabase('veto_index_boundary_test');
const { ingestLocation } = await import('../src/boundary.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool, transaction } = await import('../src/db/transaction.js');
const { insertDecision } = await import('../src/ingest.js');
import type { Decision } from '../src/ingest.js';

const location = {
  signature: 'sig', slot: 250_000_000, timestamp: 1_800_000_000,
  instructionIndex: 1, innerInstructionIndex: 2,
};

before(async () => { await migrate(); });
beforeEach(async () => { await pool.query('TRUNCATE decisions, decision_keys, deltas, rule_stats, agent_stats CASCADE'); });
after(() => pool.end());

test('the decoder slot number becomes the ingest string', () => {
  assert.equal(ingestLocation(location).slot, '250000000');
});

test('a null decoder inner index becomes the ingest -1 top-level marker', () => {
  assert.equal(ingestLocation({ ...location, innerInstructionIndex: null }).inner_index, -1);
  assert.equal(ingestLocation(location).inner_index, 2);
});

test('a null decoder block time uses the slot time supplied by the caller', () => {
  const converted = ingestLocation({ ...location, timestamp: null }, 1_800_000_500);
  assert.deepEqual(converted.block_time, new Date(1_800_000_500_000));
  assert.deepEqual(ingestLocation(location, 1_800_000_500).block_time, new Date(1_800_000_000_000));
});

test('a null decoder block time without a slot time is refused', () => {
  assert.throws(() => ingestLocation({ ...location, timestamp: null }), /No block time/);
  assert.throws(() => ingestLocation({ ...location, timestamp: null }, null), /No block time/);
});

test('a converted top-level location inserts once under inner index -1', async () => {
  const identity = ingestLocation({ ...location, instructionIndex: 0, innerInstructionIndex: null });
  const row: Decision = {
    ...identity, program_version: 1, rule_kind: 'mandate', rule: 'rule', agent: 'agent',
    owner: 'owner', kind: 1, reason: 0, amount: '5', nonce: '1', counterparty: 'merchant',
    suggested_override: null, commitment: 'confirmed', source: 'backfill',
  };
  assert.equal(await transaction(tx => insertDecision(tx, row)), true);
  const stored = (await pool.query('SELECT slot, block_time, inner_index FROM decisions')).rows[0];
  assert.equal(stored.slot, '250000000');
  assert.equal(stored.inner_index, -1);
  assert.deepEqual(stored.block_time, new Date(1_800_000_000_000));
  assert.equal(await transaction(tx => insertDecision(tx, row)), false);
  assert.equal((await pool.query('SELECT paid FROM rule_stats')).rows[0].paid, '1');
});
