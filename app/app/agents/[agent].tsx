import { useLocalSearchParams, useRouter } from 'expo-router';

import { AgentRecordScreen } from '../../components/agents/AgentRecordScreen';
import { useAgentHistories } from '../../components/agents/useAgentHistories';
import { ConnectGate } from '../../components/ConnectGate';
import { useChain } from '../../lib/useChain';

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export default function AgentRecordRoute() {
  const params = useLocalSearchParams<{ agent: string }>();
  const agent = one(params.agent);
  const data = useAgentHistories();
  const chain = useChain();
  const router = useRouter();
  return (
    <ConnectGate>
      <AgentRecordScreen
        data={data}
        agent={agent}
        onBack={() => router.back()}
        onHowGrades={() => router.push('/agents/grades')}
        onPlaques={() => router.push(`/agents/plaques/${agent}`)}
        onShareRecord={() => router.push(`/agents/track/${agent}`)}
        onWeek={() => router.push(`/week/${agent}`)}
        onDecisions={(address) => {
          void chain.selectMandate(address).then(() => {
            router.push('/(tabs)/decisions');
          });
        }}
      />
    </ConnectGate>
  );
}
