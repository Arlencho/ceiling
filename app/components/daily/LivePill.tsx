import { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from '../theme';
import { motionAllowed, useReducedMotion } from '../backglass/motion';

export function LivePill({ label, tone = 'live' }: { label: string; tone?: 'live' | 'stopped' }) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const live = tone === 'live';
  const [glow] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!live || !motionOn) {
      glow.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 0.45, duration: 1500, useNativeDriver: true }),
        Animated.timing(glow, { toValue: 1, duration: 1500, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => {
      anim.stop();
    };
  }, [glow, live, motionOn]);

  const color = live ? colors.paid : colors.tilt;
  return (
    <View
      accessibilityLabel={label}
      style={[styles.pill, live ? styles.live : styles.stopped]}
    >
      {live ? (
        <Animated.View style={[styles.dot, { backgroundColor: color, opacity: motionOn ? glow : 1 }]} />
      ) : (
        <View style={[styles.dot, styles.hollow]} />
      )}
      <Text style={[styles.text, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    height: 30,
    paddingHorizontal: space.xl,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  live: {
    backgroundColor: 'rgba(156, 201, 168, 0.10)',
    borderColor: 'rgba(156, 201, 168, 0.45)',
  },
  stopped: {
    backgroundColor: 'rgba(242, 185, 75, 0.10)',
    borderColor: 'rgba(242, 185, 75, 0.5)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  hollow: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.tilt,
  },
  text: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
});
