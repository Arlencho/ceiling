import { Pressable, StyleSheet, Text } from 'react-native';

import { colors } from './theme';

export function Button({
  label,
  accessibilityLabel,
  onPress,
  busy = false,
  disabled = false,
  invert = true,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  invert?: boolean;
}) {
  const isDisabled = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        invert ? styles.invert : styles.outline,
        pressed && styles.pressed,
        isDisabled && styles.busy,
      ]}
    >
      <Text style={invert ? styles.invertLabel : styles.outlineLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: 12,
    minWidth: 200,
    paddingHorizontal: 28,
    paddingVertical: 14,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  invert: {
    backgroundColor: colors.invert,
  },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.invert,
  },
  pressed: {
    opacity: 0.7,
  },
  busy: {
    opacity: 0.5,
  },
  invertLabel: {
    color: colors.invertText,
    fontSize: 17,
    fontWeight: '600',
  },
  outlineLabel: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
  },
});
