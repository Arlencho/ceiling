import { StyleSheet, Text, View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

import { ScoreReel } from '../backglass/ScoreReel';
import { colors, fonts, radii, space } from '../theme';

export function StreakCall({ count }: { count: number }) {
  const quiet = count <= 0;
  return (
    <View style={[styles.row, quiet && styles.quiet]}>
      <ScoreReel
        value={count}
        tone="amber"
        accessibilityLabel={count === 1 ? '1 refusal in a row' : `${count} refusals in a row`}
      />
      <View style={styles.copy}>
        <Text style={styles.kicker}>Refusals in a row</Text>
        <Text style={styles.title}>
          {quiet ? 'None in a row' : 'Every one refused, no money moved'}
        </Text>
        <Text style={styles.detail}>
          {quiet ? 'A refusal is saved on the blockchain' : 'each one saved on the blockchain'}
        </Text>
      </View>
      <Svg width={22} height={22} viewBox="0 0 24 24" accessibilityElementsHidden>
        <Path
          d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"
          fill="none"
          stroke={colors.brass}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M9 12l2 2 4-4"
          fill="none"
          stroke={colors.brass}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxl,
    paddingVertical: space.xl,
    paddingHorizontal: space.xxxl,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.45)',
  },
  quiet: {
    borderColor: colors.line,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  title: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.bone,
  },
  detail: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
});
