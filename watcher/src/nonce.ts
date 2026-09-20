/** Deterministic nonce for a price window.
 *
 * The on-chain nonce is a u64 that advances only on a paid charge. Using the
 * unix seconds of the window start means a restart of this process cannot
 * invent a second nonce for a window that already settled.
 */
export function nonceFromWindowStart(timeStartIso: string): bigint {
  const ms = Date.parse(timeStartIso);
  if (!Number.isFinite(ms) || !Number.isInteger(ms)) {
    throw new Error(`nonce.nonceFromWindowStart: bad window start: ${timeStartIso}`);
  }
  if (ms < 0) {
    throw new Error(`nonce.nonceFromWindowStart: window start before epoch: ${timeStartIso}`);
  }
  return BigInt(ms) / 1000n;
}
