import assert from 'node:assert/strict';
import test from 'node:test';

import { REASON_NOT_ACTIVE, REASON_OVER_CAP, REASON_OVER_PER_TX_MAX, REASON_TEXT } from './constants';
import { notActiveHint, reasonText, renderReason } from './reasons';

test('reason text matches the indexer table', () => {
  assert.equal(reasonText(0), 'ok');
  assert.equal(reasonText(1), 'mandate not active');
  assert.equal(reasonText(2), 'past expiry');
  assert.equal(reasonText(3), 'nonce already settled');
  assert.equal(reasonText(4), 'merchant not allowed');
  assert.equal(reasonText(5), 'over per-payment maximum');
  assert.equal(reasonText(6), 'over remaining cap');
  assert.equal(reasonText(7), 'delegation withdrawn');
  assert.equal(reasonText(8), 'insufficient funds');
  assert.equal(reasonText(9), 'zero amount');
  assert.equal(reasonText(10), 'account frozen');
  assert.equal(reasonText(99), 'unknown');
  assert.equal(REASON_TEXT[REASON_OVER_PER_TX_MAX], 'over per-payment maximum');
});

test('a refusal shows the override that would have cleared it', () => {
  const view = renderReason(REASON_OVER_PER_TX_MAX, 519500n, 6);
  assert.equal(view.text, 'over per-payment maximum');
  assert.equal(view.overrideLine, 'An override of 0.5195 would have cleared it.');
});

test('a refusal with no override says so in plain language', () => {
  const view = renderReason(REASON_OVER_CAP, 0n, 6);
  assert.equal(view.text, 'over remaining cap');
  assert.equal(view.overrideLine, 'No override would have cleared this.');
});

test('reason 1 is the post-revoke refusal', () => {
  const hint = notActiveHint();
  assert.ok(hint.includes(String(REASON_NOT_ACTIVE)));
  assert.ok(hint.includes('mandate not active'));
});
