import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from '../theme';
import { networkLabel } from './facts';

export function ClusterPill({ cluster }: { cluster: string }) {
  const label = networkLabel(cluster);
  if (label.length === 0) {
    return null;
  }
  return (
    <View accessibilityLabel={label} style={styles.pill}>
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.5)',
    borderRadius: radii.pill,
    paddingHorizontal: space.md,
    paddingVertical: 3,
  },
  text: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    color: colors.brass,
  },
});
