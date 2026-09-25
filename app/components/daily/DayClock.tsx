import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { Circle, Svg } from 'react-native-svg';

import { colors, fonts, radii, space } from '../theme';
import { motionAllowed, useReducedMotion } from '../backglass/motion';

const RADIUS = 26;
const CIRC = 2 * Math.PI * RADIUS;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function DayClock({
  day,
  total,
  leftValue,
  leftLabel,
  ended,
}: {
  day: number | null;
  total: number | null;
  leftValue: string;
  leftLabel: string;
  ended: boolean;
}) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const progress =
    day != null && total != null && total > 0 ? Math.min(1, Math.max(0, day / total)) : 0;
  const [offset] = useState(() => new Animated.Value(CIRC));
  const end = CIRC * (1 - progress);

  useEffect(() => {
    if (!motionOn) {
      offset.setValue(end);
      return;
    }
    offset.setValue(CIRC);
    const anim = Animated.timing(offset, {
      toValue: end,
      duration: 1200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [end, motionOn, offset]);

  const center = day != null ? String(day) : leftValue;
  const ringLabel =
    day != null && total != null
      ? `Day ${day} of ${total}. ${leftValue} ${leftLabel}`
      : `${leftValue} ${leftLabel}`;

  return (
    <View style={styles.card} accessibilityLabel={ringLabel}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.ring}
      >
        <Svg width={56} height={56} viewBox="0 0 64 64">
          <Circle cx={32} cy={32} r={RADIUS} fill="none" stroke="rgba(237, 230, 214, 0.12)" strokeWidth={6} />
          <AnimatedCircle
            cx={32}
            cy={32}
            r={RADIUS}
            fill="none"
            stroke={colors.brass}
            strokeWidth={6}
            strokeLinecap="round"
            strokeDasharray={`${CIRC} ${CIRC}`}
            strokeDashoffset={motionOn ? offset : end}
            rotation={-90}
            origin="32, 32"
          />
        </Svg>
        <View style={styles.center} pointerEvents="none">
          <Text style={styles.day}>{center}</Text>
          {day != null && total != null ? <Text style={styles.of}>{`OF ${total}`}</Text> : null}
        </View>
      </View>
      <View style={styles.copy}>
        <Text style={styles.kicker}>Day of rule</Text>
        <Text style={styles.left}>{ended ? 'The rule has ended' : `${leftValue} ${leftLabel}`}</Text>
        <Text style={styles.hint}>{ended ? 'Nothing more can leave' : 'then the rule ends'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    width: 56,
    height: 56,
  },
  card: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    paddingVertical: space.xl,
    paddingHorizontal: space.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    minHeight: 80,
  },
  center: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  day: {
    fontFamily: fonts.serifRegular,
    fontSize: 18,
    lineHeight: 20,
    color: colors.bone,
  },
  of: {
    fontFamily: fonts.sansBold,
    fontSize: 8,
    lineHeight: 10,
    letterSpacing: 0.6,
    color: colors.muted,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  left: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.bone,
  },
  hint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
});
