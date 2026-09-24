import { StyleSheet, Text, View } from 'react-native';

import { REASON_OVER_PER_TX_MAX } from '../lib/constants';
import { formatBaseUnits } from '../lib/format';
import { refusalWhyLine } from '../lib/reasons';
import type { LedgerRow } from '../lib/ring';
import { Button } from './Button';
import { colors, fonts } from './theme';

export function RefusalCard({
  row,
  decimals,
  perTxMax,
  compact = false,
  onShare,
  proof,
}: {
  row: LedgerRow;
  decimals: number;
  perTxMax?: bigint;
  compact?: boolean;
  onShare?: () => void;
  proof?: string;
}) {
  const why = refusalWhyLine({
    reason: row.reason,
    amount: row.amount,
    suggestedOverride: row.suggestedOverride,
    decimals,
    perTxMax,
  });

  return (
    <View style={styles.card} accessibilityLabel="Refused, recorded on chain">
      <View style={styles.eyebrow}>
        <Text style={styles.eyebrowText}>Refused</Text>
        <Text style={styles.stamp}>Recorded on chain</Text>
      </View>
      <Text style={[styles.say, compact && styles.saySmall]}>
        {`Your rule held.\nNo payment made.`}
      </Text>
      <Text style={styles.why}>{why}</Text>
      {row.reason === REASON_OVER_PER_TX_MAX && row.suggestedOverride > 0n ? (
        <View style={styles.override}>
          <View style={styles.overrideText}>
            <Text style={styles.overrideK}>Override that would clear it</Text>
            <Text style={styles.overrideHint}>allow this one payment of</Text>
          </View>
          <Text style={styles.overrideV}>{formatBaseUnits(row.suggestedOverride, decimals)}</Text>
        </View>
      ) : null}
      {proof ? <Text style={styles.proof}>{proof}</Text> : null}
      {onShare ? (
        <View style={styles.share}>
          <Button
            label="Share this decision"
            accessibilityLabel="Share this decision"
            onPress={onShare}
            onBone
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.invert,
    borderRadius: 6,
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 8,
    alignSelf: 'stretch',
  },
  eyebrow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  eyebrowText: {
    color: colors.invertText,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  stamp: {
    color: colors.brassInk,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  say: {
    color: colors.invertText,
    fontSize: 34,
    lineHeight: 36,
    fontFamily: fonts.serif,
    letterSpacing: -0.5,
    marginTop: 4,
  },
  saySmall: {
    fontSize: 30,
    lineHeight: 32,
  },
  why: {
    color: colors.inkOnBone,
    fontSize: 15,
    lineHeight: 21,
    fontFamily: fonts.sans,
  },
  override: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(15, 26, 22, 0.18)',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: 12,
  },
  overrideText: {
    flex: 1,
  },
  overrideK: {
    color: colors.brassInk,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  overrideHint: {
    color: colors.inkOnBone,
    fontSize: 13,
    fontWeight: '500',
    marginTop: 4,
  },
  overrideV: {
    color: colors.brassInk,
    fontSize: 32,
    fontFamily: fonts.serif,
    lineHeight: 34,
  },
  proof: {
    color: colors.inkOnBone,
    fontSize: 12,
    fontWeight: '500',
    fontFamily: fonts.mono,
    marginTop: 4,
  },
  share: {
    marginTop: 6,
  },
});
