import { Pressable, StyleSheet, Text, View } from 'react-native';

import { renewalBanner } from '../../lib/renewal';
import type { MandateAccount } from '../../lib/mandate';
import { colors, fonts, radii, space, touchTarget } from '../theme';

export function RenewalBanner({
  mandate,
  decimals,
  nowSec,
  onOpen,
}: {
  mandate: MandateAccount;
  decimals: number;
  nowSec: bigint;
  onOpen: () => void;
}) {
  const copy = renewalBanner(mandate, decimals, nowSec);
  if (!copy) {
    return null;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${copy.title} ${copy.body}`}
      onPress={onOpen}
      style={styles.banner}
    >
      <Text style={styles.kicker}>Rule ending soon</Text>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      <Text style={styles.link}>See what happened</Text>
    </Pressable>
  );
}

export function HomeStay({
  mandate,
  decimals,
  nowSec,
  onRenew,
  onQuietNote,
}: {
  mandate: MandateAccount;
  decimals: number;
  nowSec: bigint;
  onRenew: () => void;
  onQuietNote: () => void;
}) {
  return (
    <View style={styles.wrap}>
      <RenewalBanner mandate={mandate} decimals={decimals} nowSec={nowSec} onOpen={onRenew} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="A quiet note each day. One line, at a time you choose, and never more than one."
        onPress={onQuietNote}
        style={styles.quiet}
      >
        <View style={styles.quietCopy}>
          <Text style={styles.quietTitle}>A quiet note each day</Text>
          <Text style={styles.quietBody}>One line, at a time you choose, and never more than one.</Text>
        </View>
        <Text style={styles.link}>Open</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.lg,
    alignSelf: 'stretch',
  },
  banner: {
    gap: 4,
    paddingVertical: space.xl,
    paddingHorizontal: space.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    minHeight: touchTarget,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  title: {
    fontFamily: fonts.serifRegular,
    fontSize: 22,
    lineHeight: 26,
    color: colors.bone,
  },
  body: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
  link: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    lineHeight: 18,
    color: colors.brass,
    marginTop: 2,
  },
  quiet: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.lg,
    paddingHorizontal: space.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  quietCopy: {
    flex: 1,
    gap: 2,
  },
  quietTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.bone,
  },
  quietBody: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
});
