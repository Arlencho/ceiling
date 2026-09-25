import assert from 'node:assert/strict';
import test from 'node:test';

import { KIND_OPENED, KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, KIND_REVOKED, REASON_MERCHANT_NOT_ALLOWED, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE, STATUS_EXPIRED, STATUS_REVOKED } from './constants';
import { snapshotRule, type GradeDecision, type RuleFacts } from './grade';
import { VTEST_MINT } from './tokens';
import { earnedPlaques, plaquesForRule, plaqueShareText, ruleEndedInsideCap } from './plaques';

const START = 1_700_000_000n;
const DAY = 86400n;

function decision(over: Partial<GradeDecision> = {}): GradeDecision {
  return {
    kind: KIND_PAID,
    ts: START + DAY,
    amount: 8n,
    nonce: 1n,
    reason: 0,
    counterparty: '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG',
    ...over,
  };
}

function facts(rows: GradeDecision[], over: Partial<RuleFacts> = {}): RuleFacts {
  return {
    address: 'RuleAddress11111111111111111111111111111111',
    agent: 'AgentAddress1111111111111111111111111111111',
    purpose: 'Charging top-ups',
    cap: 300n,
    spent: 8n,
    perTxMax: 10n,
    expiresAt: START + 90n * DAY,
    status: STATUS_ACTIVE,
    decimals: 0,
    mint: VTEST_MINT,
    rows: [decision({ kind: KIND_OPENED, ts: START, nonce: 0n, amount: 300n }), ...rows],
    ...over,
  };
}

test('the first payment plaque names the amount, the rule payee and the limit', () => {
  const rule = snapshotRule(
    facts(
      [
        decision({
          ts: START + DAY,
          amount: 8n,
          counterparty: '2bt9bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbay7F',
        }),
      ],
      { merchant: '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG' },
    ),
    START + 5n * DAY,
  );
  const plaque = plaquesForRule(rule, START + 5n * DAY).find((item) => item.id === 'first-payment');
  assert.ok(plaque?.earned);
  assert.equal(plaque.title, 'First payment inside the rule');
  assert.match(plaque.detail, /Paid 8 VTEST to 6i99\.\.\.PdCG/);
  assert.doesNotMatch(plaque.detail, /2bt9/);
  assert.match(plaque.detail, /Limit per payment: 10 VTEST/);
  assert.match(plaque.dateLabel, /^Day 2,/);
});

test('the first refusal plaque says nothing moved', () => {
  const rule = snapshotRule(
    facts([
      decision({
        kind: KIND_REFUSED,
        ts: START + DAY,
        amount: 14n,
        reason: REASON_OVER_PER_TX_MAX,
      }),
    ]),
    START + 2n * DAY,
  );
  const plaque = plaquesForRule(rule, START + 2n * DAY).find((item) => item.id === 'first-refusal');
  assert.ok(plaque?.earned);
  assert.equal(plaque.title, 'First refusal saved');
  assert.match(plaque.detail, /Asked 14 VTEST, the limit is 10 VTEST/);
  assert.match(plaque.detail, /Nothing moved/);
});

test('ten refusals with none allowed is a plaque, and one allowance removes it', () => {
  const refusals = Array.from({ length: 10 }, (_, index) =>
    decision({
      kind: KIND_REFUSED,
      nonce: BigInt(index + 1),
      ts: START + BigInt(index + 1) * DAY,
      amount: 14n,
      reason: REASON_OVER_PER_TX_MAX,
    }),
  );
  const clean = snapshotRule(facts(refusals), START + 20n * DAY);
  const earned = plaquesForRule(clean, START + 20n * DAY).find((item) => item.id === 'ten-refusals');
  assert.equal(earned?.earned, true);
  assert.match(earned?.detail ?? '', /Money moved: 0/);

  const allowed = snapshotRule(
    facts([...refusals, decision({ kind: KIND_OVERRIDE, nonce: 1n, ts: START + 12n * DAY, amount: 14n })]),
    START + 20n * DAY,
  );
  const blocked = plaquesForRule(allowed, START + 20n * DAY).find((item) => item.id === 'ten-refusals');
  assert.equal(blocked?.earned, false);
});

test('30 days inside the rule counts only what had happened by that day', () => {
  const early = decision({ kind: KIND_PAID, nonce: 1n, ts: START + DAY, amount: 8n });
  const late = decision({ kind: KIND_PAID, nonce: 2n, ts: START + 40n * DAY, amount: 9n });
  const refusal = decision({
    kind: KIND_REFUSED,
    nonce: 3n,
    ts: START + 2n * DAY,
    amount: 14n,
    reason: REASON_MERCHANT_NOT_ALLOWED,
  });
  const now = START + 29n * DAY;
  const rule = snapshotRule(facts([early, refusal, late], { cap: 300n, spent: 17n }), now);
  const tooSoon = plaquesForRule(snapshotRule(facts([early]), START + 28n * DAY), START + 28n * DAY).find(
    (item) => item.id === 'thirty-days',
  );
  assert.equal(tooSoon?.earned, false);
  const plaque = plaquesForRule(rule, now).find((item) => item.id === 'thirty-days');
  assert.equal(plaque?.earned, true);
  assert.match(plaque?.detail ?? '', /^1 paid, 1 refused, 0 allowed after a refusal/);
  assert.match(plaque?.detail ?? '', /292 VTEST of 300 VTEST left that day/);
  assert.doesNotMatch(plaque?.detail ?? '', /2 paid/);
});

test('a rule that reaches its end inside the cap is engraved, and an early revoke is not', () => {
  const now = START + 90n * DAY;
  const finished = snapshotRule(
    facts([], { status: STATUS_EXPIRED, spent: 268n, cap: 300n }),
    now,
  );
  assert.equal(ruleEndedInsideCap(finished, now), true);
  const plaque = plaquesForRule(finished, now).find((item) => item.id === 'rule-ended');
  assert.equal(plaque?.earned, true);
  assert.equal(plaque?.title, 'Rule finished, rest returned');
  assert.match(plaque?.detail ?? '', /32 VTEST of 300 VTEST left in your wallet/);

  const revoked = snapshotRule(
    facts([decision({ kind: KIND_REVOKED, ts: START + 10n * DAY, nonce: 0n, amount: 0n })], {
      status: STATUS_REVOKED,
      spent: 10n,
    }),
    now,
  );
  assert.equal(ruleEndedInsideCap(revoked, now), false);
  assert.equal(plaquesForRule(revoked, now).find((item) => item.id === 'rule-ended')?.earned, false);

  const over = snapshotRule(facts([], { status: STATUS_EXPIRED, spent: 301n, cap: 300n }), now);
  assert.equal(ruleEndedInsideCap(over, now), false);
});

test('a shared plaque is the sentence and the rule address', () => {
  const rule = snapshotRule(facts([decision()]), START + 2n * DAY);
  const plaque = earnedPlaques(plaquesForRule(rule, START + 2n * DAY))[0];
  assert.ok(plaque);
  const text = plaqueShareText(plaque, rule.address);
  assert.match(text, /First payment inside the rule/);
  assert.match(text, new RegExp(rule.address));
});
