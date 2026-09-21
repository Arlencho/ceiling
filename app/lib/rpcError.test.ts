import assert from 'node:assert/strict';
import test from 'node:test';

import { isRateLimitError } from './rpcError';

test('a 429 from the RPC is a rate limit, not a generic failure', () => {
  assert.equal(isRateLimitError(new Error('Server responded with 429')), true);
  assert.equal(isRateLimitError(new Error('429 Too Many Requests')), true);
  const coded = new Error('fetch failed') as Error & { status: number };
  coded.status = 429;
  assert.equal(isRateLimitError(coded), true);
});

test('an ordinary read error is not a rate limit', () => {
  assert.equal(isRateLimitError(new Error('fetch failed')), false);
  assert.equal(isRateLimitError(new Error('mandate was not found on chain')), false);
  assert.equal(isRateLimitError(null), false);
});
