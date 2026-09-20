import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ConnectGate } from '../components/ConnectGate';
import { DecisionRow } from '../components/DecisionRow';
import { EmptyState } from '../components/EmptyState';
import { MandateSummary } from '../components/MandateSummary';
import { Screen } from '../components/Screen';
import { ScreenTitle, SectionTitle } from '../components/SectionTitle';
import { colors } from '../components/theme';
import { todaysAgentDecisions } from '../lib/format';
import { useChain } from '../lib/useChain';

export default function TodayScreen() {
  const chain = useChain();
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const today = todaysAgentDecisions(chain.snapshot?.entries ?? [], chain.nowMs);
  const rpcUrl = chain.config?.rpcUrl ?? '';
  const cluster = chain.config?.explorerCluster ?? 'devnet';
  const refresh = chain.refresh;

  const onRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <ScreenTitle>Today</ScreenTitle>
      <ConnectGate>
        {chain.configError ? <EmptyState>{chain.configError}</EmptyState> : null}
        {chain.error ? <Text style={styles.error}>{chain.error}</Text> : null}
        {!chain.configError && !chain.mandate ? (
          <EmptyState>
            No mandate on chain for this owner yet. Open one on the Mandate tab. This screen reads
            real history only and never invents rows.
          </EmptyState>
        ) : null}
        {chain.mandate ? (
          <View style={styles.block}>
            <MandateSummary
              heading="Mandate, read from chain"
              mandate={chain.mandate}
              decimals={chain.decimals}
              nowSec={nowSec}
            />
            <SectionTitle>What the agent did and declined</SectionTitle>
            {today.length === 0 ? (
              <EmptyState>
                The agent has not paid or declined anything today. This screen never invents rows.
              </EmptyState>
            ) : (
              today.map((entry, index) => (
                <DecisionRow
                  key={`${entry.nonce.toString()}-${entry.kind}-${index}`}
                  row={
                    chain.rows.find(
                      (row) =>
                        row.kind === entry.kind &&
                        row.nonce === entry.nonce &&
                        row.ts === entry.ts &&
                        row.amount === entry.amount,
                    ) ?? { ...entry, signature: null }
                  }
                  decimals={chain.decimals}
                  cluster={cluster}
                  rpcUrl={rpcUrl}
                />
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
    gap: 16,
    alignSelf: 'stretch',
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
