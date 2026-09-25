import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from '../theme';
import { Lamp } from './Lamp';
import { motionAllowed, useReducedMotion } from './motion';

type TiltStampProps = {
  reason?: string;
};

export function TiltStamp({ reason = 'Refused: over your limit' }: TiltStampProps) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const [jolt] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!motionOn) {
      jolt.setValue(0);
      return;
    }
    jolt.setValue(0);
    const anim = Animated.sequence([
      Animated.timing(jolt, { toValue: -5, duration: 90, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(jolt, { toValue: 5, duration: 90, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(jolt, { toValue: -3, duration: 90, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(jolt, { toValue: 0, duration: 90, easing: Easing.linear, useNativeDriver: true }),
    ]);
    anim.start();
    return () => {
      anim.stop();
    };
  }, [jolt, motionOn]);

  return (
    <Animated.View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Tilt. ${reason}`}
      style={[styles.plate, { transform: [{ translateX: motionOn ? jolt : 0 }] }]}
    >
      <Lamp state="on" size={14} litColor={colors.tilt} accessibilityLabel="Tilt lamp" />
      <Text style={styles.word}>Tilt</Text>
      <View style={styles.rule} />
      <Text style={styles.reason}>{reason}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  plate: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    minHeight: 44,
    paddingVertical: space.lg,
    paddingLeft: space.xxl,
    paddingRight: space.xxxl,
    borderRadius: radii.plaque,
    backgroundColor: colors.forestLift,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.7)',
  },
  word: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    lineHeight: 18,
    letterSpacing: 3.9,
    textTransform: 'uppercase',
    color: colors.tilt,
  },
  rule: {
    width: 1,
    height: 18,
    backgroundColor: 'rgba(201, 162, 77, 0.4)',
  },
  reason: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
});
