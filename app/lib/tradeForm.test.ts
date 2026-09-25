import assert from 'node:assert/strict';
import test from 'node:test';

import { Keypair } from '@solana/web3.js';

import { POOL_FEE_LINE, SOL_FOR_USDC, poolsForCluster } from './pools';
import { floorPhrase, validateTradeForm } from './tradeForm';

const POOLS = ['devnet-sol-usdc'];

function input(over: Partial<Parameters<typeof validateTradeForm>[0]> = {}) {
  return {
    agent: '',
    owner: 'Owner11111111111111111111111111111111111111',
    poolId: 'devnet-sol-usdc',
    poolIds: POOLS,
    perTrade: '0.01',
    perDay: '0.05',
    total: '0.20',
    floorPercent: '90',
    days: '7',
    purpose: 'trading bot',
    decimals: 9,
    ...over,
  };
}

test('the devnet list is SOL for USDC and states the exchange fee', () => {
  const pools = poolsForCluster('devnet');
  assert.equal(pools.length, 1);
  assert.equal(pools[0]?.pair, SOL_FOR_USDC);
  assert.equal(pools[0]?.pair, 'wrapped SOL for USDC');
  assert.equal(pools[0]?.inputSymbol, 'wrapped SOL');
  assert.equal(pools[0]?.outputSymbol, 'USDC');
  assert.equal(pools[0]?.feeLine, POOL_FEE_LINE);
  assert.equal(poolsForCluster('mainnet-beta').length, 0);
});

test('a pool that is not on the list is rejected', () => {
  const result = validateTradeForm(input({ poolId: 'typed by hand' }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'Pick a pool from the list.');
  }
});

test('most per trade above the daily limit is rejected', () => {
  const result = validateTradeForm(input({ perTrade: '0.08', perDay: '0.05' }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'Most per trade is above the daily limit.');
  }
});

test('the daily limit above the total set aside is rejected', () => {
  const result = validateTradeForm(input({ perDay: '0.30', total: '0.20' }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'The daily limit is above the total set aside.');
  }
});

test('an empty purpose is rejected', () => {
  const result = validateTradeForm(input({ purpose: '   ' }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'Enter a purpose.');
  }
});

test('the owner cannot be the agent', () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const result = validateTradeForm(input({ agent: owner, owner }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'The agent address is the owner. Pick the agent address.');
  }
});

test('a complete trade form keeps the floor at 90 and the amounts in base units', () => {
  const result = validateTradeForm(input());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.floorPercent, 90);
    assert.equal(result.value.perTradeMax, 10_000_000n);
    assert.equal(result.value.dailyLimit, 50_000_000n);
    assert.equal(result.value.cap, 200_000_000n);
    assert.equal(result.value.days, 7);
    assert.equal(result.value.poolId, 'devnet-sol-usdc');
    assert.equal(result.value.agent, null);
  }
});

test('a 100 percent floor is rejected and 99 percent is accepted', () => {
  assert.deepEqual(validateTradeForm(input({ floorPercent: '100' })), {
    ok: false, message: 'Floor percent must be a whole number from 1 to 99.',
  });
  assert.equal(validateTradeForm(input({ floorPercent: '99' })).ok, true);
});

test('the floor hint explains that the exchange fee comes off first', () => {
  assert.equal(floorPhrase(99), "at least 99 percent of today's rate. The exchange fee (0.30 percent) comes off first.");
});
