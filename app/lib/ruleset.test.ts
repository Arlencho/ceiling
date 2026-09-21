import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PURPOSE_MAX_LEN } from './constants';
import { parseBaseUnits } from './format';
import {
  addRuleset,
  applyRuleset,
  assertPurposeMayOpen,
  nextRulesetVersion,
  parsePurposeStamp,
  PAYEE_NOT_IN_RULESET,
  purposeHasStampSuffix,
  rulesetSlug,
  stampAlignment,
  stampAlignmentLine,
  stampPurpose,
  type Ruleset,
} from './ruleset';

const mintBudget = (): Ruleset => ({
  id: 'mint-budget',
  name: 'Mint budget',
  version: 2,
  cap: '40',
  perTxMax: '2',
  expiryDays: '7',
  merchant: '6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG',
  purpose: 'cap a mint bot',
});

test('applying a ruleset copies the limits and stamps identity and version into purpose', () => {
  const fields = applyRuleset(mintBudget());
  assert.equal(fields.cap, '40');
  assert.equal(fields.perTxMax, '2');
  assert.equal(fields.expiryDays, '7');
  assert.equal(fields.merchant, '6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG');
  assert.equal(fields.purpose, 'cap a mint bot [mint-budget v2]');
  assert.equal(fields.rulesetId, 'mint-budget');
  assert.equal(fields.rulesetVersion, 2);
  assert.ok(fields.purpose.length <= PURPOSE_MAX_LEN);
});

test('the stamped purpose is on chain length and round-trips the ruleset identity', () => {
  const stamped = stampPurpose('SE3 home charging', 'se3-charging', 1);
  assert.equal(stamped, 'SE3 home charging [se3-charging v1]');
  const parsed = parsePurposeStamp(stamped);
  assert.equal(parsed.purpose, 'SE3 home charging');
  assert.equal(parsed.rulesetId, 'se3-charging');
  assert.equal(parsed.version, 1);
});

test('an unstamped purpose is left as the owner wrote it', () => {
  const parsed = parsePurposeStamp('SE3 home charging');
  assert.equal(parsed.purpose, 'SE3 home charging');
  assert.equal(parsed.rulesetId, null);
  assert.equal(parsed.version, null);
});

test('a long purpose is truncated so the stamp still fits the on-chain limit', () => {
  const long = 'x'.repeat(PURPOSE_MAX_LEN);
  const stamped = stampPurpose(long, 'mint-budget', 2);
  assert.equal(stamped.length, PURPOSE_MAX_LEN);
  assert.ok(stamped.endsWith('[mint-budget v2]'));
  const parsed = parsePurposeStamp(stamped);
  assert.equal(parsed.rulesetId, 'mint-budget');
  assert.equal(parsed.version, 2);
});

test('a ruleset slug is the identity written into purpose', () => {
  assert.equal(rulesetSlug('Mint budget'), 'mint-budget');
  assert.equal(rulesetSlug('  SE3 Home Charging  '), 'se3-home-charging');
});

test('a typed stamp suffix is rejected unless the owner is applying a saved ruleset', () => {
  assert.equal(purposeHasStampSuffix('x [mint-budget v1]'), true);
  assert.equal(purposeHasStampSuffix('cap a mint bot'), false);
  assert.doesNotThrow(() => assertPurposeMayOpen('cap a mint bot [mint-budget v2]', true));
  assert.throws(
    () => assertPurposeMayOpen('x [mint-budget v1]', false),
    /Do not type a ruleset stamp into purpose/,
  );
});

test('a purpose stamp is checked against the ruleset on this phone', () => {
  const stored = mintBudget();
  const cap = parseBaseUnits(stored.cap, 6);
  const perTxMax = parseBaseUnits(stored.perTxMax, 6);
  const match = stampAlignment({
    purpose: 'cap a mint bot [mint-budget v2]',
    cap,
    perTxMax,
    decimals: 6,
    rulesets: [stored],
  });
  assert.equal(match?.alignment, 'match');
  assert.equal(stampAlignmentLine('match', 2), 'matches ruleset v2 on this phone');

  const differ = stampAlignment({
    purpose: 'cap a mint bot [mint-budget v2]',
    cap: 999_000_000n,
    perTxMax,
    decimals: 6,
    rulesets: [stored],
  });
  assert.equal(differ?.alignment, 'limits-differ');
  assert.equal(
    stampAlignmentLine('limits-differ', 2),
    'limits differ from ruleset v2 on this phone',
  );

  const missing = stampAlignment({
    purpose: 'x [mint-budget v1]',
    cap,
    perTxMax,
    decimals: 6,
    rulesets: [stored],
  });
  assert.equal(missing?.alignment, 'missing');
  assert.equal(stampAlignmentLine('missing', 1), 'no ruleset with this stamp on this phone');
});

test('changing the payee after applying a ruleset does not make the stamp report that limits differ', () => {
  const stored = mintBudget();
  const applied = applyRuleset(stored);
  const otherPayee = 'OtherPayee111111111111111111111111111111111';
  assert.notEqual(otherPayee, stored.merchant);
  assert.equal(applied.merchant, stored.merchant);
  const alignment = stampAlignment({
    purpose: applied.purpose,
    cap: parseBaseUnits(applied.cap, 6),
    perTxMax: parseBaseUnits(applied.perTxMax, 6),
    decimals: 6,
    rulesets: [stored],
  });
  assert.equal(alignment?.alignment, 'match');
});

test('every ruleset surface says the payee is chosen per agent and is not part of the ruleset', () => {
  const files = [
    '../app/rule/new.tsx',
    '../app/(tabs)/rules.tsx',
    '../app/rule/[address].tsx',
    '../app/help/index.tsx',
  ];
  const needle = 'The payee is chosen per agent and is not part of the ruleset.';
  assert.equal(PAYEE_NOT_IN_RULESET, needle);
  for (const rel of files) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(
      text.includes('PAYEE_NOT_IN_RULESET') || text.includes(needle),
      `${rel} must say that the payee is chosen per agent and is not part of the ruleset`,
    );
  }
});

test('saving a ruleset publishes a new version and never overwrites an existing one', () => {
  const v1: Ruleset = { ...mintBudget(), version: 1 };
  const stored = addRuleset([], v1);
  assert.equal(nextRulesetVersion(stored, 'mint-budget'), 2);
  const v2 = addRuleset(stored, { ...v1, version: 2, cap: '80' });
  assert.equal(v2.length, 2);
  assert.equal(v2[0]?.cap, '40');
  assert.equal(v2[1]?.cap, '80');
  assert.throws(() => addRuleset(v2, v1), /cannot be overwritten/);
});
