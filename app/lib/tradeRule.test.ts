import assert from 'node:assert/strict';
import test from 'node:test';
import { TRADE_RULE_ACCOUNT_SIZE, TRADE_RULE_DISCRIMINATOR } from './constants';
import { decodeTradeRuleAccount, inputSentToday } from './tradeRule';

test('trade decoding reads every hourly bucket and the following rule fields', () => {
  const raw = Buffer.alloc(TRADE_RULE_ACCOUNT_SIZE);
  raw.set(TRADE_RULE_DISCRIMINATOR);
  // 13 public keys, one exchange kind, and five limit u64s precede the ring.
  let offset = 8 + 13 * 32 + 1 + 5 * 8;
  const dailyBuckets = Array.from({ length: 25 }, (_, i) => ({
    hour: BigInt(100 + i), amount: BigInt(i + 1),
  }));
  for (const bucket of dailyBuckets) {
    raw.writeBigInt64LE(bucket.hour, offset);
    raw.writeBigUInt64LE(bucket.amount, offset + 8);
    offset += 16;
  }
  raw.writeBigUInt64LE(7n, offset);
  raw.writeBigUInt64LE(9n, offset + 8);
  raw.writeBigInt64LE(2_000_000_000n, offset + 16);
  raw.writeBigUInt64LE(42n, offset + 40);
  offset += 48;
  raw.writeUInt32LE(4, offset);
  raw.write('test', offset + 4);
  raw[offset + 8] = 2;
  raw.writeUInt32LE(17, offset + 9);
  raw.writeUInt32LE(3, offset + 13);
  raw[offset + 17] = 254;
  const rule = decodeTradeRuleAccount('fixture', raw);
  assert.deepEqual(rule.dailyBuckets, dailyBuckets);
  assert.equal(rule.floorNum, 7n);
  assert.equal(rule.floorDen, 9n);
  assert.equal(rule.expiresAt, 2_000_000_000n);
  assert.equal(rule.lastNonce, 42n);
  assert.equal(rule.purpose, 'test');
  assert.equal(rule.status, 2);
  assert.equal(rule.tradeCount, 17);
  assert.equal(rule.refusalCount, 3);
  assert.equal(rule.bump, 254);
  assert.equal(TRADE_RULE_ACCOUNT_SIZE, 991);
});

test('daily allowance retains the oldest partial hour until the 25th boundary', () => {
  const rule = { dailyBuckets: [{ hour: 100n, amount: 50n }] };
  assert.equal(inputSentToday(rule, 124n * 3600n + 3599n), 50n);
  assert.equal(inputSentToday(rule, 125n * 3600n), 0n);
  assert.equal(inputSentToday(rule, 99n * 3600n), 50n);
  assert.equal(inputSentToday({ dailyBuckets: [{ hour: -25n, amount: 7n }] }, -1n), 7n);
});
