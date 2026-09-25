import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import type { TradeRuleAccount } from './tradeRule';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module('expo-router', { namedExports: { useRouter: () => ({ back() {} }) } });
mock.module('react-native', { namedExports: {
  Text: 'Text', View: 'View', StyleSheet: { create: (value: unknown) => value },
} });
for (const name of ['Screen', 'TopBar', 'ConnectGate', 'DecisionRow', 'EmptyState']) {
  mock.module(`../components/${name}`, { namedExports: { [name]: name } });
}
mock.module('../components/backglass/HoldToApprove', { namedExports: { HoldToApprove: 'HoldToApprove' } });
mock.module('./wallet', { namedExports: { truncateAddress: (value: string) => value } });
const selections: string[] = [];
let refreshes = 0;
let chain = {
  nowMs: 1700000000000, tradeRule: null, rows: [], loading: false, error: 'RPC read failed',
  selectMandate: async (address: string) => { selections.push(address); },
  refresh: async () => { refreshes += 1; },
};
mock.module('./useChain', { namedExports: { useChain: () => chain } });
const rule: TradeRuleAccount = {
  address: 'rule-a', agent: 'agent', pool: 'unknown', inMint: 'input', outMint: 'output',
  owner: 'owner', source: 'source', destination: 'destination', exchangeProgram: 'exchange',
  exchangeKind: 0, poolAuthority: 'authority', poolInVault: 'in-vault', poolOutVault: 'out-vault',
  poolMint: 'pool-mint', poolFeeAccount: 'fee-account', ruleId: 0n,
  purpose: 'Trading', cap: 100n, spent: 0n, dailyLimit: 10n, perTradeMax: 5n,
  dailyBuckets: Array.from({ length: 25 }, () => ({ hour: 0n, amount: 0n })),
  floorNum: 1n, floorDen: 1n, expiresAt: 1800000000n, status: 1,
  overrideAmount: 0n, overrideNonce: 0n, lastNonce: 0n, tradeCount: 0, refusalCount: 0, bump: 0,
};

test('a persistent RPC error does not reselect the same trade rule, while refresh and another address remain available', async () => {
  const { TradeRuleDetail } = await import('../components/TradeRuleDetail');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(TradeRuleDetail, { rule })); });
  try {
    for (const loading of [true, false, false]) {
      chain = { ...chain, loading };
      await act(async () => root.update(createElement(TradeRuleDetail, { rule })));
    }
    assert.deepEqual(selections, ['rule-a']);
    await act(async () => { root.root.findByType('Screen' as never).props.onRefresh(); });
    assert.equal(refreshes, 1);
    await act(async () => root.update(createElement(TradeRuleDetail, { rule: { ...rule, address: 'rule-b' } })));
    assert.deepEqual(selections, ['rule-a', 'rule-b']);
  } finally {
    await act(async () => root.unmount());
  }
});
