import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { KIND_PAID, KIND_REFUSED } from '../lib/constants';
import { explorerTxUrl, formatBaseUnits, formatKindLabel, formatUnix } from '../lib/format';
import { renderReason } from '../lib/reasons';
import type { LedgerRow } from '../lib/ring';
import { truncateAddress } from '../lib/wallet';
import { colors } from './theme';

export function DecisionRow({
  row,
  decimals,
  cluster,
  rpcUrl,
}: {
  row: LedgerRow;
  decimals: number;
  cluster: string;
  rpcUrl: string;
}) {
  const refused = row.kind === KIND_REFUSED;
  const paid = row.kind === KIND_PAID;
  const reason = refused ? renderReason(row.reason, row.suggestedOverride, decimals) : null;
  const amount = formatBaseUnits(row.amount, decimals);
  const kind = formatKindLabel(row.kind);

  const onOpen = () => {
    if (!row.signature) {
      return;
    }
    void Linking.openURL(explorerTxUrl(row.signature, cluster, rpcUrl));
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${kind} ${amount}`}
      onPress={onOpen}
      disabled={!row.signature}
      style={styles.card}
    >
      <View style={styles.top}>
        <View style={[styles.kind, paid && styles.kindFilled, refused && styles.kindOutline]}>
          <Text style={paid ? styles.kindFilledText : styles.kindOutlineText}>{kind}</Text>
        </View>
        <Text style={styles.amount}>{amount}</Text>
      </View>
      <Text style={styles.meta}>{formatUnix(row.ts)}</Text>
      {reason ? (
        <Text style={styles.reason}>{reason.text}</Text>
      ) : null}
      {reason?.overrideLine ? (
        <Text style={styles.reason}>{reason.overrideLine}</Text>
      ) : null}
      <Text style={styles.meta}>
        {truncateAddress(row.counterparty)}
      </Text>
      {row.signature ? (
        <Text style={styles.link}>Open transaction in explorer</Text>
      ) : (
        <Text style={styles.meta}>
          This RPC did not return a transaction signature for this row. The row itself is from the
          on-chain ledger, not invented.
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    gap: 8,
    alignSelf: 'stretch',
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  kind: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    minWidth: 84,
    alignItems: 'center',
  },
  kindFilled: {
    backgroundColor: colors.invert,
  },
  kindOutline: {
    borderWidth: 1,
    borderColor: colors.invert,
    backgroundColor: 'transparent',
  },
  kindFilledText: {
    color: colors.invertText,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  kindOutlineText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  amount: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  reason: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  meta: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  link: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
});
