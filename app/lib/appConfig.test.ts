import assert from 'node:assert/strict';
import test from 'node:test';

import { configFromExtra, walletChainForCluster } from './appConfig';

test('configFromExtra requires RPC and program id from config', () => {
  assert.throws(
    () => configFromExtra({ vetoProgramId: 'Pid11111111111111111111111111111111111111111' }, {}),
    /RPC url is missing/,
  );
  assert.throws(
    () => configFromExtra({ vetoRpc: 'http://127.0.0.1:8999' }, {}),
    /Program id is missing/,
  );
});

test('configFromExtra does not invent an RPC url', () => {
  const cfg = configFromExtra(
    {
      vetoRpc: 'http://example.invalid:8999',
      vetoProgramId: 'Pid11111111111111111111111111111111111111111',
    },
    {},
  );
  assert.equal(cfg.rpcUrl, 'http://example.invalid:8999');
  assert.equal(cfg.programId, 'Pid11111111111111111111111111111111111111111');
});

test('an unknown cluster is refused instead of a devnet wallet chain', () => {
  assert.throws(
    () =>
      configFromExtra(
        {
          vetoRpc: 'http://127.0.0.1:8899',
          vetoProgramId: 'Pid11111111111111111111111111111111111111111',
          vetoExplorerCluster: 'localnet',
        },
        {},
      ),
    /Unknown cluster "localnet"/,
  );
  assert.throws(() => walletChainForCluster('mainnet'), /Unknown cluster "mainnet"/);
});

for (const [cluster, chain] of [
  ['mainnet-beta', 'solana:mainnet'],
  ['devnet', 'solana:devnet'],
  ['testnet', 'solana:testnet'],
]) {
  test(`${cluster} uses the wallet chain ${chain}`, () => {
    assert.equal(walletChainForCluster(cluster), chain);
  });
}

test('env fills extra when extra is empty', () => {
  const cfg = configFromExtra(
    {},
    {
      EXPO_PUBLIC_VETO_RPC: 'http://127.0.0.1:8999',
      EXPO_PUBLIC_VETO_PROGRAM_ID: 'Pid11111111111111111111111111111111111111111',
      EXPO_PUBLIC_VETO_MINT: 'Mint111111111111111111111111111111111111111',
    },
  );
  assert.equal(cfg.rpcUrl, 'http://127.0.0.1:8999');
  assert.equal(cfg.mint, 'Mint111111111111111111111111111111111111111');
});

test('mainnet-beta refuses the EXPO_PUBLIC_VETO_RPC fallback and needs the baked preview RPC', () => {
  const env = {
    EXPO_PUBLIC_VETO_RPC: 'https://api.mainnet-beta.solana.com',
    EXPO_PUBLIC_VETO_PROGRAM_ID: 'Pid11111111111111111111111111111111111111111',
    EXPO_PUBLIC_VETO_EXPLORER_CLUSTER: 'mainnet-beta',
  };
  assert.throws(() => configFromExtra({}, env), /VETO_MAINNET_PREVIEW_RPC/);
  assert.throws(
    () =>
      configFromExtra(
        {
          vetoExplorerCluster: 'mainnet-beta',
          vetoProgramId: 'Pid11111111111111111111111111111111111111111',
        },
        {},
      ),
    /VETO_MAINNET_PREVIEW_RPC/,
  );
  const cfg = configFromExtra(
    {
      vetoRpc: '  https://preview.rpc.example  ',
      vetoExplorerCluster: 'mainnet-beta',
      vetoProgramId: 'Pid11111111111111111111111111111111111111111',
    },
    env,
  );
  assert.equal(cfg.rpcUrl, 'https://preview.rpc.example');
  assert.equal(cfg.explorerCluster, 'mainnet-beta');
});
