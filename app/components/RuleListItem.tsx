import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatBaseUnits, formatTimeLeft } from '../lib/format';
import type { MandateAccount } from '../lib/mandate';
import { displayPurpose, ruleStatusLabel, spendRatio } from '../lib/ruleView';
import { truncateAddress } from '../lib/wallet';
import { colors, fonts } from './theme';

export function RuleListItem({
  mandate,
  decimals,
  nowSec,
  current,
  onPress,
}: {
  mandate: MandateAccount;
  decimals: number;
  nowSec: bigint;
  current: boolean;
  onPress: () => void;
}) {
  const purpose = displayPurpose(mandate.purpose);
  const spent = formatBaseUnits(mandate.spent, decimals);
  const cap = formatBaseUnits(mandate.cap, decimals);
  const per = formatBaseUnits(mandate.perTxMax, decimals);
  const ratio = spendRatio(mandate.spent, mandate.cap);
  const status = ruleStatusLabel(mandate, nowSec, current);
  const time = formatTimeLeft(mandate.expiresAt, nowSec);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${purpose}, ${status}`}
      onPress={onPress}
      style={[styles.row, current && styles.current]}
    >
      <View style={styles.head}>
        <Text style={styles.purpose}>{purpose}</Text>
        <Text style={[styles.status, current && styles.statusCurrent]}>
          {current ? `current · ${time}` : `${status} · ${time}`}
        </Text>
      </View>
      <View style={styles.spent}>
        <Text style={styles.spentText}>
          {spent} spent <Text style={styles.dim}>of {cap}</Text>
        </Text>
        <Text style={styles.spentText}>{per} per payment</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.max(ratio * 100, mandate.spent > 0n ? 1 : 0)}%` }]} />
      </View>
      <View style={styles.agent}>
        <Text style={styles.agentText}>
          agent <Text style={styles.mono}>{truncateAddress(mandate.agent)}</Text>
        </Text>
        <Text style={styles.agentText}>pays {truncateAddress(mandate.merchant)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 13,
    paddingLeft: 14,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
    marginLeft: -16,
    gap: 8,
  },
  current: {
    borderLeftColor: colors.text,
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  purpose: {
    color: colors.text,
    fontSize: 24,
    fontFamily: fonts.serif,
    flex: 1,
  },
  status: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  statusCurrent: {
    color: colors.text,
  },
  spent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  spentText: {
    color: colors.body,
    fontSize: 13,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
  dim: {
    color: colors.muted,
  },
  track: {
    height: 2,
    backgroundColor: colors.line,
    alignSelf: 'stretch',
  },
  fill: {
    height: 2,
    backgroundColor: colors.text,
    minWidth: 0,
  },
  agent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  agentText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '500',
  },
  mono: {
    color: colors.body,
    fontFamily: fonts.mono,
  },
});
