import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mandateAbsenceCopy,
  mandateReadStatus,
  mayClaimAbsence,
  readFace,
  rulePillLabel,
  RATE_LIMIT_GAVE_UP,
  RATE_LIMIT_RETRY_MS,
} from './mandateRead';

test('mandate read is not-read until the chain has been checked for this owner', () => {
  assert.equal(
    mandateReadStatus({
      checkedOwner: null,
      ownerPublicKey: 'Owner111',
      loading: false,
      error: null,
      hasMandate: false,
    }),
    'not-read',
  );
  assert.equal(
    mandateReadStatus({
      checkedOwner: null,
      ownerPublicKey: 'Owner111',
      loading: true,
      error: null,
      hasMandate: false,
    }),
    'not-read',
  );
  assert.equal(
    mandateAbsenceCopy('not-read', 'No mandate on chain for this owner yet. Open one on the Mandate tab.'),
    'Reading the chain for this owner.',
  );
});

test('a failed chain read is not an absence and does not invite opening a mandate', () => {
  assert.equal(
    mandateReadStatus({
      checkedOwner: 'Owner111',
      ownerPublicKey: 'Owner111',
      loading: false,
      error: 'fetch failed',
      hasMandate: false,
    }),
    'failed',
  );
  const copy = mandateAbsenceCopy(
    'failed',
    'No mandate on chain for this owner yet. Open one on the Mandate tab.',
  );
  assert.equal(copy, 'Could not reach the blockchain. Pull down to try again.');
  assert.equal(copy?.includes('Open one'), false);
});

test('only a completed successful read with no mandate is empty', () => {
  assert.equal(
    mandateReadStatus({
      checkedOwner: 'Owner111',
      ownerPublicKey: 'Owner111',
      loading: false,
      error: null,
      hasMandate: false,
    }),
    'empty',
  );
  assert.equal(
    mandateAbsenceCopy(
      'empty',
      'No mandate on chain for this owner yet. Open one on the Mandate tab.',
    ),
    'No mandate on chain for this owner yet. Open one on the Mandate tab.',
  );
});

test('a mandate already on chain stays present during a later refresh', () => {
  assert.equal(
    mandateReadStatus({
      checkedOwner: 'Owner111',
      ownerPublicKey: 'Owner111',
      loading: true,
      error: null,
      hasMandate: true,
    }),
    'present',
  );
  assert.equal(mandateAbsenceCopy('present', 'unused'), null);
});

test('a rate-limited read says the blockchain is busy and does not say RPC', () => {
  const copy = mandateAbsenceCopy('rate-limited', 'No rule on chain for this owner yet.');
  assert.equal(copy, 'The blockchain is busy right now. Veto keeps trying.');
  assert.equal(copy?.includes('RPC'), false);
  assert.equal(copy?.includes('Reading the chain'), false);
});

test('a failed read says to pull down and does not claim the rule is absent', () => {
  const copy = mandateAbsenceCopy('failed', 'No rule on chain for this owner yet.');
  assert.equal(copy, 'Could not reach the blockchain. Pull down to try again.');
  assert.equal(copy?.includes('RPC'), false);
  assert.equal(copy?.includes('no rule'), false);
  assert.equal(copy?.includes('No mandate'), false);
});

test('a rate-limited read is its own state and does not look like a stalled fetch', () => {
  assert.equal(
    mandateReadStatus({
      checkedOwner: 'Owner111',
      ownerPublicKey: 'Owner111',
      loading: true,
      error: null,
      hasMandate: false,
      rateLimited: true,
    }),
    'rate-limited',
  );
  const copy = mandateAbsenceCopy('rate-limited', 'No rule on chain for this owner yet.');
  assert.equal(copy, 'The blockchain is busy right now. Veto keeps trying.');
  assert.equal(copy?.includes('Reading the chain'), false);
  assert.equal(copy?.toLowerCase().includes('stalled'), false);
  assert.equal(copy?.includes('RPC'), false);
});

test('a rate-limited read is not an absence and does not invite opening a rule', () => {
  assert.equal(
    mandateReadStatus({
      checkedOwner: 'Owner111',
      ownerPublicKey: 'Owner111',
      loading: false,
      error: 'Server responded with 429',
      hasMandate: false,
      rateLimited: true,
    }),
    'rate-limited',
  );
  const copy = mandateAbsenceCopy(
    'rate-limited',
    'No rule on chain for this owner yet. Open one on the Rules tab.',
  );
  assert.equal(copy?.includes('Open one'), false);
  assert.equal(copy?.includes('no rule'), false);
});

test('a mandate already on chain stays present while a later read is rate limited', () => {
  assert.equal(
    mandateReadStatus({
      checkedOwner: 'Owner111',
      ownerPublicKey: 'Owner111',
      loading: true,
      error: null,
      hasMandate: true,
      rateLimited: true,
    }),
    'present',
  );
});

test('after three rate-limit retries the read is a failure the owner can retry', () => {
  assert.equal(RATE_LIMIT_RETRY_MS.length, 3);
  assert.equal(RATE_LIMIT_GAVE_UP.includes('Still trying'), false);
  assert.equal(RATE_LIMIT_GAVE_UP.includes('RPC'), false);
  assert.equal(RATE_LIMIT_GAVE_UP.includes('Pull down'), true);
  const status = mandateReadStatus({
    checkedOwner: 'Owner111',
    ownerPublicKey: 'Owner111',
    loading: false,
    error: RATE_LIMIT_GAVE_UP,
    hasMandate: false,
    rateLimited: false,
  });
  assert.equal(status, 'failed');
  const copy = mandateAbsenceCopy(status, 'No rule on chain for this owner yet.');
  assert.equal(copy?.includes('Still trying'), false);
  assert.equal(copy?.includes('Pull down'), true);
  assert.equal(copy?.includes('no rule'), false);
});

test('the pill waits for a successful read before it says whether a rule is live', () => {
  assert.equal(rulePillLabel(readFace('rate-limited'), 0), 'Reading...');
  assert.equal(rulePillLabel(readFace('not-read'), 0), 'Reading...');
  assert.equal(rulePillLabel(readFace('failed'), 0), 'Could not read');
  assert.equal(rulePillLabel(readFace('empty'), 0), 'No rule live');
  assert.equal(rulePillLabel(readFace('present'), 1), '1 rule live');
  assert.equal(rulePillLabel(readFace('present'), 2), '2 rules live');
  assert.equal(rulePillLabel(readFace('failed'), 0).toLowerCase().includes('no rule'), false);
});

test('only a completed read may claim a rule or decision is absent', () => {
  assert.equal(mayClaimAbsence('not-read'), false);
  assert.equal(mayClaimAbsence('failed'), false);
  assert.equal(mayClaimAbsence('rate-limited'), false);
  assert.equal(mayClaimAbsence('empty'), true);
  assert.equal(mayClaimAbsence('present'), true);
});
