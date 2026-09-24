import { useMemo, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from './theme';

export function CapRing({
  fraction,
  label,
  onFraction,
}: {
  fraction: number;
  label: string;
  onFraction: (fraction: number) => void;
}) {
  const [box, setBox] = useState({ width: 168, height: 168 });
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          onFraction(touchFraction(event.nativeEvent.locationX, event.nativeEvent.locationY, box));
        },
        onPanResponderMove: (event) => {
          onFraction(touchFraction(event.nativeEvent.locationX, event.nativeEvent.locationY, box));
        },
      }),
    [box, onFraction],
  );

  const turn = Math.min(1, Math.max(0, fraction));

  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={`Total cap ${label}`}
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
        const { width, height } = event.nativeEvent.layout;
        setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }}
      style={styles.ring}
      {...responder.panHandlers}
    >
      <View style={[styles.sweep, { transform: [{ rotate: `${turn * 360}deg` }] }]} />
      <View style={styles.hole}>
        <Text style={styles.value}>{label}</Text>
        <Text style={styles.caption}>total cap</Text>
      </View>
    </View>
  );
}

function touchFraction(
  x: number,
  y: number,
  size: { width: number; height: number },
): number {
  const dx = x - size.width / 2;
  const dy = y - size.height / 2;
  const fromTop = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
  return fromTop / (Math.PI * 2);
}

const styles = StyleSheet.create({
  ring: {
    alignSelf: 'center',
    width: 168,
    height: 168,
    borderRadius: 84,
    borderWidth: 10,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sweep: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.brass,
    top: 6,
  },
  hole: {
    alignItems: 'center',
  },
  value: {
    color: colors.text,
    fontSize: 28,
    fontFamily: fonts.serif,
  },
  caption: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 4,
  },
});
