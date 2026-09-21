import { useRouter } from 'expo-router';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { KIND_PAID, KIND_REFUSED } from '../lib/constants';
import { encodeDecisionId } from '../lib/exportRecord';
import { explorerTxUrl, formatBaseUnits, formatClock } from '../lib/format';
import { renderReason } from '../lib/reasons';
import type { LedgerRow } from '../lib/ring';
import { RefusalCard } from './RefusalCard';
import { colors, fonts } from './theme';

export function DecisionRow({
  row,
  decimals,
  cluster,
  rpcUrl,
  mandateAddress,
  perTxMax,
  variant = 'list',
}: {
  row: LedgerRow;
  decimals: number;
  cluster: string;
  rpcUrl: string;
  mandateAddress: string;
  perTxMax?: bigint;
  variant?: 'list' | 'today';
}) {
  const router = useRouter();
  const refused = row.kind === KIND_REFUSED;
  const paid = row.kind === KIND_PAID;
  const amount = formatBaseUnits(row.amount, decimals);
  const clock = formatClock(row.ts);
  const id = encodeDecisionId(mandateAddress, row);

  const openDetail = () => {
    router.push(`/decision/${encodeURIComponent(id)}`);
  };

  const openTx = () => {
    if (!row.signature) {
      return;
    }
    void Linking.openURL(explorerTxUrl(row.signature, cluster, rpcUrl));
  };

  if (refused && variant === 'today') {
    return (
      <RefusalCard
        row={row}
        decimals={decimals}
        perTxMax={perTxMax}
        compact
        onShare={openDetail}
      />
    );
  }

  if (refused) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Refused, recorded" onPress={openDetail}>
        <RefusalCard row={row} decimals={decimals} perTxMax={perTxMax} />
      </Pressable>
    );
  }

  if (!paid) {
    return null;
  }

  const reason = renderReason(row.reason, row.suggestedOverride, decimals);
  const txLabel = row.signature
    ? `transaction ${row.signature.slice(0, 4)}...${row.signature.slice(-4)}`
    : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Paid within rule ${amount}`}
      onPress={openDetail}
      style={styles.paid}
    >
      <Text style={styles.time}>{clock}</Text>
      <View style={styles.body}>
        <Text style={styles.say}>
          Paid <Text style={styles.italic}>within rule</Text>
        </Text>
        <Text style={styles.why}>
          {perTxMax != null
            ? `Under ${formatBaseUnits(perTxMax, decimals)}, cap not reached.`
            : reason.text === 'ok'
              ? 'Inside the rule.'
              : reason.text}
          {txLabel ? ' ' : ''}
        </Text>
        {txLabel ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={txLabel}
            onPress={openTx}
            hitSlop={6}
          >
            <Text style={styles.tx}>{txLabel}</Text>
          </Pressable>
        ) : (
          <Text style={styles.why}>
            This RPC did not return a transaction signature for this row. The row itself is from the
            on-chain ledger, not invented.
          </Text>
        )}
      </View>
      <Text style={styles.amt}>{amount}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  paid: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  time: {
    width: 44,
    color: colors.muted,
    fontSize: 12,
    fontWeight: '500',
    fontFamily: fonts.mono,
    paddingTop: 4,
  },
  body: {
    flex: 1,
    gap: 4,
  },
  say: {
    color: colors.text,
    fontSize: 22,
    fontFamily: fonts.serif,
    lineHeight: 24,
  },
  italic: {
    fontStyle: 'italic',
    color: colors.muted,
    fontFamily: fonts.serif,
  },
  why: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },
  tx: {
    color: colors.body,
    fontSize: 13,
    fontWeight: '500',
    textDecorationLine: 'underline',
    fontFamily: fonts.mono,
  },
  amt: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
    fontFamily: fonts.mono,
    paddingTop: 4,
  },
});
