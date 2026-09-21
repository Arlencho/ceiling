import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from './theme';

export function ContextBar({
  title,
  subtitle,
  onSwitch,
}: {
  title: string;
  subtitle: string;
  onSwitch: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Switch rule, currently ${title}`}
      onPress={onSwitch}
      style={styles.bar}
    >
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.sub}>{subtitle}</Text>
      </View>
      <Text style={styles.sw}>{`switch \u2195`}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 6,
    minHeight: 48,
    gap: 12,
  },
  text: {
    flex: 1,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontFamily: fonts.serif,
  },
  sub: {
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
    marginTop: 5,
  },
  sw: {
    color: colors.body,
    fontSize: 12,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
});
