import { redactRpc } from '../../lib/rpcPrivacy';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { AddAgentScreen } from '../../components/firstrun/AddAgentScreen';
import { Screen } from '../../components/Screen';
import { FIRST_RUN_ROUTES } from '../../lib/onboarding';
import { useWallet } from '../../lib/useWallet';

export default function AgentRoute() {
  const router = useRouter();
  const wallet = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Screen>
      <AddAgentScreen
        cluster={wallet.cluster}
        busy={busy}
        error={error}
        onBack={() => router.back()}
        onScan={() => router.push('/scan?target=request')}
        onPaste={() => router.push(FIRST_RUN_ROUTES.name)}
        onHow={() => router.push(FIRST_RUN_ROUTES.how)}
        onCreateTest={() => {
          setBusy(true);
          setError(null);
          void wallet
            .createAgentKeypair()
            .then(() => {
              router.push(FIRST_RUN_ROUTES.name);
            })
            .catch((err: unknown) => {
              setError(err instanceof Error ? redactRpc(err.message) : 'The test agent could not be created.');
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      />
    </Screen>
  );
}
