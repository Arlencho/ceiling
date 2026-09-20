import assert from 'node:assert/strict';
import test from 'node:test';

import { KIND_OPENED, KIND_PAID, KIND_REFUSED } from './constants';
import {
  formatBaseUnits,
  formatTimeLeft,
  isLocalDay,
  parseBaseUnits,
  remainingCap,
  todaysAgentDecisions,
} from './format';
import type { RingEntry } from './ring';

test('parse and format base units without floats', () => {
  assert.equal(parseBaseUnits('100', 6), 100_000_000n);
  assert.equal(parseBaseUnits('0.5', 6), 500_000n);
  assert.equal(formatBaseUnits(500_000n, 6), '0.5');
  assert.equal(formatBaseUnits(100_000_000n, 6), '100');
  assert.equal(remainingCap(100n, 40n), 60n);
  assert.equal(remainingCap(10n, 40n), 0n);
});

test('formatTimeLeft names remaining time or expired', () => {
  assert.equal(formatTimeLeft(100n, 100n), 'expired');
  assert.equal(formatTimeLeft(100n + 86400n * 2n + 3600n, 100n), '2d 1h left');
  assert.equal(formatTimeLeft(100n + 3600n + 60n, 100n), '1h 1m left');
});

test('today lists paid and refused newest first and skips other kinds', () => {
  const noon = new Date(2026, 8, 20, 12, 0, 0);
  const prior = new Date(2026, 8, 19, 12, 0, 0);
  const ts = BigInt(Math.floor(noon.getTime() / 1000));
  const yesterday = BigInt(Math.floor(prior.getTime() / 1000));
  const peer = '11111111111111111111111111111111';
  const entry = (kind: number, nonce: bigint, time: bigint): RingEntry => ({
    ts: time,
    amount: 1n,
    counterparty: peer,
    nonce,
    suggestedOverride: 0n,
    kind,
    kindName: String(kind),
    reason: 0,
    reasonText: 'ok',
  });
  const rows = todaysAgentDecisions(
    [
      entry(KIND_OPENED, 0n, ts),
      entry(KIND_PAID, 1n, ts),
      entry(KIND_REFUSED, 2n, ts),
      entry(KIND_PAID, 3n, yesterday),
    ],
    noon.getTime(),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.nonce, 2n);
  assert.equal(rows[1]?.nonce, 1n);
  assert.equal(isLocalDay(yesterday, noon.getTime()), false);
});

test('today keeps signatures already on the rows', () => {
  const noon = new Date(2026, 8, 20, 12, 0, 0);
  const ts = BigInt(Math.floor(noon.getTime() / 1000));
  const peer = '11111111111111111111111111111111';
  const row = (nonce: bigint, signature: string) => ({
    ts,
    amount: 1n,
    counterparty: peer,
    nonce,
    suggestedOverride: 0n,
    kind: KIND_REFUSED,
    kindName: 'refused',
    reason: 1,
    reasonText: 'mandate not active',
    signature,
  });
  const rows = todaysAgentDecisions([row(1n, 'sig-one'), row(1n, 'sig-two')], noon.getTime());
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.signature, 'sig-two');
  assert.equal(rows[1]?.signature, 'sig-one');
});
