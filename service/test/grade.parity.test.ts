import assert from 'node:assert/strict';
import test from 'node:test';
import { grade } from '../src/grade.js';

// Load the repository's actual app implementation at test time. Production
// service modules never import app code.
const appPath = new URL('../../app/lib/grade.ts', import.meta.url).href;
const { gradeRules } = await import(appPath);
const start = 1_700_000_000n;
const now = start + 2n * 86400n;
const decision = (kind: number, nonce: number, ts = start) => ({
  kind, nonce: BigInt(nonce), ts, amount: 1n, reason: 0, counterparty: 'merchant',
});
function comparable(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, typeof v === 'bigint' ? Number(v) : v]));
}
for (const requests of [9, 10, 19, 20, 21, 40]) {
  for (const outside of [0, 1, 2, 4, 5, 8, 9]) {
    for (const allowances of [0, 1, 2]) {
      if (outside > requests || allowances > outside) continue;
      const rows = [decision(0, 999),
        ...Array.from({ length: requests - outside }, (_, i) => decision(1, 100 + i)),
        ...Array.from({ length: outside }, (_, i) => decision(2, i)),
        ...Array.from({ length: allowances }, (_, i) => decision(3, i)),
        ...Array.from({ length: allowances }, (_, i) => decision(1, i)),
        decision(100, 800)];
      test(`grade parity: ${requests} requests, ${outside} outside, ${allowances} allowances`, () => {
        assert.deepEqual(comparable(grade({ paid: BigInt(requests - outside), outside: BigInt(outside),
          allowances: BigInt(allowances), declines: 1n, firstOpenTs: start, firstTs: start }, now)),
        gradeRules([{ rows }], now));
      });
    }
  }
}
for (const opened of [true, false]) {
  for (const elapsed of [-1n, 0n, 86400n, 172799n, 172800n, 259200n]) {
    test(`grade parity: opened=${opened}, elapsed=${elapsed}`, () => {
      const rows = [...(opened ? [decision(0, 99)] : []), ...Array.from({ length: 10 }, (_, i) => decision(1, i))];
      assert.deepEqual(comparable(grade({ paid: 10n, outside: 0n, allowances: 0n, declines: 0n,
        firstOpenTs: opened ? start : null, firstTs: start }, start + elapsed)), gradeRules([{ rows }], start + elapsed));
    });
  }
}
test('grade parity: empty history', () => {
  assert.deepEqual(comparable(grade({ paid: 0n, outside: 0n, allowances: 0n, declines: 0n,
    firstOpenTs: null, firstTs: null }, now)), gradeRules([], now));
});
test('grade parity: allowances missing a refusal and nonce scope across rules', () => {
  const rules = [
    { rows: [decision(0, 99), decision(3, 1), decision(1, 1), decision(3, 2), decision(100, 3)] },
    { rows: Array.from({ length: 10 }, (_, i) => decision(1, i)) },
  ];
  assert.deepEqual(comparable(grade({ paid: 10n, outside: 2n, allowances: 2n, declines: 1n,
    firstOpenTs: start, firstTs: start }, now)), gradeRules(rules, now));
});
test('grade uses exact integer thresholds above the safe number range', () => {
  const requests = 10n ** 20n;
  const result = grade({ paid: requests - requests / 20n + 1n, outside: requests / 20n - 1n,
    allowances: 0n, declines: 0n, firstOpenTs: start, firstTs: start }, now);
  assert.equal(result.band, 'stayed');
});
