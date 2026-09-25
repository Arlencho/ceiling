import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Circle, Path, Svg } from 'react-native-svg';

import { colors, fonts, radii, space, touchTarget } from '../theme';
import { motionAllowed, useReducedMotion } from './motion';

type PlaqueProps = {
  date: string;
  title: string;
  detail: string;
  earned?: boolean;
  onShare?: () => void;
};

export function Plaque({ date, title, detail, earned = true, onShare }: PlaqueProps) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const [rise] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!motionOn) {
      rise.setValue(1);
      return;
    }
    rise.setValue(0);
    const anim = Animated.timing(rise, {
      toValue: 1,
      duration: 600,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: true,
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [motionOn, rise]);

  const showShare = earned && Boolean(onShare);

  return (
    <Animated.View
      accessible={!showShare}
      accessibilityLabel={earned ? `${date}. ${title}. ${detail}` : `Not yet: ${title}. ${detail}`}
      style={[
        styles.plate,
        earned ? styles.earned : styles.pending,
        {
          opacity: motionOn ? rise : 1,
          transform: [
            {
              translateY: motionOn
                ? rise.interpolate({ inputRange: [0, 1], outputRange: [10, 0] })
                : 0,
            },
          ],
        },
      ]}
    >
      {earned ? (
        <>
          <View style={[styles.rivet, styles.rivetTL]} />
          <View style={[styles.rivet, styles.rivetTR]} />
          <View style={[styles.rivet, styles.rivetBL]} />
          <View style={[styles.rivet, styles.rivetBR]} />
        </>
      ) : null}
      <View style={styles.copy}>
        <Text style={[styles.date, earned ? styles.dateEarned : styles.datePending]}>{date}</Text>
        <Text style={[styles.title, earned ? styles.titleEarned : styles.titlePending]}>{title}</Text>
        <Text style={[styles.detail, earned ? styles.detailEarned : styles.detailPending]}>{detail}</Text>
      </View>
      {showShare ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Share this plaque"
          onPress={onShare}
          style={styles.share}
        >
          <Svg width={18} height={18} viewBox="0 0 24 24">
            <Circle cx={18} cy={5} r={3} fill="none" stroke={colors.ink} strokeWidth={2} />
            <Circle cx={6} cy={12} r={3} fill="none" stroke={colors.ink} strokeWidth={2} />
            <Circle cx={18} cy={19} r={3} fill="none" stroke={colors.ink} strokeWidth={2} />
            <Path
              d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"
              fill="none"
              stroke={colors.ink}
              strokeWidth={2}
              strokeLinecap="round"
            />
          </Svg>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  plate: {
    position: 'relative',
    borderRadius: radii.plaque,
    paddingVertical: space.xl,
    paddingLeft: space.xxxl,
    paddingRight: space.xxl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    minHeight: touchTarget,
  },
  earned: {
    backgroundColor: colors.brass,
    borderWidth: 1,
    borderColor: colors.deepBrass,
  },
  pending: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.brassSoft,
  },
  rivet: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.edgeMid,
  },
  rivetTL: { top: 6, left: 6 },
  rivetTR: { top: 6, right: 6 },
  rivetBL: { bottom: 6, left: 6 },
  rivetBR: { bottom: 6, right: 6 },
  copy: {
    flex: 1,
    gap: 3,
  },
  date: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  dateEarned: { color: colors.plaqueDate },
  datePending: { color: colors.muted },
  title: {
    fontSize: 19,
    lineHeight: 22,
  },
  titleEarned: {
    fontFamily: fonts.serif,
    color: colors.ink,
  },
  titlePending: {
    fontFamily: fonts.serifRegular,
    color: colors.body,
  },
  detail: {
    fontSize: 12,
    lineHeight: 16,
  },
  detailEarned: {
    fontFamily: fonts.sansSemibold,
    color: colors.inkSoft,
  },
  detailPending: {
    fontFamily: fonts.sans,
    color: colors.muted,
  },
  share: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15, 26, 22, 0.14)',
  },
});
