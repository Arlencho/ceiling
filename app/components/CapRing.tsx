import { useMemo, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from './theme';
import { StepPair } from './daily/StepPair';

export function CapRing({
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
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.kicker}>Total ever</Text>
          <Text style={styles.hint}>Set aside now</Text>
        </View>
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
          style={styles.reel}
        >
          <Text style={styles.value}>{label}</Text>
          <View style={styles.slot} />
        </View>
        <StepPair
          downLabel="Lower total"
          upLabel="Raise total"
          onDown={() => onFraction(Math.max(0, turn - 0.02))}
          onUp={() => onFraction(Math.min(1, turn + 0.02))}
        />
      </View>
      <View
        onLayout={(event) => {
          const next = Math.max(1, event.nativeEvent.layout.width);
          setWidth((prev) => (prev === next ? prev : next));
        }}
        style={styles.track}
        {...responder.panHandlers}
      >
        <View style={[styles.fill, { width: `${turn * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: space.md,
    alignSelf: 'stretch',
    paddingVertical: space.sm,
    paddingLeft: space.xxl,
    paddingRight: space.sm,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    minHeight: 60,
  },
  copy: {
    flex: 1,
    gap: 3,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  hint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  reel: {
    minWidth: 52,
    height: 48,
    paddingHorizontal: space.lg,
    borderRadius: radii.reel,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.55)',
    backgroundColor: colors.reelWell,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  value: {
    fontFamily: fonts.serif,
    fontSize: 22,
    lineHeight: 26,
    color: colors.brass,
  },
  slot: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    height: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  track: {
    height: 28,
    justifyContent: 'center',
    marginRight: space.md,
  },
  fill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.brass,
  },
});
