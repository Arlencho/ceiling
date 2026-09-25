import { useRouter } from 'expo-router';

import { RuleLiveScreen } from '../../components/firstrun/RuleLiveScreen';
import { Screen } from '../../components/Screen';
import { FIRST_RUN_ROUTES } from '../../lib/onboarding';
import { useWallet } from '../../lib/useWallet';

export default function LiveRoute() {
  const router = useRouter();
  const wallet = useWallet();
  return (
    <Screen>
      <RuleLiveScreen
        cluster={wallet.cluster}
        facts={null}
        onSetup={() => router.push(FIRST_RUN_ROUTES.setup)}
        onOverview={() => router.replace('/')}
      />
    </Screen>
  );
}
