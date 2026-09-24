import { useRouter } from 'expo-router';
import { ActivityIndicator } from 'react-native';

import { OnboardingCards } from '../components/OnboardingCards';
import { Screen } from '../components/Screen';
import { TopBar } from '../components/TopBar';
import { colors } from '../components/theme';
import { useOnboarding } from '../lib/useOnboarding';
import { useWallet } from '../lib/useWallet';

// Help opens this route in place of the help page. It does not clear the seen flag.
// Back and Done return to /help in place. No Help control, so the two cannot stack.
export default function OnboardingScreen() {
  const router = useRouter();
  const wallet = useWallet();
  const onboarding = useOnboarding();
  const connected = wallet.ownerPublicKey !== null;

  return (
    <Screen>
      <TopBar back="Back" help={false} />
      {onboarding.ready ? (
        <OnboardingCards
          showConnect={!connected}
          connectBusy={wallet.busy}
          onSkip={async () => {
            await onboarding.markSeen();
            router.replace('/help');
          }}
          onConnect={async () => {
            await onboarding.markSeen();
            try {
              await wallet.connect();
            } catch {
              // useWallet keeps the error.
            }
            router.replace('/help');
          }}
        />
      ) : (
        <ActivityIndicator color={colors.text} accessibilityLabel="Loading" />
      )}
    </Screen>
  );
}
