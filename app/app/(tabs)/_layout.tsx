import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';

import { DecisionsIcon, OverviewIcon, RulesIcon } from '../../components/Icons';
import { colors, fonts } from '../../components/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.line,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 72,
          paddingTop: 6,
          paddingBottom: 16,
        },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '500',
          fontFamily: fonts.sans,
          letterSpacing: 0.2,
        },
        tabBarItemStyle: {
          minHeight: 52,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Overview',
          tabBarLabel: 'Overview',
          tabBarIcon: ({ color }) => <OverviewIcon color={String(color)} />,
          tabBarAccessibilityLabel: 'Overview',
        }}
      />
      <Tabs.Screen
        name="rules"
        options={{
          title: 'Rules',
          tabBarLabel: 'Rules',
          tabBarIcon: ({ color }) => <RulesIcon color={String(color)} />,
          tabBarAccessibilityLabel: 'Rules',
        }}
      />
      <Tabs.Screen
        name="decisions"
        options={{
          title: 'Decisions',
          tabBarLabel: 'Decisions',
          tabBarIcon: ({ color }) => <DecisionsIcon color={String(color)} />,
          tabBarAccessibilityLabel: 'Decisions',
        }}
      />
    </Tabs>
  );
}
