import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space, touchTarget } from '../theme';

type StatTileProps = {
  value: string;
  label: string;
  valueColor?: string;
  suffix?: string;
};

export function StatTile({ value, label, valueColor = colors.bone, suffix }: StatTileProps) {
  const spoken = suffix ? `${value} ${suffix}, ${label}` : `${value}, ${label}`;
  return (
    <View accessible accessibilityLabel={spoken} style={styles.tile}>
      <Text style={[styles.value, { color: valueColor }]}>
        {value}
        {suffix ? <Text style={styles.suffix}> {suffix}</Text> : null}
      </Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minHeight: touchTarget,
    gap: 2,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radii.stat,
    backgroundColor: 'rgba(15, 26, 22, 0.55)',
    borderWidth: 1,
    borderColor: colors.boneLine,
  },
  value: {
    fontFamily: fonts.serifRegular,
    fontSize: 24,
    lineHeight: 24,
  },
  suffix: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 14,
    color: colors.muted,
  },
  label: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 14,
    color: colors.muted,
  },
});
