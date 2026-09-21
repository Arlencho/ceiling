import assert from 'node:assert/strict';
import test from 'node:test';

import { mandateAbsenceCopy, mandateReadStatus } from './mandateRead';

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
  assert.equal(
    copy,
    'The chain read failed. Pull to retry. This screen does not assume there is no mandate.',
  );
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
  assert.equal(
    copy,
    'The RPC is rate limiting this read. Still trying. This is not a stalled fetch.',
  );
  assert.equal(copy?.includes('Reading the chain'), false);
  assert.equal(copy?.toLowerCase().includes('stalled'), true);
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
