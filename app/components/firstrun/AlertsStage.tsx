import { useNotificationExplanation } from '../../lib/useNotificationExplanation';
import { AlertsScreen } from './AlertsScreen';

export function AlertsStage({
  cluster,
  address,
  exampleLimit,
  onNotNow,
}: {
  cluster: string | null;
  address: string | null;
  exampleLimit: string | null;
  onNotNow: () => void;
}) {
  const notify = useNotificationExplanation(address);
  return (
    <AlertsScreen
      cluster={cluster}
      explanation={notify.explanation}
      statusLine={notify.statusLine}
      exampleLimit={exampleLimit}
      onTurnOn={notify.onContinue}
      onNotNow={onNotNow}
      view={address ? 'normal' : 'empty'}
    />
  );
}
