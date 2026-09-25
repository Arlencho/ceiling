import { useLocalSearchParams, useRouter } from 'expo-router';

import { FrozenScreen } from '../../components/hold/FrozenScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { recoverHoldVault } from '../../lib/holdActions';
import {
  HOLD_KIND_FROZEN,
  daysFromDelay,
  formatChainInstant,
  formatHoldAmount,
  frozenByLine,
  holdRecordLines,
  isDefaultKey,
  routeParam,
  shortKey,
  waitLabel,
} from '../../lib/hold';
import { useHoldBundle } from '../../lib/holdSession';

export default function HoldFrozen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ vault?: string }>();
  const address = routeParam(params.vault);
  const loaded = useHoldBundle(address);
  const bundle = loaded.bundle;
  const decimals = bundle?.decimals ?? 0;
  const amountLabel = bundle ? formatHoldAmount(bundle.balance, decimals) : '0';
  const freeze = bundle?.ledger.entries.filter((entry) => entry.kind === HOLD_KIND_FROZEN).at(-1) ?? null;
  const days = bundle ? daysFromDelay(bundle.account.delaySecs) : null;
  const guardian = bundle?.account.guardian.toBase58() ?? '';
  const hasGuardian = guardian.length > 0 && !isDefaultKey(guardian);
  const records = bundle
    ? holdRecordLines({
        entries: bundle.ledger.entries.map((entry) => ({
          ts: entry.ts,
          amount: entry.amount,
          destination: entry.destination.toBase58(),
          kind: entry.kind,
          reason: entry.reason,
        })),
        owner: bundle.account.owner.toBase58(),
        guardian,
        decimals,
        tokenName: loaded.tokenName,
      })
    : [];
  const status = loaded.status === 'ready' && bundle && !bundle.account.frozen ? 'empty' : loaded.status;

  return (
    <Screen onRefresh={() => void loaded.reload()} refreshing={loaded.status === 'loading'}>
      <ConnectGate>
        <FrozenScreen
          network={loaded.network}
          status={status}
          error={loaded.error}
          frozenBy={frozenByLine(
            guardian,
            bundle?.account.owner.toBase58() ?? '',
            freeze ? freeze.destination.toBase58() : null,
          )}
          amountLabel={amountLabel}
          tokenName={loaded.tokenName}
          stoppedLine={
            bundle
              ? `Nothing can leave while this vault is frozen, not even the everyday ${formatHoldAmount(bundle.account.dailyLimit, decimals)} ${loaded.tokenName} a day. All ${amountLabel} ${loaded.tokenName} is still here.`
              : ''
          }
          sinceLabel={
            freeze
              ? `Nothing has left since the freeze. Frozen since ${formatChainInstant(freeze.ts)}.`
              : 'Nothing can leave while it is frozen.'
          }
          safeLabel={bundle ? shortKey(bundle.account.safeAddress.toBase58()) : ''}
          records={records}
          unfreezeHint={
            hasGuardian
              ? 'Needs both keys, signed separately'
              : `No guardian key is set, so unfreezing waits ${days ? waitLabel(days) : 'the full delay'}`
          }
          onClose={() => router.back()}
          signingDisabled={loaded.wallet.busy}
          onRecover={async () => {
            if (!loaded.client || !loaded.owner || !bundle) {
              throw new Error('The vault is not ready to sign.');
            }
            await recoverHoldVault({
              client: loaded.client,
              signAndSend: loaded.wallet.signAndSend,
              authority: loaded.owner,
              owner: bundle.account.owner,
              vaultId: bundle.account.vaultId,
              safeAddress: bundle.account.safeAddress,
              mint: bundle.account.mint,
              tokenProgram: bundle.tokenProgram,
            });
            router.replace('/hold');
          }}
          onUnfreeze={() => {
            router.push(`/hold/skip?vault=${address}&purpose=unfreeze`);
          }}
        />
      </ConnectGate>
    </Screen>
  );
}
