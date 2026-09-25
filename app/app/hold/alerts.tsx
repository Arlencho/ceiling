import { useLocalSearchParams, useRouter } from 'expo-router';

import { AlertPlanScreen, type AlertRow } from '../../components/hold/AlertPlanScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { holdAlertPlan, nextAlertIndex } from '../../lib/holdAlerts';
import { stopHoldWithdrawal } from '../../lib/holdActions';
import { formatChainInstant, formatHoldAmount, routeParam, shortKey, waitLabel, daysFromDelay, isDefaultKey } from '../../lib/hold';
import { holdCreatedAt } from '../../lib/holdRead';
import { useHoldBundle } from '../../lib/holdSession';

export default function HoldAlerts() {
  const router = useRouter();
  const params = useLocalSearchParams<{ vault?: string; id?: string }>();
  const address = routeParam(params.vault);
  const idText = routeParam(params.id);
  const loaded = useHoldBundle(address);
  const bundle = loaded.bundle;
  const row =
    bundle?.account.pending.find((item) => (idText ? item.id.toString() === idText : true)) ?? null;
  const now = loaded.nowSec ?? 0n;
  const decimals = bundle?.decimals ?? 0;
  const amountLabel = row ? `${formatHoldAmount(row.amount, decimals)} ${loaded.tokenName}` : '';
  const destinationLabel = row ? shortKey(row.destination.toBase58()) : '';
  const days = bundle ? daysFromDelay(bundle.account.delaySecs) : null;
  const plan =
    bundle && row
      ? holdAlertPlan({
          vault: address,
          withdrawalId: row.id.toString(),
          amountLabel,
          destinationLabel,
          createdAt: holdCreatedAt(bundle.account, row, bundle.ledger.entries),
          unlockAt: row.unlockAt,
          newAddress: !bundle.account.known.some((key) => key.equals(row.destination)),
        })
      : [];
  const next = nextAlertIndex(plan, now);
  const rows: AlertRow[] = plan.map((alert, index) => ({
    when: formatChainInstant(alert.at),
    what: alert.row,
    state: index === next ? 'next' : alert.at <= now ? 'done' : 'later',
  }));
  const created = plan[0];
  const status = loaded.status === 'ready' && !row ? 'empty' : loaded.status;

  return (
    <Screen onRefresh={() => void loaded.reload()} refreshing={loaded.status === 'loading'}>
      <ConnectGate>
        <AlertPlanScreen
          network={loaded.network}
          status={status}
          error={loaded.error}
          headline={
            row
              ? `This phone schedules the remaining reminders when it checks, if notifications are allowed.${bundle && !isDefaultKey(bundle.account.guardian.toBase58()) ? " Your guardian's phone does the same when it next checks." : ''} These are the planned times while ${amountLabel} to ${destinationLabel} waits. Miss them all and the wait still runs its full ${days ? waitLabel(days) : 'length'}.`
              : ''
          }
          noticeTitle={created?.title ?? 'Held'}
          noticeBody={created?.body ?? ''}
          noticeWhen={created ? `${formatChainInstant(created.at)}, planned` : ''}
          rows={rows}
          onBack={() => router.back()}
          signingDisabled={loaded.wallet.busy || !row}
          onStop={async () => {
            if (!loaded.client || !loaded.owner || !bundle || !row) {
              throw new Error('The vault is not ready to sign.');
            }
            await stopHoldWithdrawal({
              client: loaded.client,
              signAndSend: loaded.wallet.signAndSend,
              authority: loaded.owner,
              owner: bundle.account.owner,
              vaultId: bundle.account.vaultId,
              id: row.id,
            });
            router.replace(`/hold/held?vault=${address}&id=${row.id.toString()}`);
          }}
        />
      </ConnectGate>
    </Screen>
  );
}
