import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, touchTarget } from '../theme';

type PillProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  dot?: string;
};

export function Pill({ label, selected = false, onPress, dot }: PillProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.pill, selected ? styles.selected : styles.idle]}
    >
      {dot ? (
        <View
          style={[
            styles.dot,
            dot === 'none'
              ? styles.dotOpen
              : { backgroundColor: dot },
          ]}
        />
      ) : null}
      <Text style={[styles.label, selected ? styles.labelSelected : styles.labelIdle]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: touchTarget,
    minWidth: touchTarget,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  selected: {
    backgroundColor: colors.brass,
    borderColor: colors.brass,
  },
  idle: {
    backgroundColor: colors.surface,
    borderColor: 'rgba(237, 230, 214, 0.22)',
  },
  label: {
    fontSize: 13,
    lineHeight: 16,
  },
  labelSelected: {
    fontFamily: fonts.sansBold,
    color: colors.forest,
  },
  labelIdle: {
    fontFamily: fonts.sansSemibold,
    color: colors.body,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotOpen: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.body,
  },
});
