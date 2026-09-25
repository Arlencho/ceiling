import { useRouter } from 'expo-router';

import { AgentsScreen } from '../../components/agents/AgentsScreen';
import { useAgentHistories } from '../../components/agents/useAgentHistories';
import { ConnectGate } from '../../components/ConnectGate';

export default function AgentsTab() {
  const data = useAgentHistories();
  const router = useRouter();
  return (
    <ConnectGate padNetwork>
      <AgentsScreen
        data={data}
        topInset={false}
        onOpenAgent={(agent) => router.push(`/agents/${agent}`)}
        onHowGrades={() => router.push('/agents/grades')}
        onNameAgent={(agent, name) => {
          void data.saveName(agent, name);
        }}
      />
    </ConnectGate>
  );
}
