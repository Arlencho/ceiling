import assert from 'node:assert/strict';
import test from 'node:test';
process.env.TZ = 'Europe/Stockholm';
import { formatUnix, isLocalDay } from './format';

test('a decision listed under Today carries the same calendar date it is filed under', () => {
  const localHalfPastMidnight = new Date(2026, 8, 20, 0, 30, 0);
  const ts = BigInt(Math.floor(localHalfPastMidnight.getTime() / 1000));
  const nowMs = new Date(2026, 8, 20, 12, 0, 0).getTime();
  assert.equal(isLocalDay(ts, nowMs), true, 'precondition: it is filed under today');
  assert.ok(formatUnix(ts).startsWith('2026-09-20'), `rendered as ${formatUnix(ts)} but filed under 2026-09-20`);
});
