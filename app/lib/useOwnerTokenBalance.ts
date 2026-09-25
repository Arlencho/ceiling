import { PublicKey } from '@solana/web3.js';
import { useEffect, useState } from 'react';

import { createClient } from './chain';
import { observePresign } from './presignRead';
import { useChain } from './useChain';
import { useWallet } from './useWallet';

export function useOwnerTokenBalance(
  mintText: string | null | undefined,
  enabled: boolean,
): { balance: bigint | null; known: boolean } {
  const chain = useChain();
  const wallet = useWallet();
  const [state, setState] = useState<{ balance: bigint | null; known: boolean }>({
    balance: null,
    known: false,
  });

  useEffect(() => {
    if (!enabled || !chain.config || !wallet.ownerPublicKey || !mintText) {
      return;
    }
    let mint: PublicKey;
    try {
      mint = new PublicKey(mintText);
    } catch {
      return;
    }
    let alive = true;
    const client = createClient(chain.config);
    void observePresign({
      connection: client.connection,
      owner: new PublicKey(wallet.ownerPublicKey),
      payee: null,
      mint,
      cluster: chain.config.explorerCluster,
    })
      .then((observation) => {
        if (!alive) {
          return;
        }
        setState({
          balance: observation.ownerTokenBalance,
          known: observation.mintReadable,
        });
      })
      .catch(() => {
        if (!alive) {
          return;
        }
        setState({ balance: null, known: false });
      });
    return () => {
      alive = false;
    };
  }, [chain.config, enabled, mintText, wallet.ownerPublicKey]);

  return state;
}
