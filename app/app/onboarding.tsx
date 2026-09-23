import { useRouter } from 'expo-router';
import { ActivityIndicator } from 'react-native';

import { OnboardingCards } from '../components/OnboardingCards';
import { Screen } from '../components/Screen';
import { TopBar } from '../components/TopBar';
import { colors } from '../components/theme';
import { useOnboarding } from '../lib/useOnboarding';
import { useWallet } from '../lib/useWallet';

// Help opens this route again after the first-run flag is set. It does not clear that flag.
// No Help control here, so Help and the introduction cannot stack on each other.
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
            router.back();
          }}
          onConnect={async () => {
            await onboarding.markSeen();
            try {
              await wallet.connect();
            } catch {
              // useWallet keeps the error. The screen under this one shows it.
            }
            router.back();
          }}
        />
      ) : (
        <ActivityIndicator color={colors.text} accessibilityLabel="Loading" />
      )}
    </Screen>
  );
}
