import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii } from './theme';

export function RuleKindSwitch({
  kind,
  onChange,
}: {
  kind: 'payment' | 'trade';
  onChange: (kind: 'payment' | 'trade') => void;
}): ReactNode {
  return (
    <View style={styles.row} accessibilityRole="tablist">
      <Choice label="Payment rule" selected={kind === 'payment'} onPress={() => onChange('payment')} />
      <Choice label="Trade rule" selected={kind === 'trade'} onPress={() => onChange('trade')} />
    </View>
  );
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceOn]}
    >
      <Text style={[styles.label, selected && styles.labelOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  choice: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  choiceOn: {
    backgroundColor: colors.invert,
    borderColor: colors.invert,
  },
  label: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.text,
  },
  labelOn: {
    color: colors.invertText,
  },
});
