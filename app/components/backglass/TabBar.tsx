import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

import { colors, fonts } from '../theme';

export const BACKGLASS_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'rules', label: 'Rules' },
  { id: 'decisions', label: 'Decisions' },
] as const;

export type BackglassTab = (typeof BACKGLASS_TABS)[number]['id'];

type TabBarProps = {
  active: BackglassTab;
  onChange: (tab: BackglassTab) => void;
};

function TabIcon({ id, color }: { id: BackglassTab; color: string }) {
  if (id === 'home') {
    return (
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Path
          d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"
          fill="none"
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
  if (id === 'rules') {
    return (
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Path
          d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4"
          fill="none"
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path
        d="M5 6h14M5 12h14M5 18h9"
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <View accessibilityRole="tablist" style={styles.bar}>
      {BACKGLASS_TABS.map((tab) => {
        const selected = tab.id === active;
        const color = selected ? colors.brass : colors.muted;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(tab.id)}
            style={styles.tab}
          >
            <TabIcon id={tab.id} color={color} />
            <Text style={[styles.label, { color, fontFamily: selected ? fonts.sansBold : fonts.sansSemibold }]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 8,
    paddingBottom: 8,
    paddingHorizontal: 12,
  },
  tab: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
  },
});
