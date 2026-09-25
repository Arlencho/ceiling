import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { PromiseScreen } from '../../components/hold/PromiseScreen';
import { VaultHome, type VaultCard } from '../../components/hold/VaultHome';
import { Screen } from '../../components/Screen';
import { ConnectGate } from '../../components/ConnectGate';
import {
  daysFromDelay,
  formatHoldAmount,
  isDefaultKey,
  shortKey,
  waitLabel,
} from '../../lib/hold';
import { holdClient, listHoldVaults, readTokenAmount } from '../../lib/holdChain';
import { raiseHoldAlertsOnScan } from '../../lib/holdNotify';
import { fetchMintDecimals } from '../../lib/chain';
import { tokenSymbol } from '../../lib/tokens';
import { useHoldSession } from '../../lib/holdSession';

export default function HoldIndex() {
  const router = useRouter();
  const session = useHoldSession();
  const [status, setStatus] = useState<'loading' | 'error' | 'empty' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [vaults, setVaults] = useState<VaultCard[]>([]);

  const load = useCallback(async () => {
    await Promise.resolve();
    if (!session.client || !session.config || !session.owner) {
      setStatus(session.chain.configError ? 'error' : 'loading');
      setError(session.chain.configError);
      return;
    }
    if (!session.config.mint) {
      setStatus('error');
      setError('No token is configured for this app.');
      return;
    }
    setStatus('loading');
    try {
      const client = holdClient(session.config);
      const rows = await listHoldVaults(client, session.owner);
      const decimalsByMint = new Map<string, number>();
      const cards: VaultCard[] = [];
      for (const row of rows) {
        const mintKey = row.mint.toBase58();
        let decimals = decimalsByMint.get(mintKey);
        if (decimals == null) {
          decimals = await fetchMintDecimals(client, row.mint);
          decimalsByMint.set(mintKey, decimals);
        }
        const balance = (await readTokenAmount(client.connection, row.vaultToken)) ?? 0n;
        const days = daysFromDelay(row.delaySecs);
        const pending = row.pending[0];
        const tokenName = tokenSymbol(mintKey);
        cards.push({
          address: row.address.toBase58(),
          amountLabel: formatHoldAmount(balance, decimals),
          tokenName,
          dailyLabel: formatHoldAmount(row.dailyLimit, decimals),
          waitLabel: days ? waitLabel(days) : 'an unusual wait',
          frozen: row.frozen,
          pendingLabel:
            row.pending.length > 1
              ? `${row.pending.length} withdrawals are waiting`
              : pending
                ? `${formatHoldAmount(pending.amount, decimals)} ${tokenName} is waiting`
                : null,
          guardianLabel: isDefaultKey(row.guardian.toBase58())
            ? 'is not set'
            : shortKey(row.guardian.toBase58()),
          safeLabel: shortKey(row.safeAddress.toBase58()),
        });
      }
      setVaults(cards);
      setError(null);
      setStatus(cards.length === 0 ? 'empty' : 'ready');
      void raiseHoldAlertsOnScan().catch(() => undefined);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'The vaults could not be read.');
    }
  }, [session.chain.configError, session.client, session.config, session.owner]);

  useEffect(() => {
    if (!session.wallet.ready) return;
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load, session.wallet.ready]);

  return (
    <Screen onRefresh={() => void load()} refreshing={status === 'loading'}>
      <ConnectGate>
        {status === 'empty' ? (
          <PromiseScreen
            network={session.network}
            onBack={() => router.back()}
            onStart={() => router.push('/hold/amount')}
          />
        ) : (
          <VaultHome
            network={session.network}
            status={session.wallet.ready ? status : 'loading'}
            error={error}
            vaults={vaults}
            onBack={() => router.back()}
            onSetup={() => router.push('/hold/amount')}
            onOpen={(address, kind) => {
              if (kind === 'frozen') router.push(`/hold/frozen?vault=${address}`);
              else if (kind === 'held') router.push(`/hold/held?vault=${address}`);
              else router.push(`/hold/send?vault=${address}`);
            }}
            onSend={(address) => router.push(`/hold/send?vault=${address}`)}
          />
        )}
      </ConnectGate>
    </Screen>
  );
}
