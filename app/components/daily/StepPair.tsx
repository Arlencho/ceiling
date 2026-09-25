import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii } from '../theme';

export function StepPair({
  downLabel,
  upLabel,
  onDown,
  onUp,
  disabled = false,
}: {
  downLabel: string;
  upLabel: string;
  onDown: () => void;
  onUp: () => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={downLabel}
        disabled={disabled}
        onPress={onDown}
        style={[styles.step, styles.down, disabled && styles.disabled]}
      >
        <Text style={styles.downText}>-</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={upLabel}
        disabled={disabled}
        onPress={onUp}
        style={[styles.step, styles.up, disabled && styles.disabled]}
      >
        <Text style={styles.upText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 4,
  },
  step: {
    width: 44,
    height: 44,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  down: {
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.55)',
    backgroundColor: 'transparent',
  },
  up: {
    backgroundColor: colors.brass,
  },
  downText: {
    fontFamily: fonts.sans,
    fontSize: 22,
    lineHeight: 24,
    color: colors.brass,
  },
  upText: {
    fontFamily: fonts.sans,
    fontSize: 22,
    lineHeight: 24,
    color: colors.forest,
  },
  disabled: {
    opacity: 0.4,
  },
});
