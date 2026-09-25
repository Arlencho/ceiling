import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createElement, act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Keypair } from '@solana/web3.js';
import type { HoldVaultBundle } from './holdChain';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const key = Keypair.generate().publicKey;
const pending = [{ id: 2n, amount: 20n, destination: key, unlockAt: 1700000000n, status: 1 }];
let params: { vault: string; id?: string } = { vault: key.toBase58() };
const bundle = { account: { pending, guardian: key, owner: key, safeAddress: key, change: { active: false } }, balance: 100n, decimals: 0, ledger: { total: 0, entries: [] } } as unknown as HoldVaultBundle;
const fresh = { ...bundle, balance: 0n, ledger: { ...bundle.ledger, total: 1, entries: [{ kind: 8, amount: 125n, destination: key }] } };
let stopped: bigint | null | undefined;
let reloaded = false;
let pushed: string | null = null;
mock.module('expo-router', { namedExports: { useRouter: () => ({ back() {}, push(href: string) { pushed = href; } }), useLocalSearchParams: () => params } });
mock.module('react-native', { namedExports: { Linking: { openURL() {} } } });
mock.module('../components/Screen', { namedExports: { Screen: 'Screen' } });
mock.module('../components/ConnectGate', { namedExports: { ConnectGate: 'ConnectGate' } });
mock.module('../components/hold/GuardScreen', { namedExports: { GuardScreen: 'GuardScreen' } });
mock.module('./holdSession', { namedExports: { useHoldBundle: () => ({ bundle, owner: key, client: { config: { explorerCluster: 'devnet' } }, status: 'ready', tokenName: 'USDC', wallet: { signAndSend() {} }, reload: async () => { reloaded = true; return fresh; } }) } });
mock.module('./holdGuard', { namedExports: {
  changeLoosenLines: () => [],
  guardBrake: async (args: { withdrawalId?: bigint | null }) => { stopped = args.withdrawalId; return 'signature'; },
  guardPath: (vault: string, withdrawalId?: string | null) => {
    const base = `/hold/guard?vault=${vault}`;
    return withdrawalId ? `${base}&id=${withdrawalId}` : base;
  },
  guardResultLine: (args: { amountLabel: string; tokenName: string }) => `${args.amountLabel} ${args.tokenName}`,
} });

async function mount() {
  const { default: Route } = await import('../app/hold/guard');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(Route)); });
  const screen = () => root.root.findByType('GuardScreen' as never);
  return { root, screen };
}

test('a stale notification never arms Stop for another withdrawal', async () => {
  params = { vault: key.toBase58(), id: '1' };
  const { screen } = await mount();
  assert.equal(screen().props.waiting, null);
  assert.equal(screen().props.missingWithdrawal, true);
  await assert.rejects(screen().props.onStop(), /no longer waiting/);
});

test('a stale notification lists the pending withdrawals and picking one opens it by id', async () => {
  params = { vault: key.toBase58(), id: '1' };
  pushed = null;
  const { screen } = await mount();
  assert.equal(screen().props.moreWaiting, 1);
  assert.equal(screen().props.waitingOthers.length, 1);
  assert.equal(screen().props.waitingOthers[0].id, '2');
  assert.equal(screen().props.waitingOthers[0].amountLabel, '20');
  screen().props.onPick('2');
  assert.equal(pushed, `/hold/guard?vault=${key.toBase58()}&id=2`);
});

test('opening the vault without a notification id selects the first pending withdrawal', async () => {
  params = { vault: key.toBase58() };
  const { screen } = await mount();
  assert.equal(screen().props.waiting.amountLabel, '20');
  await act(async () => { await screen().props.onStop(); });
  assert.equal(stopped, 2n);
});

test('recover shows the amount recorded after reload instead of the old balance', async () => {
  params = { vault: key.toBase58() }; reloaded = false;
  const { screen } = await mount();
  await act(async () => { await screen().props.onRecover(); });
  assert.equal(reloaded, true);
  assert.equal(screen().props.result.line, '125 USDC');
  assert.equal(screen().props.hasMoney, true);
});
