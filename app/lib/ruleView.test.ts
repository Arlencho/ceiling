import assert from 'node:assert/strict';
import test from 'node:test';

import { STATUS_ACTIVE, STATUS_REVOKED } from './constants';
import type { MandateAccount } from './mandate';
import { displayPurpose, ruleSentence, ruleStatusLabel, stampedRulesetLine } from './ruleView';
import { VTEST_MINT } from './tokens';

function mandate(over: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: 'Mandate1111111111111111111111111111111111111',
    owner: 'Owner111111111111111111111111111111111111111',
    agent: 'Agent111111111111111111111111111111111111111',
    mint: VTEST_MINT,
    source: 'Source11111111111111111111111111111111111111',
    merchant: '6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG',
    mandateId: 1n,
    cap: 100_000_000n,
    spent: 666_000n,
    perTxMax: 500_000n,
    expiresAt: BigInt(Math.floor(Date.UTC(2026, 11, 19) / 1000)),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 1n,
    purpose: 'SE3 home charging [se3-charging v1]',
    status: STATUS_ACTIVE,
    spendCount: 3,
    refusalCount: 1,
    bump: 255,
    ...over,
  };
}

test('the rule reads as a sentence a stranger can understand', () => {
  const line = ruleSentence(mandate(), 6);
  assert.ok(line.startsWith('Pay 6i99...PdCG up to 0.5 VTEST at a time and 100 VTEST in total, until'));
  assert.ok(line.includes('for SE3 home charging.'));
  assert.equal(line.includes('[se3-charging v1]'), false);
});

test('display purpose strips the ruleset stamp and keeps an unstamped string', () => {
  assert.equal(displayPurpose('SE3 home charging [se3-charging v1]'), 'SE3 home charging');
  assert.equal(displayPurpose('cap a mint bot'), 'cap a mint bot');
  assert.equal(stampedRulesetLine('SE3 home charging [se3-charging v1]'), 'se3-charging v1');
  assert.equal(stampedRulesetLine('cap a mint bot'), null);
});

test('status current is only the selected active rule', () => {
  const now = 1_000n;
  const live = mandate({ expiresAt: 2_000n, status: STATUS_ACTIVE });
  assert.equal(ruleStatusLabel(live, now, true), 'current');
  assert.equal(ruleStatusLabel(live, now, false), 'active');
  assert.equal(ruleStatusLabel(mandate({ status: STATUS_REVOKED }), now, true), 'revoked');
});
