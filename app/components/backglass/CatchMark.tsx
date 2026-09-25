import { Circle, Path, Svg } from 'react-native-svg';

import { colors } from '../theme';

const MARK_PATH = 'M16 14L50 80L84 14';

const VARIANTS = {
  color: {
    stroke: colors.brass,
    ballFill: colors.amber,
    ballStroke: colors.deepBrass,
    ballStrokeWidth: 2,
    label: 'Veto Catch mark',
  },
  bone: {
    stroke: colors.bone,
    ballFill: 'none',
    ballStroke: colors.bone,
    ballStrokeWidth: 4.5,
    label: 'Veto Catch mark, bone',
  },
  forest: {
    stroke: colors.forest,
    ballFill: 'none',
    ballStroke: colors.forest,
    ballStrokeWidth: 4.5,
    label: 'Veto Catch mark, forest',
  },
} as const;

export type CatchMarkVariant = keyof typeof VARIANTS;

type CatchMarkProps = {
  size?: number;
  variant?: CatchMarkVariant;
  accessibilityLabel?: string;
};

export function CatchMark({ size = 24, variant = 'color', accessibilityLabel }: CatchMarkProps) {
  const face = VARIANTS[variant];
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? face.label}
    >
      <Path
        d={MARK_PATH}
        fill="none"
        stroke={face.stroke}
        strokeWidth={9}
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
      <Circle
        cx={50}
        cy={37.4}
        r={12}
        fill={face.ballFill}
        stroke={face.ballStroke}
        strokeWidth={face.ballStrokeWidth}
      />
    </Svg>
  );
}
