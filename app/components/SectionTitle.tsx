import { StyleSheet, Text } from 'react-native';

import { type } from './theme';

export function ScreenTitle({ children }: { children: string }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function SectionTitle({ children }: { children: string }) {
  return <Text style={styles.section}>{children}</Text>;
}

export function Eyebrow({ children }: { children: string }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

const styles = StyleSheet.create({
  title: {
    ...type.display,
    fontSize: 32,
    lineHeight: 36,
  },
  section: type.title,
  eyebrow: {
    ...type.kicker,
    textTransform: 'uppercase',
  },
});
