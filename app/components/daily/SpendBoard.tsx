import { StyleSheet, Text, View } from 'react-native';

import { BlockBar } from '../backglass/BlockBar';
import { BrassFrame } from '../backglass/BrassFrame';
import { colors, fonts, space } from '../theme';
import { DimLamps } from './DimLamps';

export function SpendBoard({
  kicker,
  remainingText,
  ofText,
  spentText,
  spentCaption,
  remaining,
  cap,
  accessibilityLabel,
  leftCaption,
  rightCaption,
  aside,
  dimmed = false,
}: {
  kicker: string;
  remainingText: string;
  ofText: string;
  spentText: string;
  spentCaption: string;
  remaining: number;
  cap: number;
  accessibilityLabel: string;
  leftCaption: string;
  rightCaption: string;
  aside?: string;
  dimmed?: boolean;
}) {
  return (
    <BrassFrame accessibilityLabel={accessibilityLabel} padding={16}>
      {dimmed ? <DimLamps /> : null}
      <View style={styles.head}>
        <Text style={styles.kicker}>{kicker}</Text>
        {aside ? <Text style={styles.aside}>{aside}</Text> : null}
      </View>
      <View style={styles.figures}>
        <Text style={styles.remaining}>{remainingText}</Text>
        <Text style={styles.of}>{ofText}</Text>
        <Text style={styles.spent}>
          <Text style={styles.spentFigure}>{spentText}</Text>
          {` ${spentCaption}`}
        </Text>
      </View>
      <View style={dimmed ? styles.dim : undefined}>
        <BlockBar remaining={remaining} cap={cap} accessibilityLabel={accessibilityLabel} />
      </View>
      <View style={styles.captions}>
        <Text style={styles.caption}>{leftCaption}</Text>
        <Text style={styles.caption}>{rightCaption}</Text>
      </View>
    </BrassFrame>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.lg,
  },
  kicker: {
    flex: 1,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  aside: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
    textAlign: 'right',
  },
  figures: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.lg,
  },
  remaining: {
    fontFamily: fonts.serifLight,
    fontSize: 64,
    lineHeight: 64,
    letterSpacing: -1.2,
    color: colors.bone,
  },
  of: {
    fontFamily: fonts.serifLight,
    fontSize: 22,
    lineHeight: 26,
    color: colors.muted,
  },
  spent: {
    marginLeft: 'auto',
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
  spentFigure: {
    fontFamily: fonts.serif,
    fontSize: 18,
    lineHeight: 22,
    color: colors.bone,
  },
  dim: {
    opacity: 0.55,
  },
  captions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
  },
  caption: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
});
