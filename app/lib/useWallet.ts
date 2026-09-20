import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Keypair, Transaction } from '@solana/web3.js';

import { secureStore, transact } from './mwa';
import {
  connect,
  disconnect,
  loadAgentKeypair,
  restore,
  signAndSendTransactions,
} from './wallet';

export type WalletState = {
  ready: boolean;
  busy: boolean;
  error: string | null;
  ownerPublicKey: string | null;
  agentPublicKey: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signAndSend: (transactions: Transaction[]) => Promise<string[]>;
  getAgentKeypair: () => Promise<Keypair | null>;
};

function messageFromUnknown(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const lower = message.toLowerCase();
  if (lower.includes('cancel') || lower.includes('declin') || lower.includes('reject')) {
    return 'Authorization was cancelled';
  }
  if (lower.includes('not found') || lower.includes('no wallet')) {
    return 'No Mobile Wallet Adapter wallet was found';
  }
  if (message) {
    return message;
  }
  return 'Wallet request failed';
}

function useWalletState(): WalletState {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownerPublicKey, setOwnerPublicKey] = useState<string | null>(null);
  const [agentPublicKey, setAgentPublicKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await restore(secureStore);
        if (cancelled) {
          return;
        }
        setAgentPublicKey(snapshot.agentPublicKey);
        setOwnerPublicKey(snapshot.session?.ownerPublicKey ?? null);
      } catch (err) {
        if (!cancelled) {
          setError(messageFromUnknown(err));
        }
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onConnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await connect(transact, secureStore);
      setOwnerPublicKey(next.ownerPublicKey);
      setAgentPublicKey(next.agentPublicKey);
    } catch (err) {
      setError(messageFromUnknown(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const onDisconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnect(transact, secureStore);
    } catch (err) {
      setError(messageFromUnknown(err));
    } finally {
      setOwnerPublicKey(null);
      setBusy(false);
    }
  }, []);

  const signAndSend = useCallback(async (transactions: Transaction[]) => {
    setBusy(true);
    setError(null);
    try {
      return await signAndSendTransactions(transact, secureStore, transactions);
    } catch (err) {
      const message = messageFromUnknown(err);
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setBusy(false);
    }
  }, []);

  const getAgentKeypair = useCallback(() => loadAgentKeypair(secureStore), []);

  return useMemo(
    () => ({
      ready,
      busy,
      error,
      ownerPublicKey,
      agentPublicKey,
      connect: onConnect,
      disconnect: onDisconnect,
      signAndSend,
      getAgentKeypair,
    }),
    [
      ready,
      busy,
      error,
      ownerPublicKey,
      agentPublicKey,
      onConnect,
      onDisconnect,
      signAndSend,
      getAgentKeypair,
    ],
  );
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const value = useWalletState();
  return createElement(WalletContext.Provider, { value }, children);
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error('useWallet must be used within WalletProvider');
  }
  return ctx;
}
