import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, fonts } from './theme';

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  editable = true,
  accessibilityLabel,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  editable?: boolean;
  accessibilityLabel?: string;
  multiline?: boolean;
}) {
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
        style={[styles.input, multiline && styles.multiline]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
    alignSelf: 'stretch',
  },
  label: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  input: {
    backgroundColor: 'transparent',
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 6,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontFamily: fonts.sans,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
});
