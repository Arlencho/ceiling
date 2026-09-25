import { useRouter } from 'expo-router';

import { AgentSetupScreen } from '../../components/firstrun/AgentSetupScreen';
import { Screen } from '../../components/Screen';
import { FIRST_RUN_ROUTES } from '../../lib/onboarding';
import { useChain } from '../../lib/useChain';
import { useWallet } from '../../lib/useWallet';

export default function SetupRoute() {
  const router = useRouter();
  const wallet = useWallet();
  const chain = useChain();
  const mandate = chain.mandate;
  return (
    <Screen>
      <AgentSetupScreen
        cluster={wallet.cluster}
        rows={[]}
        configJson={null}
        status={mandate ? 'Open the rule to copy its setup. The text is on the rule screen.' : null}
        onCopy={() => undefined}
        onAlerts={() => router.push(FIRST_RUN_ROUTES.alerts)}
        onOverview={() => router.replace('/')}
        view={chain.loading ? 'loading' : mandate ? 'normal' : 'empty'}
      />
    </Screen>
  );
}
