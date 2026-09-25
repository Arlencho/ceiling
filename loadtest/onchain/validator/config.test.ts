import assert from 'node:assert/strict';
import test from 'node:test';
import { config, percentile } from './config.js';

test('remote and disguised remote endpoints are refused', () => {
  for (const url of ['https://api.devnet.solana.com', 'http://localhost.evil:8899', 'http://localhost@evil:8899', 'file:///localhost', 'http://127.0.0.2:8899', 'http://localhost:8899/proxy']) {
    assert.throws(() => config({ VETO_RPC: url }, false));
  }
});
test('smoke fixes ten rules and ten seconds while defaults use 200 rules across 50 agents', () => {
  assert.deepEqual([config({}, false).n, config({}, false).a, config({}, false).w], [200, 50, 16]);
  const smoke = config({ N: '300', DURATION_SECONDS: '60' }, true);
  assert.deepEqual([smoke.n, smoke.duration], [10, 10]);
});
test('invalid counts fail before starting a validator', () => {
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity']) assert.throws(() => config({ W: value }, false));
});
test('latency percentiles use nearest rank and empty samples have no latency', () => {
  assert.equal(percentile([30, 10, 20], 0.5), 20);
  assert.equal(percentile([30, 10, 20], 0.99), 30);
  assert.equal(percentile([], 0.5), null);
});
