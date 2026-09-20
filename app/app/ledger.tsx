import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ConnectGate } from '../components/ConnectGate';
import { DecisionRow } from '../components/DecisionRow';
import { EmptyState } from '../components/EmptyState';
import { Screen } from '../components/Screen';
import { ScreenTitle } from '../components/SectionTitle';
import { colors } from '../components/theme';
import { newestFirst } from '../lib/format';
import { useChain } from '../lib/useChain';

export default function LedgerScreen() {
  const chain = useChain();
  const rpcUrl = chain.config?.rpcUrl ?? '';
  const cluster = chain.config?.explorerCluster ?? 'devnet';
  const rows = newestFirst(chain.rows);

  const refresh = chain.refresh;
  const onRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <ScreenTitle>Ledger</ScreenTitle>
      <EmptyState>
        Every decision, with the reason in plain language. A refusal is a first-class outcome, equal
        in weight to a payment, not an error. Open a row to check the transaction in an explorer.
      </EmptyState>
      <ConnectGate>
        {chain.configError ? <EmptyState>{chain.configError}</EmptyState> : null}
        {chain.error ? <Text style={styles.error}>{chain.error}</Text> : null}
        {!chain.mandate ? (
          <EmptyState>
            No mandate on chain for this owner. Only mandates that actually ran appear here. This
            screen never invents rows.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>
            No decisions on this mandate yet. This screen reads the on-chain ring and never invents
            rows.
          </EmptyState>
        ) : (
          <View style={styles.list}>
            {rows.map((row, index) => (
              <DecisionRow
                key={`${row.ts.toString()}-${row.kind}-${row.nonce.toString()}-${index}`}
                row={row}
                decimals={chain.decimals}
                cluster={cluster}
                rpcUrl={rpcUrl}
              />
            ))}
          </View>
        )}
      </ConnectGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 12,
    alignSelf: 'stretch',
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
