import { useMemo, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from './theme';

export function MaxSlider({
  fraction,
  label,
  onFraction,
}: {
  fraction: number;
  label: string;
  onFraction: (fraction: number) => void;
}) {
  const [width, setWidth] = useState(1);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          onFraction(event.nativeEvent.locationX / width);
        },
        onPanResponderMove: (event) => {
          onFraction(event.nativeEvent.locationX / width);
        },
      }),
    [onFraction, width],
  );
  const turn = Math.min(1, Math.max(0, fraction));

  return (
    <View style={styles.block}>
      <Text style={styles.caption}>Largest payment {label}</Text>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel={`Largest payment ${label}`}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'increment') {
            onFraction(Math.min(1, turn + 0.02));
          }
          if (event.nativeEvent.actionName === 'decrement') {
            onFraction(Math.max(0, turn - 0.02));
          }
        }}
        onLayout={(event) => {
          const next = Math.max(1, event.nativeEvent.layout.width);
          setWidth((prev) => (prev === next ? prev : next));
        }}
        style={styles.track}
        {...responder.panHandlers}
      >
        <View style={[styles.fill, { width: `${turn * 100}%` }]} />
        <View style={[styles.thumb, { left: `${turn * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 8,
    alignSelf: 'stretch',
  },
  caption: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  track: {
    height: 36,
    justifyContent: 'center',
  },
  fill: {
    height: 2,
    backgroundColor: colors.brass,
  },
  thumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    marginLeft: -11,
    borderRadius: 11,
    backgroundColor: colors.invert,
  },
});
