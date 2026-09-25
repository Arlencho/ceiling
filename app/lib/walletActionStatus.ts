// A confirmed wallet action invalidates earlier action errors on mounted screens.
const listeners = new Set<() => void>();

export function onWalletActionSuccess(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function walletActionSucceeded(): void {
  for (const listener of listeners) listener();
}
