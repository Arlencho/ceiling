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

import { agentKeyForOpen } from './agentAddress';
import { tryLoadConfig, type AppConfig } from './config';
import {
  closeMandate,
  createClient,
  fetchGenesisHash,
  fetchLedgerRows,
  fetchMintDecimals,
  fetchOwnerMandates,
  grantOverride,
  openMandate,
  pickMandate,
  probeOverride,
  revokeMandate,
  type ChainClient,
  type CloseResult,
  type GrantOverrideResult,
  type OpenMandateInput,
  type OpenMandateResult,
  type RevokeResult,
} from './chain';
import type { OverrideAssessment } from './override';
import {
  mandateReadStatus,
  RATE_LIMIT_GAVE_UP,
  RATE_LIMIT_RETRY_MS,
  type MandateReadStatus,
} from './mandateRead';
import type { MandateAccount } from './mandate';
import type { LedgerRow, LedgerSnapshot } from './ring';
import { isRateLimitError } from './rpcError';
import { secureStore } from './mwa';
import { useWallet } from './useWallet';
import type { WalletStore } from './wallet';

export const SELECTED_MANDATE_KEY = 'veto.mandate.selected';

export type ChainState = {
  ready: boolean;
  loading: boolean;
  error: string | null;
  rateLimited: boolean;
  checkedOwner: string | null;
  mandateStatus: MandateReadStatus;
  config: AppConfig | null;
  configError: string | null;
  mandate: MandateAccount | null;
  mandates: MandateAccount[];
  snapshot: LedgerSnapshot | null;
  rows: LedgerRow[];
  decimals: number;
  nowMs: number;
  genesisHash: string | null;
  refresh: () => Promise<void>;
  selectMandate: (address: string) => Promise<void>;
  open: (input: Omit<OpenMandateInput, 'owner' | 'agent'> & { agent?: PublicKey }) => Promise<OpenMandateResult>;
  revoke: (address?: string) => Promise<RevokeResult>;
  close: (address?: string) => Promise<CloseResult>;
  probeOverride: (mandateAddress: string, row: LedgerRow) => Promise<OverrideAssessment>;
  grantOverride: (mandateAddress: string, row: LedgerRow) => Promise<GrantOverrideResult>;
};

async function loadSelected(store: WalletStore): Promise<string | null> {
  return store.getItem(SELECTED_MANDATE_KEY);
}

