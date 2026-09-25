import {
  Fraunces_300Light,
  Fraunces_400Regular,
  Fraunces_400Regular_Italic,
  Fraunces_500Medium,
} from '@expo-google-fonts/fraunces';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
} from '@expo-google-fonts/manrope';
import { useFonts } from 'expo-font';
import * as Linking from 'expo-linking';
import { Stack, useRouter, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';

import { colors } from '../components/theme';
import { ruleRequestHref } from '../lib/ruleRequest';
import { ChainProvider } from '../lib/useChain';
import { useDecisionNotifications } from '../lib/useDecisionNotifications';
import { OnboardingProvider } from '../lib/useOnboarding';
import { RulesetProvider } from '../lib/useRulesets';
import { WalletProvider } from '../lib/useWallet';

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native splash can already be held by the time this module loads.
});

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
  const [fontsReady, fontError] = useFonts({
    Fraunces_300Light,
    Fraunces_400Regular,
    Fraunces_400Regular_Italic,
    Fraunces_500Medium,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });
  const ready = fontsReady || fontError != null;
  useEffect(() => {
    if (!ready) {
      return;
    }
    SplashScreen.hideAsync().catch(() => {
      // Hide rejects when the splash was already dismissed.
    });
  }, [ready]);
  if (!ready) {
    return null;
  }
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
