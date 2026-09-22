import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { scanDecisionsIfAllowed } from './decisionNotifyTask';
import { decisionPathFromNoticeData } from './notify';

export function useDecisionNotifications(): void {
  const router = useRouter();
  const last = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!last || last.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
      return;
    }
    const key = last.notification.request.identifier;
    if (handled.current === key) {
      return;
    }
    const path = decisionPathFromNoticeData(last.notification.request.content.data);
    if (!path) {
      return;
    }
    handled.current = key;
    router.push(path);
    void Notifications.clearLastNotificationResponseAsync();
  }, [last, router]);

  useEffect(() => {
    const run = () => {
      void scanDecisionsIfAllowed().catch(() => undefined);
    };
    run();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        run();
      }
    });
    return () => subscription.remove();
  }, []);
}
