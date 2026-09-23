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

const QUARTER_MS = 15 * 60 * 1000;

function describeInstant(at: Date | string): string {
  if (typeof at === "string") return at;
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return String(at);
  return at.toISOString();
}

/** Charge nonce for an instant: unix seconds of the 15-minute window that contains it.
 *
 * A cadence slot is already on that boundary, so the nonce of a slot is the
 * slot. The terminal quotes through this same function, so both name one
 * nonce for that window.
 */
export function nonceFromSlot(at: Date | string): bigint {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (!Number.isFinite(ms) || !Number.isInteger(ms)) {
    throw new Error(`nonce.nonceFromSlot: bad instant: ${describeInstant(at)}`);
  }
  const remainder = ((ms % QUARTER_MS) + QUARTER_MS) % QUARTER_MS;
  const start = ms - remainder;
  if (start < 0) {
    throw new Error(`nonce.nonceFromSlot: instant before epoch: ${describeInstant(at)}`);
  }
  return nonceFromWindowStart(new Date(start).toISOString());
}
