import { useRouter } from 'expo-router';

import { ConnectWalletScreen } from '../../components/firstrun/ConnectWalletScreen';
import { Screen } from '../../components/Screen';
import { FIRST_RUN_ROUTES } from '../../lib/onboarding';
import { useWallet } from '../../lib/useWallet';

export default function ConnectRoute() {
  const router = useRouter();
  const wallet = useWallet();
  return (
    <Screen>
      <ConnectWalletScreen
        cluster={wallet.cluster}
        busy={wallet.busy}
        error={wallet.error}
        showOtherWallet={wallet.solanaMobileInstalled}
        onBack={() => router.back()}
        onConnect={() => {
          void wallet.connect().then(() => {
            if (wallet.ownerPublicKey) {
              router.replace(FIRST_RUN_ROUTES.connected);
            }
          });
        }}
        onConnectOther={() => {
          void wallet.connect({ chooser: true }).then(() => {
            if (wallet.ownerPublicKey) {
              router.replace(FIRST_RUN_ROUTES.connected);
            }
          });
        }}
      />
    </Screen>
  );
}
