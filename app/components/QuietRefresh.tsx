import type { ReactElement } from 'react';
import { RefreshControl, StyleSheet, Text, View, type RefreshControlProps } from 'react-native';

import { colors, fonts, space } from './theme';

export const READING_THE_CHAIN = 'Reading the chain.';

export function quietRefreshControl(onRefresh?: () => void): ReactElement<RefreshControlProps> | undefined {
  if (!onRefresh) {
    return undefined;
  }
  return (
    <RefreshControl
      refreshing={false}
      onRefresh={onRefresh}
      tintColor={colors.brass}
      colors={[colors.brass]}
      progressBackgroundColor={colors.bg}
    />
  );
}

export function QuietReading({ busy }: { busy: boolean }) {
  if (!busy) {
    return null;
  }
  return (
    <View style={styles.row} accessibilityLabel={READING_THE_CHAIN}>
      <View style={styles.dot} />
      <Text style={styles.text}>{READING_THE_CHAIN}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 22,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.brass,
  },
  text: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.muted,
  },
});
