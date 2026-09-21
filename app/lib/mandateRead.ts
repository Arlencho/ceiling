export type MandateReadStatus = 'not-read' | 'failed' | 'empty' | 'present' | 'rate-limited';

export function mandateReadStatus(args: {
  checkedOwner: string | null;
  ownerPublicKey: string | null;
  loading: boolean;
  error: string | null;
  hasMandate: boolean;
  rateLimited?: boolean;
}): MandateReadStatus {
  const forThisOwner =
    args.ownerPublicKey != null && args.checkedOwner === args.ownerPublicKey;
  if (args.hasMandate && forThisOwner) {
    return 'present';
  }
  if (args.rateLimited) {
    return 'rate-limited';
  }
  if (!forThisOwner || args.loading) {
    return 'not-read';
  }
  if (args.error) {
    return 'failed';
  }
  return 'empty';
}

export function mandateAbsenceCopy(status: MandateReadStatus, empty: string): string | null {
  if (status === 'present') {
    return null;
  }
  if (status === 'not-read') {
    return 'Reading the chain for this owner.';
  }
  if (status === 'rate-limited') {
    return 'The RPC is rate limiting this read. Still trying. This is not a stalled fetch.';
  }
  if (status === 'failed') {
    return 'The chain read failed. Pull to retry. This screen does not assume there is no mandate.';
  }
  return empty;
}
