import { StyleSheet, Text, View } from 'react-native';

import { ADVISORY_DECLINE_LABEL, ADVISORY_DETAIL_LINE } from '../lib/advisory';
import { colors, fonts, radii } from './theme';

export function AdvisoryDeclineDetail({
  when,
  reason,
  amount,
}: {
  when: string;
  reason: string;
  amount: string;
}) {
  const title = reason.trim().length > 0
    ? `Your agent declined on its own: ${reason.trim()}`
    : 'Your agent declined on its own';
  return (
    <View style={styles.block} accessibilityLabel={ADVISORY_DECLINE_LABEL}>
      <Text style={styles.badge}>{"Your agent's own note"}</Text>
      <Text style={styles.when}>{when}</Text>
      <Text style={styles.say}>{title}</Text>
      <Text style={styles.amount}>{amount}</Text>
      <Text style={styles.line}>Not a refusal by the rule. Your agent signed this note itself.</Text>
      <Text style={styles.line}>{ADVISORY_DETAIL_LINE}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 8,
    padding: 14,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(237, 230, 214, 0.35)',
  },
  badge: {
    alignSelf: 'flex-start',
    color: colors.body,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    borderWidth: 1,
    borderColor: 'rgba(237, 230, 214, 0.3)',
    borderRadius: radii.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  when: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
  },
  say: {
    color: colors.bone,
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
  },
  amount: {
    color: colors.bone,
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
  },
  line: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 21,
  },
});
