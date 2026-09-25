import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { shareBytes, shareTextFile } from '../../../components/agents/shareFile';
import { TrackScreen } from '../../../components/agents/TrackScreen';
import { useAgentHistories } from '../../../components/agents/useAgentHistories';
import { ConnectGate } from '../../../components/ConnectGate';

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export default function TrackRoute() {
  const params = useLocalSearchParams<{ agent: string }>();
  const agent = one(params.agent);
  const data = useAgentHistories();
  const router = useRouter();
  return (
    <ConnectGate>
      <TrackScreen
        data={data}
        agent={agent}
        onBack={() => router.back()}
        onShareImage={(bytes) => shareBytes('veto-track-record.png', bytes, 'image/png', 'Share this record')}
        onCopyLink={async (url) => {
          await Clipboard.setStringAsync(url);
        }}
        onSaveRecord={(text) => shareTextFile('veto-track-record.txt', text, 'Save the full record')}
      />
    </ConnectGate>
  );
}
