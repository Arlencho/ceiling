import { StyleSheet, Text } from 'react-native';

import { colors, fonts } from './theme';

export function EmptyState({ children }: { children: string }) {
  return <Text style={styles.text}>{children}</Text>;
}

const styles = StyleSheet.create({
  text: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.sans,
  },
});
