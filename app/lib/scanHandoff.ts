export type AddressScanTarget = 'agent' | 'payee';

type Pending =
  | { kind: 'field'; target: AddressScanTarget; value: string }
  | { kind: 'write'; agent: string };

let pending: Pending | null = null;

export function stageAddressScan(target: AddressScanTarget, value: string): void {
  pending = { kind: 'field', target, value };
}

export function takeAddressScan(target: AddressScanTarget): string | null {
  if (!pending || pending.kind !== 'field' || pending.target !== target) {
    return null;
  }
  const value = pending.value;
  pending = null;
  return value;
}

export function stageWriteRule(agent: string): void {
  pending = { kind: 'write', agent };
}

export function takeWriteRule(): string | null {
  if (!pending || pending.kind !== 'write') {
    return null;
  }
  const agent = pending.agent;
  pending = null;
  return agent;
}
