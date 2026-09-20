import { PublicKey } from '@solana/web3.js';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { tryLoadConfig, type AppConfig } from './config';
import {
  createClient,
  fetchLedgerRows,
  fetchMintDecimals,
  fetchOwnerMandates,
  openMandate,
  pickMandate,
  revokeMandate,
  type ChainClient,
  type OpenMandateInput,
  type OpenMandateResult,
  type RevokeResult,
} from './chain';
import type { MandateAccount } from './mandate';
import type { LedgerRow, LedgerSnapshot } from './ring';
import { secureStore } from './mwa';
import { useWallet } from './useWallet';
import type { WalletStore } from './wallet';

export const SELECTED_MANDATE_KEY = 'veto.mandate.selected';

export type ChainState = {
  ready: boolean;
  loading: boolean;
  error: string | null;
  config: AppConfig | null;
  configError: string | null;
  mandate: MandateAccount | null;
  snapshot: LedgerSnapshot | null;
  rows: LedgerRow[];
  decimals: number;
  nowMs: number;
  refresh: () => Promise<void>;
  open: (input: Omit<OpenMandateInput, 'owner' | 'agent'> & { agent?: PublicKey }) => Promise<OpenMandateResult>;
  revoke: () => Promise<RevokeResult>;
};

async function loadSelected(store: WalletStore): Promise<string | null> {
  return store.getItem(SELECTED_MANDATE_KEY);
}

async function saveSelected(store: WalletStore, address: string): Promise<void> {
  await store.setItem(SELECTED_MANDATE_KEY, address);
}

function useChainState(): ChainState {
  const wallet = useWallet();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [mandate, setMandate] = useState<MandateAccount | null>(null);
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [decimals, setDecimals] = useState(6);
  const [nowMs, setNowMs] = useState(0);

  const refresh = useCallback(async () => {
    setNowMs(Date.now());
    const loaded = tryLoadConfig();
    if (!loaded.ok) {
      setConfig(null);
      setConfigError(loaded.error);
      setMandate(null);
      setSnapshot(null);
      setRows([]);
      setReady(true);
      return;
    }
    setConfig(loaded.config);
    setConfigError(null);

    if (!wallet.ownerPublicKey) {
      setMandate(null);
      setSnapshot(null);
      setRows([]);
      setReady(true);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const client = createClient(loaded.config);
      const owner = new PublicKey(wallet.ownerPublicKey);
      const preferred = await loadSelected(secureStore);
      const mandates = await fetchOwnerMandates(client, owner);
      const selected = pickMandate(mandates, preferred);
      if (!selected) {
        setMandate(null);
        setSnapshot(null);
        setRows([]);
        return;
      }
      await saveSelected(secureStore, selected.address);
      const ledger = await fetchLedgerRows(client, new PublicKey(selected.address));
      let mintDecimals = loaded.config.mintDecimals;
      try {
        mintDecimals = await fetchMintDecimals(client, new PublicKey(selected.mint));
      } catch {
        // Keep the configured fallback rather than inventing an amount.
      }
      setMandate(selected);
      setSnapshot(ledger.snapshot);
      setRows(ledger.rows);
      setDecimals(mintDecimals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chain read failed');
    } finally {
      setLoading(false);
      setReady(true);
    }
  }, [wallet.ownerPublicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(
    async (input: Omit<OpenMandateInput, 'owner' | 'agent'> & { agent?: PublicKey }) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      const agentKey = await wallet.getAgentKeypair();
      if (!agentKey) {
        throw new Error('Agent key is missing from secure storage');
      }
      const client: ChainClient = createClient(loaded.config);
      const result = await openMandate(client, wallet.signAndSend, {
        owner: new PublicKey(wallet.ownerPublicKey),
        agent: input.agent ?? agentKey.publicKey,
        merchant: input.merchant,
        cap: input.cap,
        perTxMax: input.perTxMax,
        expiresAt: input.expiresAt,
        purpose: input.purpose,
        mint: input.mint,
      });
      await saveSelected(secureStore, result.mandate.address);
      await refresh();
      return result;
    },
    [refresh, wallet],
  );

  const revoke = useCallback(async () => {
    const loaded = tryLoadConfig();
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    if (!wallet.ownerPublicKey) {
      throw new Error('Connect with Seed Vault first');
    }
    if (!mandate) {
      throw new Error('No mandate on chain to revoke');
    }
    const client = createClient(loaded.config);
    const result = await revokeMandate(
      client,
      wallet.signAndSend,
      new PublicKey(wallet.ownerPublicKey),
      mandate,
    );
    await refresh();
    return result;
  }, [mandate, refresh, wallet]);

  return useMemo(
    () => ({
      ready,
      loading,
      error,
      config,
      configError,
      mandate,
      snapshot,
      rows,
      decimals,
      nowMs,
      refresh,
      open,
      revoke,
    }),
    [
      ready,
      loading,
      error,
      config,
      configError,
      mandate,
      snapshot,
      rows,
      decimals,
      nowMs,
      refresh,
      open,
      revoke,
    ],
  );
}

const ChainContext = createContext<ChainState | null>(null);

export function ChainProvider({ children }: { children: ReactNode }) {
  const value = useChainState();
  return createElement(ChainContext.Provider, { value }, children);
}

export function useChain(): ChainState {
  const ctx = useContext(ChainContext);
  if (!ctx) {
    throw new Error('useChain must be used within ChainProvider');
  }
  return ctx;
}
