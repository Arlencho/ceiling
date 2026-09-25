import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from '../theme';
import { HoldSteps, HoldTop } from './chrome';

export function LiveScreen({
  network,
  amountLabel,
  tokenName,
  dailyLabel,
  waitLabel,
  guardianLabel,
  safeLabel,
  onBack,
  onDone,
}: {
  network: string;
  amountLabel: string;
  tokenName: string;
  dailyLabel: string;
  waitLabel: string;
  guardianLabel: string;
  safeLabel: string;
  onBack: () => void;
  onDone: () => void;
}) {
  return (
    <View style={styles.wrap}>
      <HoldTop title="New Hold vault" network={network} onBack={onBack} />
      <HoldSteps current={3} />
      <Text style={styles.h1}>Your vault is live.</Text>
      <Text style={styles.body}>
        {amountLabel} {tokenName} is in your vault. The everyday door is {dailyLabel} a day. Anything else
        waits {waitLabel}. Guardian key {guardianLabel}. Safe address {safeLabel}.
      </Text>
      <Text style={styles.body}>
        Tightening these rules is instant. Loosening them waits {waitLabel}, so a thief cannot switch the
        protection off first.
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Done" onPress={onDone} style={styles.cta}>
        <Text style={styles.ctaText}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xl },
  h1: { color: colors.bone, fontFamily: fonts.serifRegular, fontSize: 34, lineHeight: 38 },
  body: { color: colors.body, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22 },
  cta: {
    height: 56,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: { color: colors.forest, fontFamily: fonts.sansBold, fontSize: 17 },
});
