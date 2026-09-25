import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { colors, radii } from '../theme';
import { motionAllowed, useReducedMotion } from './motion';

export const BLOCK_COUNT = 30;

export function blockFills(remaining: number, cap: number, blocks = BLOCK_COUNT): number[] {
  const count = Math.max(0, Math.floor(blocks));
  const fills = Array.from({ length: count }, () => 0);
  if (!(cap > 0) || count === 0) {
    return fills;
  }
  const clamped = Math.min(Math.max(remaining, 0), cap);
  const exact = (clamped / cap) * count;
  for (let index = 0; index < count; index += 1) {
    const raw = exact - index;
    fills[index] = raw >= 1 ? 1 : raw > 0 ? raw : 0;
  }
  return fills;
}

type BlockBarProps = {
  remaining: number;
  cap: number;
  blocks?: number;
  accessibilityLabel?: string;
};

export function BlockBar({ remaining, cap, blocks = BLOCK_COUNT, accessibilityLabel }: BlockBarProps) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const fills = blockFills(remaining, cap, blocks);
  const shownRemaining = cap > 0 ? Math.min(Math.max(remaining, 0), cap) : 0;
  const [cover] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!motionOn) {
      cover.setValue(0);
      return;
    }
    cover.setValue(1);
    const anim = Animated.timing(cover, {
      toValue: 0,
      duration: 1100,
      easing: Easing.bezier(0.65, 0, 0.35, 1),
      useNativeDriver: true,
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [cap, cover, motionOn, remaining]);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel ?? `${shownRemaining} remaining of ${cap}`}
      accessibilityValue={{ min: 0, max: Math.max(cap, 0), now: shownRemaining }}
      style={styles.track}
    >
      {fills.map((amount, index) => (
        <View key={index} testID={`block-${index}`} style={styles.block}>
          <View
            testID={`block-fill-${index}`}
            style={[styles.fill, { width: `${Math.round(amount * 100)}%` }]}
          />
        </View>
      ))}
      {motionOn ? (
        <Animated.View
          testID="block-cover"
          pointerEvents="none"
          style={[styles.cover, { transform: [{ scaleX: cover }] }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 3,
    height: 14,
  },
  block: {
    flex: 1,
    borderRadius: radii.bar,
    backgroundColor: colors.blockOff,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: colors.brass,
  },
  cover: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    transformOrigin: 'right',
  },
});
