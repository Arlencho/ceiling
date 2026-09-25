import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from './theme';

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
      <Text style={styles.sw}>Switch rule</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    minHeight: 48,
    gap: space.xl,
  },
  text: {
    flex: 1,
  },
  title: {
    color: colors.bone,
    fontSize: 20,
    lineHeight: 24,
    fontFamily: fonts.serif,
  },
  sub: {
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    fontFamily: fonts.sansBold,
    marginTop: space.xs,
  },
  sw: {
    color: colors.brass,
    fontSize: 13,
    fontFamily: fonts.sansBold,
  },
});
