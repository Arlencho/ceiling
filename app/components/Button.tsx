import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, fonts } from './theme';

export function Button({
  label,
  accessibilityLabel,
  onPress,
  busy = false,
  disabled = false,
  invert = true,
  quiet = false,
  onBone = false,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  invert?: boolean;
  quiet?: boolean;
  onBone?: boolean;
}) {
  const isDisabled = busy || disabled;
  const inverted = invert && !quiet && !onBone;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        inverted ? styles.invert : styles.outline,
        onBone && styles.onBone,
        quiet && styles.quiet,
        pressed && styles.pressed,
        isDisabled && styles.busy,
      ]}
    >
      <Text
        style={
          onBone ? styles.onBoneLabel : inverted ? styles.invertLabel : styles.outlineLabel
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: 6,
    minHeight: 48,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: colors.line,
  },
  invert: {
    backgroundColor: colors.invert,
    borderColor: colors.invert,
  },
  outline: {
    backgroundColor: 'transparent',
    borderColor: colors.line,
  },
  quiet: {
    backgroundColor: 'transparent',
    borderColor: colors.line,
  },
  pressed: {
    opacity: 0.7,
  },
  busy: {
    opacity: 0.5,
  },
  invertLabel: {
    color: colors.invertText,
    fontSize: 16,
    fontWeight: '600',
    fontFamily: fonts.sans,
  },
  outlineLabel: {
    color: colors.body,
    fontSize: 16,
    fontWeight: '500',
    fontFamily: fonts.sans,
  },
  onBone: {
    backgroundColor: colors.bg,
    borderColor: colors.bg,
  },
  onBoneLabel: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    fontFamily: fonts.sans,
  },
});
