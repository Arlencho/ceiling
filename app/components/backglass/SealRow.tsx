import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

import { colors, fonts, space, touchTarget } from '../theme';

type SealRowProps = {
  text?: string;
  linkLabel?: string;
  href?: string;
  onPress?: () => void;
};

export function SealRow({
  text = 'Saved on the blockchain. Anyone can check it.',
  linkLabel = 'See it',
  href,
  onPress,
}: SealRowProps) {
  function open() {
    if (onPress) {
      onPress();
      return;
    }
    if (href) {
      Linking.openURL(href).catch(() => undefined);
    }
  }

  const canOpen = Boolean(onPress || href);

  return (
    <View style={styles.row}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.seal}
      >
        <Svg width={18} height={18} viewBox="0 0 24 24">
          <Path
            d="M20 6L9 17l-5-5"
            fill="none"
            stroke={colors.brass}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>
      <Text style={styles.text}>{text}</Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={linkLabel}
        accessibilityHint="Opens the record on the blockchain."
        accessibilityState={{ disabled: !canOpen }}
        disabled={!canOpen}
        onPress={open}
        style={styles.link}
      >
        <Text style={styles.linkText}>{linkLabel}</Text>
        <Svg width={16} height={16} viewBox="0 0 24 24">
          <Path
            d="M14 4h6v6M20 4L10 14M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"
            fill="none"
            stroke={colors.brass}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    minHeight: touchTarget,
  },
  seal: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.brassLine,
    backgroundColor: 'rgba(201, 162, 77, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.body,
  },
  link: {
    minHeight: touchTarget,
    minWidth: touchTarget,
    paddingHorizontal: space.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  linkText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.brass,
  },
});
