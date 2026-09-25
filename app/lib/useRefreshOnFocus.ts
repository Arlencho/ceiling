import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';

export function useRefreshOnFocus(refresh: () => Promise<void> | void): void {
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
}
