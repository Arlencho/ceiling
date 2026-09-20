// Buffer and crypto.getRandomValues for @solana/web3.js and @solana/spl-token.
//
// This lives in its own module for a reason that is easy to get wrong. ES
// import declarations are all evaluated before any statement in the importing
// module's body runs, so putting `import "expo-router/entry"` at the bottom of
// a file whose body assigns global.Buffer does NOT run the assignment first:
// the router is evaluated with Buffer still undefined. Keeping the assignments
// in a separate module makes the ordering real, because side-effect imports are
// evaluated in source order and this module's body completes before the next
// import is evaluated.
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
