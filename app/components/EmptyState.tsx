import { StyleSheet, Text } from 'react-native';

import { colors } from './theme';

export function EmptyState({ children }: { children: string }) {
  return <Text style={styles.text}>{children}</Text>;
}

const styles = StyleSheet.create({
  text: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
  },
});
