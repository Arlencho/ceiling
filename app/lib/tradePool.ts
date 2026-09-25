import { Buffer } from 'buffer';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

import { SPL_TOKEN_SWAP_PROGRAM_ID } from './pools';

export const SWAP_ACCOUNT_LEN = 324;

const OFF_VERSION = 0;
const OFF_INITIALIZED = 1;
const OFF_NONCE = 2;
const OFF_TOKEN_PROGRAM = 3;
const OFF_VAULT_A = 35;
const OFF_VAULT_B = 67;
const OFF_POOL_MINT = 99;
const OFF_MINT_A = 131;
const OFF_MINT_B = 163;
const OFF_FEE = 195;

export type ParsedSwapPool = {
  nonce: number;
  tokenProgram: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  poolMint: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  feeAccount: PublicKey;
  authority: PublicKey;
};

export type PoolSides = ParsedSwapPool & {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
};

function pubkeyAt(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

export function swapAuthority(pool: PublicKey, nonce: number, programId: PublicKey): PublicKey {
  return PublicKey.createProgramAddressSync(
    [pool.toBuffer(), Buffer.from([nonce])],
    programId,
  );
}

export function parseSwapPool(
  pool: PublicKey,
  data: Uint8Array,
  programId: PublicKey = SPL_TOKEN_SWAP_PROGRAM_ID,
): ParsedSwapPool {
  if (data.length !== SWAP_ACCOUNT_LEN) {
    throw new Error(`Pool account is ${data.length} bytes. This app reads a 324 byte swap account.`);
  }
  if (data[OFF_VERSION] !== 1 || data[OFF_INITIALIZED] !== 1) {
    throw new Error('This pool account is not an initialized token swap.');
  }
  const nonce = data[OFF_NONCE] ?? 0;
  const tokenProgram = pubkeyAt(data, OFF_TOKEN_PROGRAM);
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID)) {
    throw new Error('This pool uses a token program this app does not trade.');
  }
  return {
    nonce,
    tokenProgram,
    vaultA: pubkeyAt(data, OFF_VAULT_A),
    vaultB: pubkeyAt(data, OFF_VAULT_B),
    poolMint: pubkeyAt(data, OFF_POOL_MINT),
    mintA: pubkeyAt(data, OFF_MINT_A),
    mintB: pubkeyAt(data, OFF_MINT_B),
    feeAccount: pubkeyAt(data, OFF_FEE),
    authority: swapAuthority(pool, nonce, programId),
  };
}

/** Input vault is the one whose mint is the token being sold. */
export function poolSides(parsed: ParsedSwapPool, inputMint: PublicKey): PoolSides {
  if (parsed.mintA.equals(inputMint)) {
    return {
      ...parsed,
      inputMint: parsed.mintA,
      outputMint: parsed.mintB,
      inputVault: parsed.vaultA,
      outputVault: parsed.vaultB,
    };
  }
  if (parsed.mintB.equals(inputMint)) {
    return {
      ...parsed,
      inputMint: parsed.mintB,
      outputMint: parsed.mintA,
      inputVault: parsed.vaultB,
      outputVault: parsed.vaultA,
    };
  }
  throw new Error('This pool does not hold the input token for this rule.');
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x === 0n ? 1n : x;
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * Floor is `percent` percent of output reserve / input reserve.
 * The stored ratio is never above that rate.
 */
export function floorFromSpot(
  outReserve: bigint,
  inReserve: bigint,
  percent: number,
): { floorNum: bigint; floorDen: bigint } {
  if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
    throw new Error('Floor percent must be a whole number from 1 to 99.');
  }
  if (inReserve <= 0n || outReserve <= 0n) {
    throw new Error('This pool has no rate to read. Both vaults need a balance.');
  }
  const num = BigInt(percent) * outReserve;
  const den = 100n * inReserve;
  const divisor = gcd(num, den);
  let floorNum = num / divisor;
  let floorDen = den / divisor;
  if (floorNum > U64_MAX || floorDen > U64_MAX) {
    floorNum = (BigInt(percent) * outReserve) / 100n;
    floorDen = inReserve;
  }
  if (floorNum > U64_MAX || floorDen > U64_MAX || floorDen === 0n) {
    throw new Error('The floor from this pool does not fit in the rule.');
  }
  return { floorNum, floorDen };
}

export function encodeSwapPool(args: {
  nonce: number;
  tokenProgram?: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  poolMint: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  feeAccount: PublicKey;
}): Buffer {
  const data = Buffer.alloc(SWAP_ACCOUNT_LEN);
  data[OFF_VERSION] = 1;
  data[OFF_INITIALIZED] = 1;
  data[OFF_NONCE] = args.nonce;
  Buffer.from((args.tokenProgram ?? TOKEN_PROGRAM_ID).toBytes()).copy(data, OFF_TOKEN_PROGRAM);
  Buffer.from(args.vaultA.toBytes()).copy(data, OFF_VAULT_A);
  Buffer.from(args.vaultB.toBytes()).copy(data, OFF_VAULT_B);
  Buffer.from(args.poolMint.toBytes()).copy(data, OFF_POOL_MINT);
  Buffer.from(args.mintA.toBytes()).copy(data, OFF_MINT_A);
  Buffer.from(args.mintB.toBytes()).copy(data, OFF_MINT_B);
  Buffer.from(args.feeAccount.toBytes()).copy(data, OFF_FEE);
  return data;
}
