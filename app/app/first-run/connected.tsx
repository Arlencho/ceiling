import { useRouter } from 'expo-router';

import { WalletConnectedScreen } from '../../components/firstrun/WalletConnectedScreen';
import { Screen } from '../../components/Screen';
import { FIRST_RUN_ROUTES } from '../../lib/onboarding';
import { useWallet } from '../../lib/useWallet';

export default function ConnectedRoute() {
  const router = useRouter();
  const wallet = useWallet();
  return (
    <Screen>
      <WalletConnectedScreen
        cluster={wallet.cluster}
        owner={wallet.ownerPublicKey}
        error={wallet.error}
        onAddAgent={() => router.push(FIRST_RUN_ROUTES.agent)}
      />
    </Screen>
  );
}
