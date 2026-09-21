import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ConnectGate } from '../../components/ConnectGate';
import { ContextBar } from '../../components/ContextBar';
import { DecisionRow } from '../../components/DecisionRow';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, LEDGER_CAPACITY } from '../../lib/constants';
import { groupByLocalDay, isListedDecision, newestFirst } from '../../lib/format';
import { displayPurpose } from '../../lib/ruleView';
import { useChain } from '../../lib/useChain';
import { truncateAddress } from '../../lib/wallet';

export default function DecisionsScreen() {
  const chain = useChain();
  const router = useRouter();
  const rpcUrl = chain.config?.rpcUrl ?? '';
  const cluster = chain.config?.explorerCluster ?? 'devnet';
  const mandate = chain.mandate;
  const charges = useMemo(
    () => newestFirst(chain.rows).filter((row) => isListedDecision(row.kind)),
    [chain.rows],
  );
  const paid = charges.filter((row) => row.kind === KIND_PAID).length;
  const refused = charges.filter((row) => row.kind === KIND_REFUSED).length;
  const waived = charges.filter((row) => row.kind === KIND_OVERRIDE).length;
  const days = useMemo(() => groupByLocalDay(charges), [charges]);

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <TopBar />
      <ConnectGate>
        {chain.configError ? <EmptyState>{chain.configError}</EmptyState> : null}
        {chain.error && chain.mandateStatus !== 'rate-limited' ? (
          <EmptyState>{chain.error}</EmptyState>
        ) : null}
        <ReadState
          status={chain.mandateStatus}
          empty="No rule on chain for this owner. Only decisions that actually ran appear here. This screen never invents rows."
        />
        {chain.snapshot && chain.snapshot.total > chain.snapshot.entries.length ? (
          <EmptyState>
            {`Showing the last ${LEDGER_CAPACITY} of ${chain.snapshot.total} decisions; the ring on chain keeps ${LEDGER_CAPACITY}. Export rebuilds the trail from transaction logs.`}
          </EmptyState>
        ) : null}
        {chain.mandateStatus === 'present' && mandate ? (
          <View style={styles.block}>
            <ContextBar
              title={displayPurpose(mandate.purpose)}
              subtitle={`decisions under this rule · agent ${truncateAddress(mandate.agent)}`}
              onSwitch={() => router.push('/(tabs)/rules')}
            />
            <View style={styles.head}>
              <Text style={styles.h2}>Decisions</Text>
              <Text style={styles.meta}>
                {paid} paid · {refused} refused · {waived} override
              </Text>
            </View>
            {charges.length === 0 ? (
              <EmptyState>
                No decisions on this rule yet. This screen reads the on-chain ring and never invents
                rows.
              </EmptyState>
            ) : (
              days.map((day) => (
                <View key={day.key} style={styles.dayBlock}>
                  <Text style={styles.day}>{day.heading}</Text>
                  {day.rows.map((row, index) => (
                    <DecisionRow
                      key={`${row.ts.toString()}-${row.kind}-${row.nonce.toString()}-${index}`}
                      row={row}
                      decimals={chain.decimals}
                      cluster={cluster}
                      rpcUrl={rpcUrl}
                      mandateAddress={mandate.address}
                      perTxMax={mandate.perTxMax}
                    />
                  ))}
                </View>
              ))
            )}
          </View>
        ) : null}
      </ConnectGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 10,
    alignSelf: 'stretch',
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  h2: {
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
  },
  meta: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
  dayBlock: {
    gap: 4,
    alignSelf: 'stretch',
  },
  day: {
    color: colors.text,
    fontSize: 22,
    fontFamily: fonts.serif,
    marginTop: 6,
  },
});
