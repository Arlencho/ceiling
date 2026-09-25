import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { onWalletActionSuccess } from './walletActionStatus';

export function useWalletActionError(): readonly [string | null, (error: string | null) => void] {
  const [error, setError] = useState<string | null>(null);
  const visit = useRef(0);
  const currentVisit = visit.current;
  useEffect(() => onWalletActionSuccess(() => setError(null)), []);
  useFocusEffect(useCallback(() => {
    setError(null);
    return () => {
      visit.current += 1;
      setError(null);
    };
  }, []));
  // A request finishing after the owner left cannot restore an old error.
  const showError = (next: string | null) => {
    if (visit.current === currentVisit) setError(next);
  };
  return [error, showError];
}
