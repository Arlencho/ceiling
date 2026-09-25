import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useChain } from './useChain';
import { useWallet } from './useWallet';
import { holdNetworkPill, holdTokenName } from './hold';
import { tokenSymbol } from './tokens';
import { holdClient, readHoldVault, type HoldVaultBundle } from './holdChain';
import type { ChainClient } from './chain';

export function useHoldSession() {
  const wallet = useWallet();
  const chain = useChain();
  const config = chain.config;
  const ownerText = wallet.ownerPublicKey;
  const owner = useMemo(() => (ownerText ? safeKey(ownerText) : null), [ownerText]);
  const client = useMemo(() => (config ? holdClient(config) : null), [config]);
  const cluster = config?.explorerCluster ?? 'devnet';
  return {
    wallet,
    chain,
    config,
    owner,
    client,
    network: holdNetworkPill(cluster),
    tokenName: holdTokenName(cluster, config?.mint),
    cluster,
  };
}

function safeKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

export function useHoldBundle(address: string) {
  const session = useHoldSession();
  const [status, setStatus] = useState<'loading' | 'error' | 'empty' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<HoldVaultBundle | null>(null);
  const [nowSec, setNowSec] = useState<bigint | null>(null);

  const load = useCallback(async () => {
    await Promise.resolve();
    if (!session.client) {
      setStatus('error');
      setError(session.chain.configError ?? 'The app is not configured for a cluster.');
      return;
    }
    if (address.length === 0) {
      setStatus('empty');
      return;
    }
    let key: PublicKey;
    try {
      key = new PublicKey(address);
    } catch {
      setStatus('error');
      setError('That vault address could not be read.');
      return;
    }
    setStatus('loading');
    try {
      const { readChainClock } = await import('./holdChain');
      const [next, clock] = await Promise.all([
        readHoldVault(session.client, key),
        readChainClock(session.client.connection),
      ]);
      setBundle(next);
      setNowSec(clock);
      setError(null);
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'The vault could not be read.');
    }
  }, [address, session.chain.configError, session.client]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  const tokenName = bundle ? tokenSymbol(bundle.account.mint.toBase58()) : session.tokenName;
  return { ...session, status, error, bundle, nowSec, reload: load, tokenName };
}

export type HoldSessionClient = ChainClient;
