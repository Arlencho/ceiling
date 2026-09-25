import { DEVNET_USDC_MINT } from './tokens';
import { parseBaseUnits } from './format';

export const CIRCLE_DEVNET_FAUCET_URL = 'https://faucet.circle.com';
export const GET_DEVNET_USDC_LABEL = 'Get devnet USDC';
export const FAUCET_PASTE_LINE =
  'Paste this address into the faucet. It sends devnet USDC, which has no value.';

export type DevnetUsdcShortfall = {
  /** Base units the owner holds. Null means no token account, read as zero once the balance is known. */
  balance: bigint | null;
  /** Base units the form asks for. Zero or less is not a shortfall. */
  needed: bigint;
  /** False while the balance has not been read. */
  balanceKnown: boolean;
};

export function isDevnetUsdcMint(
  cluster: string | null | undefined,
  mint: string | null | undefined,
): boolean {
  return (cluster ?? '').trim() === 'devnet' && (mint ?? '').trim() === DEVNET_USDC_MINT;
}

/**
 * Devnet Circle USDC only. Omit `shortfall` on the empty state, where no amount
 * has been asked yet. A form passes `shortfall` and shows the faucet only when
 * the known balance is under that amount.
 */
export function showDevnetUsdcFaucet(ask: {
  cluster: string | null | undefined;
  mint: string | null | undefined;
  shortfall?: DevnetUsdcShortfall | null;
}): boolean {
  if (!isDevnetUsdcMint(ask.cluster, ask.mint)) {
    return false;
  }
  if (ask.shortfall == null) {
    return true;
  }
  if (!ask.shortfall.balanceKnown || ask.shortfall.needed <= 0n) {
    return false;
  }
  const held = ask.shortfall.balance ?? 0n;
  return held < ask.shortfall.needed;
}

/** What a typed amount asks for, in base units. Null when the field is empty or not a positive amount. */
export function askedBaseUnits(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const value = parseBaseUnits(trimmed, decimals);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}
