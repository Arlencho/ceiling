import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, fonts, radii, space } from './theme';
import { useScrollFocusedField } from './RuleScreen';

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  editable = true,
  accessibilityLabel,
  multiline = false,
  hint,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  editable?: boolean;
  accessibilityLabel?: string;
  multiline?: boolean;
  hint?: string;
}) {
  const scrollFocused = useScrollFocusedField();
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={accessibilityLabel ?? label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        editable={editable}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        onFocus={(event) => {
          const target = event.nativeEvent.target;
          if (typeof target === 'number') {
            scrollFocused(target);
          }
        }}
        style={[styles.input, multiline && styles.multiline, !editable && styles.locked]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.sm,
    alignSelf: 'stretch',
  },
  label: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: fonts.sansBold,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radii.control,
    color: colors.bone,
    fontSize: 16,
    lineHeight: 22,
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
    fontFamily: fonts.sansSemibold,
    minHeight: 48,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  locked: {
    opacity: 0.7,
  },
  hint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: fonts.sans,
  },
});
