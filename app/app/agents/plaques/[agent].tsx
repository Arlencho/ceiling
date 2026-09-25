import { Share } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { PlaquesScreen } from '../../../components/agents/PlaquesScreen';
import { useAgentHistories } from '../../../components/agents/useAgentHistories';
import { ConnectGate } from '../../../components/ConnectGate';

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export default function PlaquesRoute() {
  const params = useLocalSearchParams<{ agent: string }>();
  const agent = one(params.agent);
  const data = useAgentHistories();
  const router = useRouter();
  return (
    <ConnectGate>
      <PlaquesScreen
        data={data}
        agent={agent}
        onBack={() => router.back()}
        onSharePlaque={(text) => {
          void Share.share({ message: text });
        }}
      />
    </ConnectGate>
  );
}
