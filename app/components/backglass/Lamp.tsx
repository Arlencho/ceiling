import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { colors } from '../theme';
import { motionAllowed, useReducedMotion } from './motion';

export type LampState = 'on' | 'off' | 'pulse';

type LampProps = {
  state: LampState;
  size?: number;
  delayMs?: number;
  litColor?: string;
  accessibilityLabel?: string;
  testID?: string;
};

const PULSE_STILL = colors.brass;

export function Lamp({
  state,
  size = 8,
  delayMs = 0,
  litColor = colors.amber,
  accessibilityLabel,
  testID,
}: LampProps) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (state !== 'pulse' || !motionOn) {
      pulse.setValue(state === 'off' ? 0 : 1);
      return;
    }
    pulse.setValue(0);
    const cycle = Animated.sequence([
      Animated.timing(pulse, {
        toValue: 1,
        duration: 192,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(pulse, {
        toValue: 0,
        duration: 528,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.delay(1680),
    ]);
    const play = Animated.sequence([Animated.delay(delayMs), Animated.loop(cycle)]);
    play.start();
    return () => play.stop();
  }, [delayMs, motionOn, pulse, state]);

  const pulsing = state === 'pulse' && motionOn;
  const backgroundColor = pulsing
    ? pulse.interpolate({
        inputRange: [0, 1],
        outputRange: [colors.lampOff, colors.amber],
      })
    : state === 'off'
      ? colors.lampOff
      : state === 'pulse'
        ? PULSE_STILL
        : litColor;

  const label =
    accessibilityLabel ?? (state === 'pulse' ? 'Lamp pulsing' : state === 'on' ? 'Lamp on' : 'Lamp off');

  return (
    <Animated.View
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[
        styles.lamp,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor,
          borderColor: state === 'off' ? 'transparent' : colors.deepBrass,
        },
      ]}
    />
  );
}

export function LampRow({ count = 10, state = 'pulse' }: { count?: number; state?: LampState }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.row}
    >
      {Array.from({ length: count }, (_, index) => (
        <Lamp key={index} state={state} delayMs={index * 200} testID={`chase-lamp-${index}`} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  lamp: {
    borderWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
});
