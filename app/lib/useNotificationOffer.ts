import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

// Loaded when the offer reads or asks. A static import pulls the Expo runtime
// into tests that render Home and never ask for notification permission.
async function loadNotifications() {
  return import('expo-notifications');
}

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
      void loadNotifications().then((Notifications) =>
        Notifications.getPermissionsAsync().then((current) => {
          if (!cancelled) {
            setGranted(current.granted === true);
          }
        }),
      );
      return () => {
        cancelled = true;
      };
    }, [ruleExists]),
  );

  const turnOn = useCallback(async () => {
    const Notifications = await loadNotifications();
    const next = await Notifications.requestPermissionsAsync();
    const ok = next.granted === true;
    setGranted(ok);
    if (ok) {
      const task = await import('./decisionNotifyTask');
      await task.scanDecisionsIfAllowed();
    }
  }, []);

  return { show: ruleExists && granted === false, turnOn };
}
