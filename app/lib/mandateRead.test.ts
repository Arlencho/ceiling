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