async function saveSelected(store: WalletStore, address: string): Promise<void> {
  await store.setItem(SELECTED_MANDATE_KEY, address);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function useChainState(): ChainState {
  const wallet = useWallet();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [checkedOwner, setCheckedOwner] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [mandate, setMandate] = useState<MandateAccount | null>(null);
  const [mandates, setMandates] = useState<MandateAccount[]>([]);
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [decimals, setDecimals] = useState(6);
  const [nowMs, setNowMs] = useState(0);
  const [genesisHash, setGenesisHash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setNowMs(Date.now());
    const loaded = tryLoadConfig();
    if (!loaded.ok) {
      setConfig(null);
      setConfigError(loaded.error);
      setMandate(null);
      setMandates([]);
      setSnapshot(null);
      setRows([]);
      setError(null);
      setRateLimited(false);
      setCheckedOwner(null);
      setGenesisHash(null);
      setReady(true);
      return;
    }
    setConfig(loaded.config);
    setConfigError(null);

    if (!wallet.ownerPublicKey) {
      setMandate(null);
      setMandates([]);
      setSnapshot(null);
      setRows([]);
      setError(null);
      setRateLimited(false);
      setCheckedOwner(null);
      setReady(true);
      return;
    }

    const ownerKey = wallet.ownerPublicKey;
    setLoading(true);
    setError(null);
    setRateLimited(false);

    const run = async () => {
      const client = createClient(loaded.config);
      const owner = new PublicKey(ownerKey);
      const preferred = await loadSelected(secureStore);
      const found = await fetchOwnerMandates(client, owner);
      setMandates(found);
      const selected = pickMandate(found, preferred);
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
      let genesis: string | null = null;
      try {
        genesis = await fetchGenesisHash(client);
      } catch (err) {
        if (isRateLimitError(err)) {
          throw err;
        }
      }
      setMandate(selected);
      setSnapshot(ledger.snapshot);
      setRows(ledger.rows);
      setDecimals(mintDecimals);
      if (genesis) {
        setGenesisHash(genesis);
      }
    };

    try {
      await run();
    } catch (err) {
      if (isRateLimitError(err)) {
        setRateLimited(true);
        let last: unknown = err;
        for (const delay of RATE_LIMIT_RETRY_MS) {
          await wait(delay);
          try {
            await run();
            setRateLimited(false);
            last = null;
            break;
          } catch (retryErr) {
            last = retryErr;
            if (!isRateLimitError(retryErr)) {
              break;
            }
          }
        }
        if (last) {
          if (isRateLimitError(last)) {
            setError(RATE_LIMIT_GAVE_UP);
            setRateLimited(false);
          } else {
            setError(last instanceof Error ? last.message : 'Chain read failed');
            setRateLimited(false);
          }
        }
      } else {
        setError(err instanceof Error ? err.message : 'Chain read failed');
      }
    } finally {
      setLoading(false);
      setReady(true);
      setCheckedOwner(ownerKey);
    }
  }, [wallet.ownerPublicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectMandate = useCallback(
    async (address: string) => {
      await saveSelected(secureStore, address);
      await refresh();
    },
    [refresh],
  );

  const open = useCallback(
    async (input: Omit<OpenMandateInput, 'owner' | 'agent'> & { agent?: PublicKey }) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      const agentKey = await agentKeyForOpen(input.agent, () => wallet.createAgentKeypair());
      const client: ChainClient = createClient(loaded.config);
      const result = await openMandate(client, wallet.signAndSend, {
        owner: new PublicKey(wallet.ownerPublicKey),
        agent: agentKey,
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

  const revoke = useCallback(
    async (address?: string) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      const target =
        (address ? mandates.find((row) => row.address === address) : null) ?? mandate;
      if (!target) {
        throw new Error('No mandate on chain to revoke');
      }
      const client = createClient(loaded.config);
      const result = await revokeMandate(
        client,
        wallet.signAndSend,
        new PublicKey(wallet.ownerPublicKey),
        target,
      );
      await refresh();
      return result;
    },
    [mandate, mandates, refresh, wallet],
  );

  const close = useCallback(
    async (address?: string) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      const target =
        (address ? mandates.find((row) => row.address === address) : null) ?? mandate;
      if (!target) {
        throw new Error('No mandate on chain to close');
      }
      const client = createClient(loaded.config);
      const result = await closeMandate(
        client,
        wallet.signAndSend,
        new PublicKey(wallet.ownerPublicKey),
        target,
      );
      await refresh();
      return result;
    },
    [mandate, mandates, refresh, wallet],
  );

  const probeLiveOverride = useCallback(
    async (mandateAddress: string, row: LedgerRow) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      const client = createClient(loaded.config);
      return probeOverride(client, new PublicKey(mandateAddress), row, decimals);
    },
    [decimals],
  );

  const grantLiveOverride = useCallback(
    async (mandateAddress: string, row: LedgerRow) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      const target =
        mandates.find((item) => item.address === mandateAddress) ??
        (mandate?.address === mandateAddress ? mandate : null);
      if (!target) {
        throw new Error('This rule is not loaded for this owner. Pull to retry.');
      }
      const client = createClient(loaded.config);
      const result = await grantOverride(
        client,
        wallet.signAndSend,
        new PublicKey(wallet.ownerPublicKey),
        target,
        row,
        decimals,
      );
      await refresh();
      return result;
    },
    [decimals, mandate, mandates, refresh, wallet],
  );

  const mandateStatus = mandateReadStatus({
    checkedOwner,
    ownerPublicKey: wallet.ownerPublicKey,
    loading,
    error,
    hasMandate: mandate != null,
    rateLimited,
  });

  return useMemo(
    () => ({
      ready,
      loading,
      error,
      rateLimited,
      checkedOwner,
      mandateStatus,
      config,
      configError,
      mandate,
      mandates,
      snapshot,
      rows,
      decimals,
      nowMs,
      genesisHash,
      refresh,
      selectMandate,
      open,
      revoke,
      close,
      probeOverride: probeLiveOverride,
      grantOverride: grantLiveOverride,
    }),
    [
      ready,
      loading,
      error,
      rateLimited,
      checkedOwner,
      mandateStatus,
      config,
      configError,
      mandate,
      mandates,
      snapshot,
      rows,
      decimals,
      nowMs,
      genesisHash,
      refresh,
      selectMandate,
      open,
      revoke,
      close,
      probeLiveOverride,
      grantLiveOverride,
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
