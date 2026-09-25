import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

// null until the system setting is known. Callers treat null like reduced
// motion so the first paint is the still end state.
export function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = (value: boolean) => {
      if (alive) {
        setReduced(value);
      }
    };
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then(apply).catch(() => apply(false));
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', apply);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}

export function motionAllowed(reduced: boolean | null): boolean {
  return reduced === false;
}
