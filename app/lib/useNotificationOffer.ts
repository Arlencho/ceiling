import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Notifications from 'expo-notifications';

import { scanDecisionsIfAllowed } from './decisionNotifyTask';

export function useNotificationOffer(ruleExists: boolean): {
  show: boolean;
  turnOn: () => Promise<void>;
} {
  const [granted, setGranted] = useState<boolean | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!ruleExists) {
        return;
      }
      let cancelled = false;
      void Notifications.getPermissionsAsync().then((current) => {
        if (!cancelled) {
          setGranted(current.granted === true);
        }
      });
      return () => {
        cancelled = true;
      };
    }, [ruleExists]),
  );

  const turnOn = useCallback(async () => {
    const next = await Notifications.requestPermissionsAsync();
    const ok = next.granted === true;
    setGranted(ok);
    if (ok) {
      await scanDecisionsIfAllowed();
    }
  }, []);

  return { show: ruleExists && granted === false, turnOn };
}
