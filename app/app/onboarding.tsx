import { useRouter } from 'expo-router';
import { ActivityIndicator } from 'react-native';

import { HowVetoWorks } from '../components/firstrun/HowVetoWorks';
import { Screen } from '../components/Screen';
import { colors } from '../components/theme';
import { useOnboarding } from '../lib/useOnboarding';
import { useWallet } from '../lib/useWallet';

// Help opens this route again after the first-run flag is set. It does not clear that flag.
// No Help control here, so Help and this page cannot stack on each other.
export default function OnboardingScreen() {
  const router = useRouter();
  const wallet = useWallet();
  const onboarding = useOnboarding();
  const connected = wallet.ownerPublicKey !== null;

  return (
    <Screen>
      {onboarding.ready ? (
        <HowVetoWorks
          cluster={wallet.cluster}
          connected={connected}
          busy={wallet.busy}
          error={wallet.error}
          onBack={() => router.back()}
          onSkip={async () => {
            await onboarding.markSeen();
            router.back();
          }}
          onDone={async () => {
            await onboarding.markSeen();
            router.back();
          }}
          onConnect={async () => {
            await onboarding.markSeen();
            try {
              await wallet.connect();
            } catch {
              // useWallet keeps the error. This page shows it.
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
