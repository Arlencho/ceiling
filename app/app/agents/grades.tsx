import { useRouter } from 'expo-router';

import { GradesScreen } from '../../components/agents/GradesScreen';
import { useAgentHistories } from '../../components/agents/useAgentHistories';
import { ConnectGate } from '../../components/ConnectGate';

export default function GradesRoute() {
  const data = useAgentHistories();
  const router = useRouter();
  return (
    <ConnectGate>
      <GradesScreen data={data} onBack={() => router.back()} />
    </ConnectGate>
  );
}
