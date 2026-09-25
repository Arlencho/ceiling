import { useId, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg';

import { colors, radii, space } from '../theme';
import { LampRow } from './Lamp';

type BrassFrameProps = {
  children?: ReactNode;
  chase?: boolean;
  padding?: number;
  accessibilityLabel?: string;
};

export function BrassFrame({ children, chase = false, padding = 14, accessibilityLabel }: BrassFrameProps) {
  const rawId = useId().replace(/:/g, '');
  const edgeId = `brass-edge-${rawId}`;
  const wellId = `brass-well-${rawId}`;
  const [box, setBox] = useState({ width: 0, height: 0 });
  const ready = box.width > 0 && box.height > 0;

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setBox((current) =>
          current.width === width && current.height === height ? current : { width, height },
        );
      }}
      style={[styles.outer, !ready && styles.outerFallback]}
    >
      {ready ? (
        <Svg width={box.width} height={box.height} style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={edgeId} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={colors.amber} />
              <Stop offset="0.35" stopColor={colors.brass} />
              <Stop offset="1" stopColor={colors.deepBrass} />
            </LinearGradient>
            <LinearGradient id={wellId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.forestLift} />
              <Stop offset="1" stopColor={colors.surface} />
            </LinearGradient>
          </Defs>
          <Rect
            x={0}
            y={0}
            width={box.width}
            height={box.height}
            rx={radii.frame}
            fill={`url(#${edgeId})`}
          />
          <Rect
            x={2}
            y={2}
            width={box.width - 4}
            height={box.height - 4}
            rx={radii.frameInner}
            fill={`url(#${wellId})`}
          />
        </Svg>
      ) : null}
      <View style={[styles.inner, { padding }, !ready && styles.innerFallback]}>
        {chase ? (
          <View style={styles.chase}>
            <LampRow />
          </View>
        ) : null}
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    borderRadius: radii.frame,
    overflow: 'hidden',
  },
  outerFallback: {
    backgroundColor: colors.brass,
  },
  inner: {
    margin: 2,
    borderRadius: radii.frameInner,
    gap: space.md,
  },
  innerFallback: {
    backgroundColor: colors.surface,
  },
  chase: {
    paddingHorizontal: space.xs,
  },
});
