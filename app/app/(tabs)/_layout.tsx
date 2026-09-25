import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';

import { AgentsIcon } from '../../components/agents/AgentsIcon';
import { DecisionsIcon, OverviewIcon, RulesIcon } from '../../components/Icons';
import { colors, fonts } from '../../components/theme';
import { introductionHidesTabBar } from '../../lib/approval';
import { useOnboarding } from '../../lib/useOnboarding';
import { useWallet } from '../../lib/useWallet';

export default function TabsLayout() {
  const wallet = useWallet();
  const onboarding = useOnboarding();
  const hideTabs = introductionHidesTabBar({
    walletReady: wallet.ready,
    onboardingReady: onboarding.ready,
    connected: wallet.ownerPublicKey !== null,
    seen: onboarding.seen,
  });
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: hideTabs
          ? { display: 'none' }
          : {
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
        name="agents"
        options={{
          title: 'Agents',
          tabBarLabel: 'Agents',
          tabBarIcon: ({ color }) => <AgentsIcon color={String(color)} />,
          tabBarAccessibilityLabel: 'Agents',
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
