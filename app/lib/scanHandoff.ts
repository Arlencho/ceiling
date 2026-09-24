export type AddressScanTarget = 'agent' | 'payee';

let pending: { target: AddressScanTarget; value: string } | null = null;

export function stageAddressScan(target: AddressScanTarget, value: string): void {
  pending = { target, value };
}

export function takeAddressScan(target: AddressScanTarget): string | null {
  if (!pending || pending.target !== target) {
    return null;
  }
  const value = pending.value;
  pending = null;
  return value;
}
