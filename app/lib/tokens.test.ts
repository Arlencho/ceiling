import assert from 'node:assert/strict';
import test from 'node:test';

import { truncateAddress } from './wallet';
import {
  DEVNET_USDC_MINT,
  MAINNET_USDC_MINT,
  SECOND_DEVNET_MINT,
  SKR_MINT,
  VTEST_DEVNET_NOTE,
  VTEST_MINT,
  devnetTestTokenNote,
  formatTokenAmount,
  knownToken,
  rulesTokenSummary,
  tokenName,
  tokenSymbol,
  withToken,
} from './tokens';

test('known mints use their symbol and name, and nothing else is invented', () => {
  assert.equal(tokenSymbol(VTEST_MINT), 'VTEST');
  assert.equal(tokenName(VTEST_MINT), 'Veto test token');
  assert.equal(knownToken(VTEST_MINT)?.name, 'Veto test token');
  assert.equal(tokenSymbol(DEVNET_USDC_MINT), 'USDC');
  assert.equal(tokenSymbol(MAINNET_USDC_MINT), 'USDC');
  assert.equal(tokenSymbol(SKR_MINT), 'SKR');
  assert.equal(tokenName(SKR_MINT), 'SKR');
});

test('the second devnet mint has no symbol in this repo, so the name is the shortened address', () => {
  assert.equal(knownToken(SECOND_DEVNET_MINT), null);
  assert.equal(tokenName(SECOND_DEVNET_MINT), null);
  assert.equal(tokenSymbol(SECOND_DEVNET_MINT), truncateAddress(SECOND_DEVNET_MINT));
  assert.equal(tokenSymbol(SECOND_DEVNET_MINT), 'Dcbb...K3Kq');
  assert.notEqual(tokenSymbol(SECOND_DEVNET_MINT), 'VTEST');
  assert.notEqual(tokenSymbol(SECOND_DEVNET_MINT), 'SKR');
  assert.notEqual(tokenSymbol(SECOND_DEVNET_MINT), 'USDC');
});

test('an unknown mint is the shortened address, and a missing mint is not a guessed ticker', () => {
  const mint = 'Mint1111111111111111111111111111111111111111';
  assert.equal(tokenSymbol(mint), 'Mint...1111');
  assert.equal(tokenName(mint), null);
  assert.equal(tokenSymbol(''), '');
  assert.equal(tokenSymbol(null), '');
  assert.equal(withToken('16.66', null), '16.66');
  assert.equal(withToken('16.66', VTEST_MINT), '16.66 VTEST');
  assert.equal(withToken('16.66 VTEST', VTEST_MINT), '16.66 VTEST');
  assert.equal(formatTokenAmount(16_660_000n, 6, VTEST_MINT), '16.66 VTEST');
});

test('the devnet test line is only for VTEST on devnet', () => {
  assert.equal(devnetTestTokenNote(VTEST_MINT, 'devnet'), VTEST_DEVNET_NOTE);
  assert.equal(VTEST_DEVNET_NOTE, 'VTEST is a devnet test token with no value.');
  assert.equal(devnetTestTokenNote(VTEST_MINT, 'mainnet-beta'), null);
  assert.equal(devnetTestTokenNote(VTEST_MINT, 'testnet'), null);
  assert.equal(devnetTestTokenNote(DEVNET_USDC_MINT, 'devnet'), null);
  assert.equal(devnetTestTokenNote(SECOND_DEVNET_MINT, 'devnet'), null);
  assert.equal(devnetTestTokenNote(null, 'devnet'), null);
});

test('a rules header groups by token and does not add different tokens together', () => {
  assert.equal(rulesTokenSummary([]), null);
  assert.equal(rulesTokenSummary([VTEST_MINT]), 'This rule uses VTEST.');
  assert.equal(rulesTokenSummary([VTEST_MINT, VTEST_MINT, VTEST_MINT]), 'All 3 rules use VTEST.');
  assert.equal(
    rulesTokenSummary([VTEST_MINT, VTEST_MINT, DEVNET_USDC_MINT]),
    '2 rules in VTEST. 1 rule in USDC.',
  );
  assert.equal(rulesTokenSummary([SECOND_DEVNET_MINT, SKR_MINT]), '1 rule in Dcbb...K3Kq. 1 rule in SKR.');
});
