import { transact as mwaTransact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import * as SecureStore from 'expo-secure-store';

import type { AssociationConfig, MwaWallet, WalletStore } from './wallet';

export function transact<T>(
  callback: (wallet: MwaWallet) => Promise<T>,
  config?: AssociationConfig,
): Promise<T> {
  const baseUri = config?.baseUri;
  if (baseUri) {
    return mwaTransact((wallet) => callback(wallet as MwaWallet), { baseUri }) as Promise<T>;
  }
  return mwaTransact((wallet) => callback(wallet as MwaWallet)) as Promise<T>;
}

export const secureStore: WalletStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};
