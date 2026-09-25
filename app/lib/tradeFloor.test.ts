import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Keypair } from '@solana/web3.js';
import type { ChainClient } from './chain';
import { floorFromSpot } from './tradePool';

mock.module('./chain', { namedExports: { confirmSignature() {}, decisionsForAddress() {}, rentExemptLamports() {} } });
const message = 'Floor percent must be a whole number from 1 to 99.';

for (const percent of [0, 100, 101, 1.5, NaN, Infinity]) {
  test(`the pool floor rejects ${percent} percent with the form's range message`, () => {
    assert.throws(() => floorFromSpot(200n, 100n, percent), { message });
  });
  test(`opening a trade rejects ${percent} percent before reading the pool or signing`, async () => {
    const { openTradeRule } = await import('./tradeChain');
    const client = { connection: { getAccountInfo() { throw new Error('Unexpected pool read'); } } } as unknown as ChainClient;
    await assert.rejects(openTradeRule(client, async () => { throw new Error('Unexpected signing'); }, {
      owner: Keypair.generate().publicKey, agent: Keypair.generate().publicKey,
      cluster: 'devnet', poolId: 'devnet-sol-usdc', cap: 100n, perTradeMax: 10n,
      dailyLimit: 20n, floorPercent: percent, expiresAt: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
      purpose: 'Trading',
    }), { message });
  });
}

test('the pool floor accepts both ends of the 1 to 99 percent range', () => {
  assert.deepEqual(floorFromSpot(200n, 100n, 1), { floorNum: 1n, floorDen: 50n });
  assert.deepEqual(floorFromSpot(200n, 100n, 99), { floorNum: 99n, floorDen: 50n });
});
