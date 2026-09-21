import { StyleSheet, Text } from 'react-native';

import { colors, fonts } from './theme';

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
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
    fontWeight: '400',
    letterSpacing: -0.3,
  },
  section: {
    color: colors.text,
    fontSize: 18,
    fontFamily: fonts.serif,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
});
