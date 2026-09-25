import { useRouter } from 'expo-router';

import { HowVetoWorks } from '../../components/firstrun/HowVetoWorks';
import { Screen } from '../../components/Screen';
import { useOnboarding } from '../../lib/useOnboarding';
import { useWallet } from '../../lib/useWallet';

export default function HowRoute() {
  const router = useRouter();
  const wallet = useWallet();
  const onboarding = useOnboarding();
  const connected = wallet.ownerPublicKey !== null;
  return (
    <Screen>
      <HowVetoWorks
        cluster={wallet.cluster}
        connected={connected}
        busy={wallet.busy}
        error={wallet.error}
        onBack={() => router.back()}
        onDone={async () => {
          await onboarding.markSeen();
          router.back();
        }}
        onConnect={async () => {
          await onboarding.markSeen();
          try {
            await wallet.connect();
          } catch {
            // The page shows the wallet error.
          }
        }}
      />
    </Screen>
  );
}
