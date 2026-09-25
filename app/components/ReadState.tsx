import { CHAIN_UNREACHABLE, mandateAbsenceCopy, type MandateReadStatus } from '../lib/mandateRead';
import { EmptyState } from './EmptyState';

export function ReadState({
  status,
  empty,
  staleError = null,
}: {
  status: MandateReadStatus;
  empty: string;
  staleError?: string | null;
}) {
  const copy = mandateAbsenceCopy(status, empty);
  const warning = status === 'present' && staleError ? CHAIN_UNREACHABLE : null;
  if (!copy && !warning) {
    return null;
  }
  return (
    <>
      {warning ? <EmptyState>{warning}</EmptyState> : null}
      {copy ? <EmptyState>{copy}</EmptyState> : null}
    </>
  );
}
