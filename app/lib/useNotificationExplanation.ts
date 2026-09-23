import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';

import { askAfterFirstRuleOpened, hasAskedForDecisionNotifications } from './decisionNotifyTask';
import {
  NOTIFICATION_CADENCE_LINE,
  NOTIFICATIONS_OFF_LINE,
  explainOnceThenAsk,
} from './notificationAsk';

export function useNotificationExplanation(openedAddress: string | null): {
  explanation: string | null;
  statusLine: string | null;
  onContinue: () => void;
} {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const continueRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!openedAddress) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const asked = await hasAskedForDecisionNotifications();
      if (cancelled) {
        return;
      }
      await explainOnceThenAsk({
        alreadyAsked: asked,
        showExplanation: (copy) =>
          new Promise<void>((resolve) => {
            if (cancelled) {
              resolve();
              return;
            }
            continueRef.current = resolve;
            setExplanation(copy);
          }),
        ask: async () => {
          if (cancelled) {
            return;
          }
          setExplanation(null);
          await askAfterFirstRuleOpened();
          if (cancelled) {
            return;
          }
          // Read after the dialog. An earlier read would say notifications are
          // off while the explanation is still waiting for Continue.
          const current = await Notifications.getPermissionsAsync();
          if (cancelled) {
            return;
          }
          setStatusLine(current.granted ? NOTIFICATION_CADENCE_LINE : NOTIFICATIONS_OFF_LINE);
        },
      });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      const pending = continueRef.current;
      continueRef.current = null;
      pending?.();
    };
  }, [openedAddress]);

  const onContinue = useCallback(() => {
    const done = continueRef.current;
    continueRef.current = null;
    setExplanation(null);
    done?.();
  }, []);

  return { explanation, statusLine, onContinue };
}
