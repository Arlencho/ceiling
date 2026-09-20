import { useCallback, useEffect, useState } from 'react';

import { secureStore, transact } from './mwa';
import { connect, disconnect, restore } from './wallet';

export type WalletState = {
  ready: boolean;
  busy: boolean;
  error: string | null;
  ownerPublicKey: string | null;
  agentPublicKey: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
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

export function useWallet(): WalletState {
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

  return {
    ready,
    busy,
    error,
    ownerPublicKey,
    agentPublicKey,
    connect: onConnect,
    disconnect: onDisconnect,
  };
}
