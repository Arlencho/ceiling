import { View } from 'react-native';

export function OverviewIcon({ color, size = 24 }: { color: string; size?: number }) {
  const bar = (h: number) => (
    <View
      style={{
        width: Math.max(3, Math.round(size / 8)),
        height: h,
        backgroundColor: color,
        borderRadius: 1,
      }}
    />
  );
  return (
    <View
      style={{
        width: size,
        height: size,
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 3,
        paddingBottom: 2,
      }}
    >
      {bar(size * 0.42)}
      {bar(size * 0.7)}
      {bar(size * 0.5)}
      {bar(size * 0.32)}
    </View>
  );
}

export function RulesIcon({ color, size = 24 }: { color: string; size?: number }) {
  const line = (w: number) => (
    <View
      style={{
        height: 1.5,
        width: w,
        backgroundColor: color,
        borderRadius: 1,
      }}
    />
  );
  return (
    <View
      style={{
        width: size,
        height: size,
        borderWidth: 1.6,
        borderColor: color,
        borderRadius: 2,
        paddingHorizontal: 4,
        paddingTop: 6,
        gap: 3.5,
        justifyContent: 'flex-start',
      }}
    >
      {line(size * 0.55)}
      {line(size * 0.55)}
      {line(size * 0.35)}
    </View>
  );
}

export function DecisionsIcon({ color, size = 24 }: { color: string; size?: number }) {
  const line = (w: number) => (
    <View
      style={{
        height: 1.6,
        width: w,
        backgroundColor: color,
        borderRadius: 1,
      }}
    />
  );
  return (
    <View
      style={{
        width: size,
        height: size,
        justifyContent: 'center',
        gap: 4,
        paddingHorizontal: 2,
      }}
    >
      {line(size * 0.85)}
      {line(size * 0.85)}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {line(size * 0.45)}
        <View
          style={{
            width: 7,
            height: 4,
            borderBottomWidth: 1.6,
            borderLeftWidth: 1.6,
            borderColor: color,
            transform: [{ rotate: '-45deg' }],
            marginLeft: 2,
          }}
        />
      </View>
    </View>
  );
}
