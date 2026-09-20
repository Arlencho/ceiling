import { StyleSheet, Text } from 'react-native';

import { colors } from './theme';

export function ScreenTitle({ children }: { children: string }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function SectionTitle({ children }: { children: string }) {
  return <Text style={styles.section}>{children}</Text>;
}

const styles = StyleSheet.create({
  title: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  section: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
  },
});
