import { StyleSheet, Text, View } from 'react-native';

import { ADVISORY_DECLINE_LABEL, ADVISORY_DETAIL_LINE } from '../lib/advisory';
import { colors, fonts } from './theme';

export function AdvisoryDeclineDetail({
  when,
  reason,
  amount,
}: {
  when: string;
  reason: string;
  amount: string;
}) {
  return (
    <View style={styles.block} accessibilityLabel={ADVISORY_DECLINE_LABEL}>
      <Text style={styles.eyebrow}>{when}</Text>
      <Text style={styles.say}>{ADVISORY_DECLINE_LABEL}</Text>
      {reason ? <Text style={styles.reason}>{reason}</Text> : null}
      <Text style={styles.amount}>{amount}</Text>
      <Text style={styles.line}>{ADVISORY_DETAIL_LINE}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 8,
    paddingLeft: 12,
    borderLeftWidth: 3,
    borderLeftColor: colors.brass,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  say: {
    color: colors.brass,
    fontSize: 32,
    fontFamily: fonts.serif,
    lineHeight: 36,
  },
  reason: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 21,
  },
  amount: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
  line: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 21,
  },
});
