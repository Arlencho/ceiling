// Polyfills MUST run before `expo-router/entry`.
//
// @solana/web3.js and @solana/spl-token expect Node's Buffer and
// crypto.getRandomValues. React Native does not ship either one. If those
// globals are missing when web3.js first evaluates, Keypair generation and
// transaction serialization throw, and the crash is easy to misread as an
// MWA or Metro bug. Expo Router's default main (`expo-router/entry`) loads
// the router and then the rest of the app, so a polyfill imported from a
// screen is already too late. package.json `main` points at this file so
// Buffer and crypto exist before that import runs. Do not reorder these
// imports. This order is the single most common failure in this stack.
import { getRandomValues as expoCryptoGetRandomValues } from 'expo-crypto';
import { Buffer } from 'buffer';

global.Buffer = Buffer;

class Crypto {
  getRandomValues = expoCryptoGetRandomValues;
}

const webCrypto = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : new Crypto();

if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    enumerable: true,
    get: () => webCrypto,
  });
} else if (typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto.getRandomValues = expoCryptoGetRandomValues;
}

import 'expo-router/entry';
