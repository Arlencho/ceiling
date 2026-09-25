import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii } from '../theme';
import { motionAllowed, useReducedMotion } from './motion';

export const REEL_HEIGHT = 56;

const WINDOW_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

const TONE = {
  brass: colors.brass,
  amber: colors.amber,
  paid: colors.paid,
  refused: colors.refused,
} as const;

export type ScoreReelTone = keyof typeof TONE;

type ScoreReelProps = {
  value: number;
  tone?: ScoreReelTone;
  accessibilityLabel?: string;
  height?: number;
};

function reelDigits(value: number): number[] {
  if (!Number.isFinite(value) || value <= 0) {
    return [0];
  }
  return Math.floor(value)
    .toString()
    .split('')
    .map((digit) => Number(digit));
}

function ReelDigit({
  digit,
  motionOn,
  color,
  height,
  index,
}: {
  digit: number;
  motionOn: boolean;
  color: string;
  height: number;
  index: number;
}) {
  const [offset] = useState(() => new Animated.Value(0));
  const end = -digit * height;

  useEffect(() => {
    if (!motionOn) {
      offset.setValue(end);
      return;
    }
    offset.setValue(0);
    const anim = Animated.timing(offset, {
      toValue: end,
      duration: 600,
      easing: Easing.bezier(0.34, 1.4, 0.64, 1),
      useNativeDriver: true,
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [end, motionOn, offset]);

  const fontSize = Math.round(height * 0.6);
  const width = Math.round(height * 0.72);

  return (
    <View
      testID={`score-digit-${index}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.window, { height, width }]}
    >
      <Animated.View style={{ transform: [{ translateY: motionOn ? offset : end }] }}>
        {WINDOW_DIGITS.map((face) => (
          <Text
            key={face}
            style={[
              styles.digit,
              {
                height,
                lineHeight: height,
                fontSize,
                color,
                width,
              },
            ]}
          >
            {face}
          </Text>
        ))}
      </Animated.View>
      <View style={styles.slot} />
    </View>
  );
}

export function ScoreReel({
  value,
  tone = 'brass',
  accessibilityLabel,
  height = REEL_HEIGHT,
}: ScoreReelProps) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const digits = reelDigits(value);
  const spoken = accessibilityLabel ?? String(digits.join(''));

  return (
    <View
      testID="score-reel"
      accessible
      accessibilityRole="text"
      accessibilityLabel={spoken}
      style={styles.row}
    >
      {digits.map((digit, index) => (
        <ReelDigit
          key={`${digits.length}-${index}`}
          index={index}
          digit={digit}
          motionOn={motionOn}
          color={TONE[tone]}
          height={height}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  window: {
    overflow: 'hidden',
    borderRadius: radii.reel,
    borderWidth: 1,
    borderColor: colors.brassLine,
    backgroundColor: colors.forestLift,
  },
  digit: {
    fontFamily: fonts.serifRegular,
    textAlign: 'center',
  },
  slot: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    height: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
});
