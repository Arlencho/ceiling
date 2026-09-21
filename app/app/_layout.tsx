import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { colors } from '../components/theme';
import { ChainProvider } from '../lib/useChain';
import { RulesetProvider } from '../lib/useRulesets';
import { WalletProvider } from '../lib/useWallet';

export default function RootLayout() {
  return (
    <WalletProvider>
      <ChainProvider>
        <RulesetProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
            }}
          />
        </RulesetProvider>
      </ChainProvider>
    </WalletProvider>
  );
}
