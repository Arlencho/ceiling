import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { secureStore } from './mwa';
import { markOnboardingSeen, resolveOnboardingSeen } from './onboarding';

export type OnboardingState = {
  ready: boolean;
  seen: boolean;
  markSeen: () => Promise<void>;
};

function useOnboardingState(): OnboardingState {
  const [ready, setReady] = useState(false);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const value = await resolveOnboardingSeen(secureStore);
        if (!cancelled) {
          setSeen(value);
        }
      } catch {
        if (!cancelled) {
          setSeen(false);
        }
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const markSeen = useCallback(async () => {
    try {
      await markOnboardingSeen(secureStore);
    } catch {
      // Still leave the cards. The flag stays unset until a later write succeeds.
    }
    setSeen(true);
  }, []);

  return useMemo(() => ({ ready, seen, markSeen }), [ready, seen, markSeen]);
}

const OnboardingContext = createContext<OnboardingState | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const value = useOnboardingState();
  return createElement(OnboardingContext.Provider, { value }, children);
}

export function useOnboarding(): OnboardingState {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return ctx;
}
