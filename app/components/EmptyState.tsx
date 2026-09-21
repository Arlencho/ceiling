import { StyleSheet, Text } from 'react-native';

import { colors, fonts } from './theme';

export function EmptyState({ children }: { children: string }) {
  return <Text style={styles.text}>{children}</Text>;
}

const styles = StyleSheet.create({
  text: {
    color: colors.body,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.sans,
  },
});
