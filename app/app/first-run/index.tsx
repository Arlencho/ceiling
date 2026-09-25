import { useRouter } from 'expo-router';

import { LearnStory } from '../../components/firstrun/LearnStory';
import { Screen } from '../../components/Screen';
import { FIRST_RUN_ROUTES } from '../../lib/onboarding';
import { useOnboarding } from '../../lib/useOnboarding';
import { useWallet } from '../../lib/useWallet';

export default function LearnRoute() {
  const router = useRouter();
  const wallet = useWallet();
  const onboarding = useOnboarding();
  const connected = wallet.ownerPublicKey !== null;

  return (
    <Screen>
      <LearnStory
        cluster={wallet.cluster}
        showConnect={!connected}
        connectBusy={wallet.busy}
        showOtherWallet={wallet.solanaMobileInstalled}
        onSkip={async () => {
          await onboarding.markSeen();
          router.replace(FIRST_RUN_ROUTES.connect);
        }}
        onConnect={async () => {
          await onboarding.markSeen();
          try {
            await wallet.connect();
          } catch {
            // The connect screen shows the wallet error.
          }
          router.replace(wallet.ownerPublicKey ? FIRST_RUN_ROUTES.connected : FIRST_RUN_ROUTES.connect);
        }}
        onConnectOther={async () => {
          await onboarding.markSeen();
          try {
            await wallet.connect({ chooser: true });
          } catch {
            // The connect screen shows the wallet error.
          }
          router.replace(wallet.ownerPublicKey ? FIRST_RUN_ROUTES.connected : FIRST_RUN_ROUTES.connect);
        }}
      />
    </Screen>
  );
}
