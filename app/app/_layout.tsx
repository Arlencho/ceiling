import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { colors } from '../components/theme';
import { ChainProvider } from '../lib/useChain';
import { WalletProvider } from '../lib/useWallet';

export default function RootLayout() {
  return (
    <WalletProvider>
      <ChainProvider>
        <StatusBar style="light" />
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarStyle: {
              backgroundColor: colors.bg,
              borderTopColor: colors.line,
            },
            tabBarActiveTintColor: colors.text,
            tabBarInactiveTintColor: colors.muted,
          }}
        >
          <Tabs.Screen name="index" options={{ title: 'Today' }} />
          <Tabs.Screen name="mandate" options={{ title: 'Mandate' }} />
          <Tabs.Screen name="ledger" options={{ title: 'Ledger' }} />
          <Tabs.Screen name="revoke" options={{ title: 'Revoke' }} />
        </Tabs>
      </ChainProvider>
    </WalletProvider>
  );
}
