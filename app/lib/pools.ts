import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

import { DEVNET_USDC_MINT } from './tokens';

/** Devnet SPL token-swap program. Kind 0 on a trade rule is this program only. */
export const SPL_TOKEN_SWAP_PROGRAM_ID = new PublicKey(
  'SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8',
);

export const POOL_FEE_LINE = 'The exchange takes 0.30 percent of each trade.';
export const SOL_FOR_USDC = 'wrapped SOL for USDC';

/**
 * Public devnet pool accounts. These are the TOKEN_SWAP_POOL,
 * TOKEN_SWAP_AUTHORITY, TOKEN_SWAP_WSOL_VAULT, TOKEN_SWAP_USDC_VAULT,
 * TOKEN_SWAP_POOL_MINT and TOKEN_SWAP_FEE_ACCOUNT values.
 */
const DEVNET_SOL_USDC = {
  id: 'devnet-sol-usdc',
  pair: SOL_FOR_USDC,
  feeLine: POOL_FEE_LINE,
  inputMint: NATIVE_MINT,
  outputMint: new PublicKey(DEVNET_USDC_MINT),
  inputSymbol: 'wrapped SOL',
  outputSymbol: 'USDC',
  inputDecimals: 9,
  outputDecimals: 6,
  pool: new PublicKey('DTFPL7GmcFN9yc6Yv2FZrq158gRhM8JG1v6svgcNNjxL'),
  authority: new PublicKey('8bMBGNZf9L1h2cFQMVPmqkZzUMbdfB549q27UioGTknS'),
  inputVault: new PublicKey('HUUHvdSrsADyuXbkL5Q9Lu72Ybek4oNpFyBajaKmLfnp'),
  outputVault: new PublicKey('HejE81VKyAmThbTBBR6mxaPmkmk2qFJnZy2SC7whd4nL'),
  poolMint: new PublicKey('6j9w4Gh2XNNoFsqtCcxGJkPENUvCrc8P7hQCMdwvgMdV'),
  feeAccount: new PublicKey('9ZxbMsqrUQLiWrTAvSFToZZK3Yfs7UMAP7WP1QfeCe2i'),
} as const;

export type KnownPool = {
  id: string;
  pair: string;
  feeLine: string;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputSymbol: string;
  outputSymbol: string;
  inputDecimals: number;
  outputDecimals: number;
  pool: PublicKey;
  authority: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  poolMint: PublicKey;
  feeAccount: PublicKey;
};

const DEVNET_POOLS: readonly KnownPool[] = [DEVNET_SOL_USDC];

export function poolsForCluster(cluster: string | null | undefined): readonly KnownPool[] {
  if ((cluster ?? '').trim() === 'devnet') {
    return DEVNET_POOLS;
  }
  return [];
}

export function poolById(
  cluster: string | null | undefined,
  id: string,
): KnownPool | null {
  return poolsForCluster(cluster).find((pool) => pool.id === id) ?? null;
}

export function poolByAddress(address: string): KnownPool | null {
  return DEVNET_POOLS.find((pool) => pool.pool.toBase58() === address) ?? null;
}
