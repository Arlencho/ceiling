import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export type DerivedKey = { bytes: Buffer; base58: string };

function derive(seed: number, label: string, bytes: number): Buffer {
  const hash = createHash("sha512")
    .update(`veto-loadtest-gen:${seed}:${label}`)
    .digest();
  return hash.subarray(0, bytes);
}

// A synthetic 32 byte account address. Deterministic for (seed, label).
export function derivePubkey(seed: number, label: string): DerivedKey {
  const raw = derive(seed, `pubkey:${label}`, 32);
  return { bytes: raw, base58: base58Encode(raw) };
}

// A synthetic 64 byte transaction signature, base58 encoded like the RPC returns.
export function deriveSignature(seed: number, label: string): string {
  return base58Encode(derive(seed, `signature:${label}`, 64));
}
