import { ConnectAgentPanel } from '../ConnectAgentPanel';
import { BrassButton, FirstRunChrome, QuietButton, type ScreenView } from './Chrome';

export function AgentSetupScreen({
  cluster,
  rows,
  configJson,
  status,
  error = null,
  summary = null,
  onCopy,
  onAlerts,
  onOverview,
  view,
}: {
  cluster: string | null;
  rows: readonly { label: string; value: string }[];
  configJson: string | null;
  status: string | null;
  error?: string | null;
  summary?: string | null;
  onCopy: (json: string) => void;
  onAlerts: () => void;
  onOverview: () => void;
  view?: ScreenView;
}) {
  const resolved = view ?? (error ? 'error' : configJson || status ? 'normal' : 'empty');
  return (
    <FirstRunChrome
      stage="live"
      cluster={cluster}
      title="Rule live"
      view={resolved}
      error={error}
      empty="Waiting for your agent's first request. Nothing has moved."
      footer={
        <>
          <BrassButton label="Turn on alerts" onPress={onAlerts} />
          <QuietButton label="Next: protect your money" onPress={onOverview} />
        </>
      }
    >
      <ConnectAgentPanel
        rows={rows}
        configJson={configJson}
        status={status}
        onCopy={onCopy}
        summary={summary}
      />
    </FirstRunChrome>
  );
}
