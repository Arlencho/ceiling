import assert from 'node:assert/strict';
import test from 'node:test';

import { KIND_ADVISORY_DECLINE } from './advisory';
import { KIND_OPENED, KIND_PAID, KIND_REFUSED, REASON_OVER_CAP, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE } from './constants';
import { addLocalDays, localDate, snapshotRule, type GradeDecision, type RuleFacts } from './grade';
import { VTEST_MINT } from './tokens';
import { weekFileText, weekReviewFor } from './weekReview';

function noon(year: number, month: number, day: number): bigint {
  return BigInt(Math.floor(new Date(year, month, day, 12, 0, 0).getTime() / 1000));
}

const OPEN = noon(2026, 8, 20);
const openDate = localDate(OPEN);
if (!openDate) {
  throw new Error('open date');
}

function atDay(offset: number): bigint {
  const date = addLocalDays(openDate!, offset);
  return noon(date.year, date.month, date.day);
}

function decision(over: Partial<GradeDecision> = {}): GradeDecision {
  return {
    kind: KIND_PAID,
    ts: atDay(0),
    amount: 8n,
    nonce: 1n,
    reason: 0,
    counterparty: 'payee',
    ...over,
  };
}

function facts(rows: GradeDecision[]): RuleFacts {
  return {
    address: 'RuleWeek1111111111111111111111111111111111',
    agent: 'AgentWeek111111111111111111111111111111111',
    purpose: 'Charging top-ups',
    cap: 300n,
    spent: 56n,
    perTxMax: 10n,
    expiresAt: OPEN + 90n * 86400n,
    status: STATUS_ACTIVE,
    decimals: 0,
    mint: VTEST_MINT,
    rows: [decision({ kind: KIND_OPENED, ts: OPEN, nonce: 0n, amount: 300n }), ...rows],
  };
}

test('a week is seven local days with paid and refused counts, and a quiet day stays quiet', () => {
  const rows = [
    decision({ ts: atDay(0), nonce: 1n, amount: 8n }),
    decision({ ts: atDay(1), nonce: 2n, amount: 8n }),
    decision({
      kind: KIND_REFUSED,
      ts: atDay(1),
      nonce: 3n,
      amount: 12n,
      reason: REASON_OVER_PER_TX_MAX,
    }),
    decision({
      kind: KIND_REFUSED,
      ts: atDay(1),
      nonce: 4n,
      amount: 16n,
      reason: REASON_OVER_PER_TX_MAX,
    }),
    decision({ kind: KIND_ADVISORY_DECLINE, ts: atDay(2), nonce: 5n, amount: 4n }),
  ];
  const review = weekReviewFor(snapshotRule(facts(rows), atDay(6)), 'Charging agent', atDay(6));
  assert.equal(review.days.length, 7);
  assert.equal(review.days[0]?.paid, 1);
  assert.equal(review.days[0]?.refused, 0);
  assert.equal(review.days[1]?.paid, 1);
  assert.equal(review.days[1]?.refused, 2);
  assert.equal(review.days[2]?.label, 'quiet');
  assert.equal(review.paidCount, 2);
  assert.equal(review.paidAmount, 16n);
  assert.equal(review.refusedCount, 2);
  assert.equal(review.weekIndex, 1);
  assert.equal(review.kicker, 'Charging agent, week 1 of 13');
  const limit = review.reasons.find((reason) => reason.reason === REASON_OVER_PER_TX_MAX);
  assert.ok(limit);
  assert.equal(limit.title, 'Asked more than 10 VTEST per payment');
  assert.match(limit.detail, /asked between 12 VTEST and 16 VTEST/);
  assert.match(limit.detail, /Limit stayed 10 VTEST/);
  const file = weekFileText(review);
  assert.match(file, /2 paid, 2 refused|1 paid, 2 refused/);
  assert.match(file, /0 moved/);
  assert.match(file, /Every line is read from the blockchain/);
});

test('refusals in a week are grouped by reason', () => {
  const rows = [
    decision({ kind: KIND_REFUSED, ts: atDay(0), nonce: 1n, amount: 40n, reason: REASON_OVER_CAP }),
    decision({ kind: KIND_REFUSED, ts: atDay(1), nonce: 2n, amount: 12n, reason: REASON_OVER_PER_TX_MAX }),
    decision({ kind: KIND_REFUSED, ts: atDay(1), nonce: 3n, amount: 12n, reason: REASON_OVER_PER_TX_MAX }),
  ];
  const review = weekReviewFor(snapshotRule(facts(rows), atDay(3)), 'Charging agent', atDay(3));
  assert.equal(review.reasons[0]?.count, 2);
  assert.equal(review.reasons[0]?.reason, REASON_OVER_PER_TX_MAX);
  assert.equal(review.reasons[1]?.reason, REASON_OVER_CAP);
  assert.equal(review.reasons[1]?.count, 1);
});
