import { Stack, useRouter, type Href } from 'expo-router';
import * as Linking from 'expo-linking';
import { useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';

import { colors } from '../components/theme';
import { ruleRequestHref } from '../lib/ruleRequest';
import { ChainProvider } from '../lib/useChain';
import { useDecisionNotifications } from '../lib/useDecisionNotifications';
import { OnboardingProvider } from '../lib/useOnboarding';
import { RulesetProvider } from '../lib/useRulesets';
import { WalletProvider } from '../lib/useWallet';

function RuleRequestLinks() {
  const router = useRouter();
  const openedInitial = useRef(false);
  useEffect(() => {
    let alive = true;
    const open = (url: string | null, cold: boolean) => {
      if (!alive || !url) {
        return;
      }
      const href = ruleRequestHref(url);
      if (!href) {
        return;
      }
      if (cold) {
        if (openedInitial.current) {
          return;
        }
        openedInitial.current = true;
        router.replace(href as Href);
        return;
      }
      router.push(href as Href);
    };
    void Linking.getInitialURL().then((url) => {
      open(url, true);
    });
    const subscription = Linking.addEventListener('url', (event) => {
      open(event.url, false);
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, [router]);
  return null;
}

export default function RootLayout() {
  useDecisionNotifications();
  return (
    <WalletProvider>
      <OnboardingProvider>
        <ChainProvider>
          <RulesetProvider>
            <StatusBar style="light" />
            <RuleRequestLinks />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
              }}
            />
          </RulesetProvider>
        </ChainProvider>
      </OnboardingProvider>
    </WalletProvider>
  );
}
