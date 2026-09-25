import type { MandateAccount } from '../../lib/mandate';
import { AgentSetupScreen } from './AgentSetupScreen';
import { useAgentSetup } from './useAgentSetup';

export function LiveAgentSetup({
  mandate,
  cluster,
  summary,
  onAlerts,
  onOverview,
}: {
  mandate: MandateAccount | null;
  cluster: string | null;
  summary: string | null;
  onAlerts: () => void;
  onOverview: () => void;
}) {
  const setup = useAgentSetup(mandate);
  return (
    <AgentSetupScreen
      cluster={cluster}
      rows={setup.rows}
      configJson={setup.configJson}
      status={setup.status}
      error={setup.error}
      summary={summary}
      view={setup.view}
      onCopy={(json) => {
        void copySetup(json);
      }}
      onAlerts={onAlerts}
      onOverview={onOverview}
    />
  );
}

async function copySetup(json: string): Promise<void> {
  const clipboard = await import('expo-clipboard');
  await clipboard.setStringAsync(json);
}
