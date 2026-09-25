import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { BrassFrame } from '../backglass/BrassFrame';
import { Lamp } from '../backglass/Lamp';
import { motionAllowed, useReducedMotion } from '../backglass/motion';
import { colors, fonts, radii, space } from '../theme';

export function ScanFrame({
  children,
  caption,
}: {
  children?: ReactNode;
  caption: string;
}) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const [travel] = useState(() => new Animated.Value(motionOn ? 0 : 118));

  useEffect(() => {
    if (!motionOn) {
      travel.setValue(118);
      return;
    }
    travel.setValue(0);
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(travel, {
          toValue: 220,
          duration: 2800,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(travel, { toValue: 0, duration: 1, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => {
      anim.stop();
    };
  }, [motionOn, travel]);

  return (
    <BrassFrame padding={14}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.lamps}
      >
        {Array.from({ length: 10 }, (_, index) => (
          <Lamp key={index} state="pulse" delayMs={index * 200} testID={`scan-lamp-${index}`} />
        ))}
      </View>
      <View
        accessibilityRole="image"
        accessibilityLabel="Camera view. Brass corner marks show where to hold the code."
        style={styles.well}
      >
        {children}
        <View pointerEvents="none" style={styles.marks}>
          <View style={[styles.corner, styles.nw]} />
          <View style={[styles.corner, styles.ne]} />
          <View style={[styles.corner, styles.sw]} />
          <View style={[styles.corner, styles.se]} />
          <Animated.View
            style={[styles.scan, { transform: [{ translateY: motionOn ? travel : 118 }] }]}
          />
          <Text style={styles.caption}>{caption}</Text>
        </View>
      </View>
    </BrassFrame>
  );
}

const styles = StyleSheet.create({
  lamps: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.xs,
  },
  well: {
    height: 240,
    borderRadius: radii.plaque,
    overflow: 'hidden',
    backgroundColor: '#0B1411',
    borderWidth: 1,
    borderColor: 'rgba(237, 230, 214, 0.10)',
  },
  marks: {
    ...StyleSheet.absoluteFill,
  },
  corner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: colors.brass,
  },
  nw: {
    left: 14,
    top: 14,
    borderLeftWidth: 3,
    borderTopWidth: 3,
    borderTopLeftRadius: 8,
  },
  ne: {
    right: 14,
    top: 14,
    borderRightWidth: 3,
    borderTopWidth: 3,
    borderTopRightRadius: 8,
  },
  sw: {
    left: 14,
    bottom: 14,
    borderLeftWidth: 3,
    borderBottomWidth: 3,
    borderBottomLeftRadius: 8,
  },
  se: {
    right: 14,
    bottom: 14,
    borderRightWidth: 3,
    borderBottomWidth: 3,
    borderBottomRightRadius: 8,
  },
  scan: {
    position: 'absolute',
    left: 14,
    right: 14,
    top: 8,
    height: 2,
    backgroundColor: colors.amber,
  },
  caption: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    textAlign: 'center',
    fontFamily: fonts.sansBold,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
});
