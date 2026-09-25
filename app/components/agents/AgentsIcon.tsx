import { Circle, Path, Rect, Svg } from 'react-native-svg';

export function AgentsIcon({ color, size = 22 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect
        x={4}
        y={8}
        width={16}
        height={12}
        rx={3}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
      />
      <Path d="M12 4v4" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Circle cx={12} cy={3} r={1} fill={color} />
      <Path d="M9 14h0.01M15 14h0.01" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  );
}
