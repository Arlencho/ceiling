import assert from 'node:assert/strict';
import test from 'node:test';

import { describeAgentRead } from './agentRead';

const base = {
  configError: null,
  chainError: null,
  loadError: null,
  ready: true,
  nowMs: 1_500_000,
  mandateCount: 0,
  historiesReady: false,
} as const;

test('a rate-limited agent read stays in progress and does not call the list empty', () => {
  const out = describeAgentRead({
    ...base,
    mandateStatus: 'rate-limited',
    chainError: 'The RPC refused this read.',
  });
  assert.equal(out.status, 'loading');
  assert.equal(out.error, null);
  assert.equal(out.notice, 'The blockchain is busy right now. Veto keeps trying.');
  assert.equal(out.notice?.includes('RPC'), false);
});

test('a failed agent read is not an empty agent list', () => {
  const out = describeAgentRead({ ...base, mandateStatus: 'failed' });
  assert.equal(out.status, 'error');
  assert.equal(out.notice, 'Could not reach the blockchain. Pull down to try again.');
  assert.equal(out.notice?.includes('RPC'), false);
});

test('a history read that throws does not keep the transport text', () => {
  const out = describeAgentRead({
    ...base,
    mandateStatus: 'present',
    mandateCount: 1,
    loadError: '429 The RPC rate limited this read',
  });
  assert.equal(out.status, 'error');
  assert.equal(out.error?.includes('RPC'), false);
  assert.equal(out.notice, 'Could not reach the blockchain. Pull down to try again.');
});

test('a successful empty read may say there is no agent, and a finished read is ready', () => {
  const empty = describeAgentRead({ ...base, mandateStatus: 'empty' });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.notice, null);

  const ready = describeAgentRead({
    ...base,
    mandateStatus: 'present',
    mandateCount: 1,
    historiesReady: true,
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.notice, null);
  assert.equal(ready.error, null);
});
