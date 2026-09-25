import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';

import { GuardScreen, type GuardResult } from '../../components/hold/GuardScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { explorerTxUrl } from '../../lib/format';
import {
  HOLD_KIND_RECOVERED,
  formatChainInstant,
  formatHoldAmount,
  routeParam,
  shortKey,
} from '../../lib/hold';
import { changeLoosenLines, guardBrake, guardResultLine, type GuardBrake } from '../../lib/holdGuard';
import { useHoldBundle } from '../../lib/holdSession';

export default function HoldGuard() {
  const router = useRouter();
  const params = useLocalSearchParams<{ vault?: string; id?: string }>();
  const address = routeParam(params.vault);
  const idText = routeParam(params.id);
  const loaded = useHoldBundle(address);
  const [result, setResult] = useState<GuardResult | null>(null);
  const bundle = loaded.bundle;
  const account = bundle?.account ?? null;
  const decimals = bundle?.decimals ?? 0;
  const row = (idText
    ? account?.pending.find((item) => item.id.toString() === idText)
    : account?.pending[0]) ?? null;
  const notGuardian = Boolean(account && loaded.owner && !account.guardian.equals(loaded.owner));
  const status = notGuardian ? 'error' : loaded.status;
  const error = notGuardian
    ? 'The connected key is not the guardian of this vault. Connect the guardian key to brake it.'
    : loaded.error;
  const amountLabel = bundle ? formatHoldAmount(bundle.balance, decimals) : '0';
  const safeAddress = account?.safeAddress.toBase58() ?? '';

  async function brake(kind: GuardBrake) {
    if (!loaded.client || !loaded.owner || !bundle) {
      throw new Error('The vault is not ready to sign.');
    }
    if (kind === 'stop' && !row) {
      throw new Error('The withdrawal you were told about is no longer waiting.');
    }
    const signature = await guardBrake({
      kind,
      client: loaded.client,
      signAndSend: loaded.wallet.signAndSend,
      guardian: loaded.owner,
      bundle,
      withdrawalId: row?.id ?? null,
    });
    const refreshed = await loaded.reload();
    const newEntries = refreshed && refreshed.ledger.total > bundle.ledger.total
      ? refreshed.ledger.entries.slice(-Math.min(refreshed.ledger.total - bundle.ledger.total, refreshed.ledger.entries.length))
      : [];
    const recovered = [...newEntries].reverse().find(entry => entry.kind === HOLD_KIND_RECOVERED);
    const line = kind === 'recover' && !recovered
      ? `Moved to the safe address ${shortKey(safeAddress)}. The recovered amount could not be read yet. Check the transaction.`
      : guardResultLine({
          kind,
          amountLabel: kind === 'recover' && recovered
            ? formatHoldAmount(recovered.amount, refreshed?.decimals ?? decimals)
            : row ? formatHoldAmount(row.amount, decimals) : amountLabel,
          tokenName: loaded.tokenName,
          destinationLabel: row ? shortKey(row.destination.toBase58()) : '',
          safeLabel: shortKey(safeAddress),
        });
    const config = loaded.client.config;
    setResult({ line, link: explorerTxUrl(signature, config.explorerCluster, config.rpcUrl) });
  }

  return (
    <Screen onRefresh={() => void loaded.reload()} refreshing={loaded.status === 'loading'}>
      <ConnectGate>
        <GuardScreen
          network={loaded.network}
          status={status}
          error={error}
          ownerLabel={account ? shortKey(account.owner.toBase58()) : ''}
          amountLabel={amountLabel}
          hasMoney={(bundle?.balance ?? 0n) > 0n}
          missingWithdrawal={Boolean(idText && !row)}
          tokenName={loaded.tokenName}
          frozen={account?.frozen ?? false}
          waiting={
            row
              ? {
                  amountLabel: formatHoldAmount(row.amount, decimals),
                  destinationLabel: shortKey(row.destination.toBase58()),
                  untilLabel: `Waits until ${formatChainInstant(row.unlockAt)}, unless stopped.`,
                }
              : null
          }
          moreWaiting={account ? Math.max(0, account.pending.length - (row ? 1 : 0)) : 0}
          changeLines={
            account
              ? changeLoosenLines({ account, decimals, tokenName: loaded.tokenName, viewer: loaded.owner })
              : []
          }
          changeAtLabel={account?.change.active ? formatChainInstant(account.change.effectiveAt) : null}
          safeAddress={safeAddress}
          safeLabel={shortKey(safeAddress)}
          result={result}
          onClose={() => router.back()}
          signingDisabled={loaded.wallet.busy}
          onStop={() => brake('stop')}
          onFreeze={() => brake('freeze')}
          onRecover={() => brake('recover')}
          onOpenLink={(link) => {
            void Linking.openURL(link);
          }}
        />
      </ConnectGate>
    </Screen>
  );
}
