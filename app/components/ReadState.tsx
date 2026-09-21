import { mandateAbsenceCopy, type MandateReadStatus } from '../lib/mandateRead';
import { EmptyState } from './EmptyState';

export function ReadState({
  status,
  empty,
}: {
  status: MandateReadStatus;
  empty: string;
}) {
  const copy = mandateAbsenceCopy(status, empty);
  if (!copy) {
    return null;
  }
  return <EmptyState>{copy}</EmptyState>;
}
