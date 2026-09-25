import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';

import { AmountScreen } from '../../components/hold/AmountScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { fetchMintDecimals, tokenProgramOfMint } from '../../lib/chain';
import { formatHoldAmount, shortKey } from '../../lib/hold';
import { ownerTokenAccount, readTokenAmount } from '../../lib/holdChain';
import { useHoldDraft } from './_layout';
import { useHoldSession } from '../../lib/holdSession';

export default function HoldAmount() {
  const router = useRouter();
  const draft = useHoldDraft();
  const session = useHoldSession();
  const [status, setStatus] = useState<'loading' | 'error' | 'empty' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [balanceLabel, setBalanceLabel] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const client = session.client;
    const mintText = session.config?.mint;
    const owner = session.owner;
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive || !session.wallet.ready) return;
      if (!client || !mintText || !owner) {
        setStatus('error');
        setError(session.chain.configError ?? 'Connect a wallet before moving money in.');
        return;
      }
      try {
        const mint = new PublicKey(mintText);
        const tokenProgram = await tokenProgramOfMint(client, mint);
        const decimals = await fetchMintDecimals(client, mint);
        const account = ownerTokenAccount(mint, owner, tokenProgram);
        const balance = await readTokenAmount(client.connection, account);
        if (!alive) return;
        setBalanceLabel(balance === null ? null : formatHoldAmount(balance, decimals));
        setStatus(balance === null ? 'empty' : 'ready');
      } catch (err) {
        if (!alive) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : 'The wallet balance could not be read.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [session.chain.configError, session.client, session.config, session.owner, session.wallet.ready]);

  return (
    <Screen>
      <ConnectGate>
        <AmountScreen
          network={session.network}
          status={status}
          error={formError ?? error}
          amountText={draft.amountText}
          balanceLabel={balanceLabel}
          tokenName={session.tokenName}
          walletLabel={session.owner ? shortKey(session.owner.toBase58()) : 'not connected'}
          onAmount={(text) => {
            setFormError(null);
            draft.setAmountText(text);
          }}
          onBack={() => router.back()}
          onNext={() => {
            if (draft.amountText.trim().length === 0) {
              setFormError('Enter how much moves into your vault.');
              return;
            }
            router.push('/hold/rules');
          }}
        />
      </ConnectGate>
    </Screen>
  );
}
