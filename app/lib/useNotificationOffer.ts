import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

export type NotificationPermissionReader = {
  getPermissionsAsync: () => Promise<{ granted?: boolean }>;
  requestPermissionsAsync: () => Promise<{ granted?: boolean }>;
};

// `reader` and `scanDecisions` let a test answer permission and the follow-up
// scan without loading Expo. With neither set, those modules load only when the
// offer reads or the owner turns notifications on. A static import pulls the
// Expo runtime into tests that render Home and never ask.
export const notificationPermissions: {
  reader: NotificationPermissionReader | null;
  scanDecisions: (() => Promise<void>) | null;
  load(): Promise<NotificationPermissionReader>;
} = {
  reader: null,
  scanDecisions: null,
  load() {
    const installed = this.reader;
    if (installed) {
      return Promise.resolve(installed);
    }
    return import('expo-notifications');
  },
};

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
      void notificationPermissions.load().then((Notifications) =>
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
    const Notifications = await notificationPermissions.load();
    const next = await Notifications.requestPermissionsAsync();
    const ok = next.granted === true;
    setGranted(ok);
    if (ok) {
      const scan = notificationPermissions.scanDecisions;
      if (scan) {
        await scan();
        return;
      }
      const task = await import('./decisionNotifyTask');
      await task.scanDecisionsIfAllowed();
    }
  }, []);

  return { show: ruleExists && granted === false, turnOn };
}
