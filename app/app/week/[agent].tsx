import { useLocalSearchParams, useRouter } from 'expo-router';

import { shareBytes, shareTextFile } from '../../components/agents/shareFile';
import { useAgentHistories } from '../../components/agents/useAgentHistories';
import { WeekScreen } from '../../components/agents/WeekScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { useChain } from '../../lib/useChain';

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export default function WeekRoute() {
  const params = useLocalSearchParams<{ agent: string }>();
  const agent = one(params.agent);
  const data = useAgentHistories();
  const chain = useChain();
  const router = useRouter();
  return (
    <ConnectGate>
      <WeekScreen
        data={data}
        agent={agent}
        onBack={() => router.back()}
        onSaveFile={(name, text) => shareTextFile(name, text, 'Save this week as a file')}
        onShareCard={(bytes) => shareBytes('veto-week.png', bytes, 'image/png', 'Share this week as a card')}
        onReason={(address) => {
          void chain.selectMandate(address).then(() => {
            router.push('/(tabs)/decisions');
          });
        }}
      />
    </ConnectGate>
  );
}
