import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_USDC_MINT, MAINNET_USDC_MINT, VTEST_MINT } from './tokens';
import {
  CIRCLE_DEVNET_FAUCET_URL,
  FAUCET_PASTE_LINE,
  GET_DEVNET_USDC_LABEL,
  showDevnetUsdcFaucet,
} from './faucet';

const short = { balance: 1n, needed: 5_000_000n, balanceKnown: true };

test('the faucet is offered when devnet USDC is short of what the form asks', () => {
  assert.equal(
    showDevnetUsdcFaucet({ cluster: 'devnet', mint: DEVNET_USDC_MINT, shortfall: short }),
    true,
  );
});

test('the faucet stays hidden on mainnet even when that same mint is short', () => {
  assert.equal(
    showDevnetUsdcFaucet({ cluster: 'mainnet-beta', mint: DEVNET_USDC_MINT, shortfall: short }),
    false,
  );
  assert.equal(
    showDevnetUsdcFaucet({ cluster: 'mainnet-beta', mint: MAINNET_USDC_MINT, shortfall: short }),
    false,
  );
});

test('the faucet stays hidden for another mint on devnet', () => {
  assert.equal(
    showDevnetUsdcFaucet({ cluster: 'devnet', mint: VTEST_MINT, shortfall: short }),
    false,
  );
  assert.equal(
    showDevnetUsdcFaucet({ cluster: 'devnet', mint: MAINNET_USDC_MINT, shortfall: short }),
    false,
  );
  assert.equal(showDevnetUsdcFaucet({ cluster: 'testnet', mint: DEVNET_USDC_MINT, shortfall: short }), false);
});

test('the faucet stays hidden when the devnet USDC balance covers what the form asks', () => {
  assert.equal(
    showDevnetUsdcFaucet({
      cluster: 'devnet',
      mint: DEVNET_USDC_MINT,
      shortfall: { balance: 5_000_000n, needed: 5_000_000n, balanceKnown: true },
    }),
    false,
  );
  assert.equal(
    showDevnetUsdcFaucet({
      cluster: 'devnet',
      mint: DEVNET_USDC_MINT,
      shortfall: { balance: null, needed: 5_000_000n, balanceKnown: false },
    }),
    false,
  );
});

test('the empty state offers the faucet only for devnet USDC, with no amount promised', () => {
  assert.equal(showDevnetUsdcFaucet({ cluster: 'devnet', mint: DEVNET_USDC_MINT }), true);
  assert.equal(showDevnetUsdcFaucet({ cluster: 'devnet', mint: VTEST_MINT }), false);
  assert.equal(showDevnetUsdcFaucet({ cluster: 'mainnet-beta', mint: DEVNET_USDC_MINT }), false);
  assert.equal(CIRCLE_DEVNET_FAUCET_URL, 'https://faucet.circle.com');
  assert.equal(GET_DEVNET_USDC_LABEL, 'Get devnet USDC');
  assert.equal(
    FAUCET_PASTE_LINE,
    'Paste this address into the faucet. It sends devnet USDC, which has no value.',
  );
});
