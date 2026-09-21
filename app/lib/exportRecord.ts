import { KIND_PAID, KIND_REFUSED, kindName, reasonText } from './constants';
import type { MandateAccount } from './mandate';
import type { LedgerRow } from './ring';

export const COMPLETENESS = 'payments' as const;

export const COMPLETENESS_NOTE =
  'Complete over paid and refused charges that landed on chain. Never complete over attempts. A charge the agent never submitted cannot appear here, and this file does not invent rows for missing signatures.';

export const CSV_COLUMNS = [
  'completeness',
  'scope_type',
  'scope_mandate',
  'scope_from',
  'scope_to',
  'schema_version',
  'cluster',
  'genesis_hash',
  'program_id',
  'mandate',
  'limits_cap',
  'limits_per_tx_max',
  'limits_expires_at',
  'limits_merchant',
  'limits_purpose',
  'kind',
  'amount',
  'counterparty',
  'timestamp',
  'nonce',
  'reason_code',
  'reason_text',
  'suggested_override',
  'signature',
] as const;

export type ChargeKind = 'paid' | 'refused';

export type ExportableDecision = {
  signature: string | null;
  slot: number | null;
  kind: ChargeKind;
  amount: bigint;
  counterparty: string;
  timestamp: bigint;
  nonce: bigint;
  reason_code: number;
  reason_text: string;
  suggested_override: bigint;
  mandate: string;
};

export type ShareScope =
  | { type: 'decision'; nonce: bigint; kind: ChargeKind; timestamp: bigint }
  | { type: 'date_range'; from: number; to: number }
  | { type: 'rule' };

export type BundleScope = {
  type: 'rule' | 'date_range';
  mandate: string | null;
  from: number | null;
  to: number | null;
};

export type DecisionRecordPlain = {
  schema_version: 1;
  cluster: string;
  genesis_hash: string;
  program_id: string;
  mandate: string;
  limits: {
    cap: number;
    per_tx_max: number;
    expires_at: number;
    merchant: string;
    purpose: string;
  };
  kind: ChargeKind;
  amount: number;
  counterparty: string;
  timestamp: number;
  nonce: number;
  reason_code: number;
  reason_text: string;
  suggested_override: number;
  signature: string;
};

export type DecisionBundlePlain = {
  schema_version: 1;
  completeness: typeof COMPLETENESS;
  completeness_note: string;
  cluster: string;
  genesis_hash: string;
  program_id: string;
  scope: BundleScope;
  decisions: DecisionRecordPlain[];
};

export type ExportContext = {
  cluster: string;
  genesisHash: string;
  programId: string;
  mandate: MandateAccount;
};

export function rowToExportable(row: LedgerRow, mandate: string): ExportableDecision | null {
  if (row.kind !== KIND_PAID && row.kind !== KIND_REFUSED) {
    return null;
  }
  const kind = kindName(row.kind);
  if (kind !== 'paid' && kind !== 'refused') {
    return null;
  }
  return {
    signature: row.signature,
    slot: row.slot ?? null,
    kind,
    amount: row.amount,
    counterparty: row.counterparty,
    timestamp: row.ts,
    nonce: row.nonce,
    reason_code: row.reason,
    reason_text: row.reasonText || reasonText(row.reason),
    suggested_override: row.suggestedOverride,
    mandate,
  };
}

export function selectExportRows(
  rows: readonly ExportableDecision[],
  scope: ShareScope,
): ExportableDecision[] {
  if (scope.type === 'decision') {
    return rows.filter(
      (row) =>
        row.nonce === scope.nonce &&
        row.kind === scope.kind &&
        row.timestamp === scope.timestamp,
    );
  }
  if (scope.type === 'date_range') {
    return rows.filter((row) => {
      const ts = Number(row.timestamp);
      return ts >= scope.from && ts <= scope.to;
    });
  }
  return rows.slice();
}

export function signedExportRows(rows: readonly ExportableDecision[]): ExportableDecision[] {
  return rows.filter((row) => typeof row.signature === 'string' && row.signature.length > 0);
}

export function bundleScopeFor(scope: ShareScope, mandate: string): BundleScope {
  if (scope.type === 'date_range') {
    return { type: 'date_range', mandate, from: scope.from, to: scope.to };
  }
  if (scope.type === 'decision') {
    return {
      type: 'date_range',
      mandate,
      from: Number(scope.timestamp),
      to: Number(scope.timestamp),
    };
  }
  return { type: 'rule', mandate, from: null, to: null };
}

function toNumber(value: bigint): number {
  return Number(value);
}

export function recordToPlain(row: ExportableDecision, ctx: ExportContext): DecisionRecordPlain {
  if (!row.signature) {
    throw new Error('an exported row must carry its own transaction signature');
  }
  return {
    schema_version: 1,
    cluster: ctx.cluster,
    genesis_hash: ctx.genesisHash,
    program_id: ctx.programId,
    mandate: ctx.mandate.address,
    limits: {
      cap: toNumber(ctx.mandate.cap),
      per_tx_max: toNumber(ctx.mandate.perTxMax),
      expires_at: toNumber(ctx.mandate.expiresAt),
      merchant: ctx.mandate.merchant,
      purpose: ctx.mandate.purpose,
    },
    kind: row.kind,
    amount: toNumber(row.amount),
    counterparty: row.counterparty,
    timestamp: toNumber(row.timestamp),
    nonce: toNumber(row.nonce),
    reason_code: row.reason_code,
    reason_text: row.reason_text,
    suggested_override: toNumber(row.suggested_override),
    signature: row.signature,
  };
}

export function makeBundle(
  rows: readonly ExportableDecision[],
  scope: ShareScope,
  ctx: ExportContext,
): DecisionBundlePlain {
  return {
    schema_version: 1,
    completeness: COMPLETENESS,
    completeness_note: COMPLETENESS_NOTE,
    cluster: ctx.cluster,
    genesis_hash: ctx.genesisHash,
    program_id: ctx.programId,
    scope: bundleScopeFor(scope, ctx.mandate.address),
    decisions: signedExportRows(rows).map((row) => recordToPlain(row, ctx)),
  };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function rowValues(bundle: DecisionBundlePlain, rec: DecisionRecordPlain): string[] {
  return [
    bundle.completeness,
    bundle.scope.type,
    bundle.scope.mandate ?? '',
    bundle.scope.from === null ? '' : String(bundle.scope.from),
    bundle.scope.to === null ? '' : String(bundle.scope.to),
    String(rec.schema_version),
    rec.cluster,
    rec.genesis_hash,
    rec.program_id,
    rec.mandate,
    String(rec.limits.cap),
    String(rec.limits.per_tx_max),
    String(rec.limits.expires_at),
    rec.limits.merchant,
    rec.limits.purpose,
    rec.kind,
    String(rec.amount),
    rec.counterparty,
    String(rec.timestamp),
    String(rec.nonce),
    String(rec.reason_code),
    rec.reason_text,
    String(rec.suggested_override),
    rec.signature,
  ];
}

export function bundleToCsv(bundle: DecisionBundlePlain): string {
  const lines: string[] = [
    `# completeness=${bundle.completeness}`,
    `# completeness_note=${bundle.completeness_note}`,
    `# cluster=${bundle.cluster}`,
    `# genesis_hash=${bundle.genesis_hash}`,
    `# program_id=${bundle.program_id}`,
    `# scope_type=${bundle.scope.type}`,
    `# scope_mandate=${bundle.scope.mandate ?? ''}`,
    `# scope_from=${bundle.scope.from ?? ''}`,
    `# scope_to=${bundle.scope.to ?? ''}`,
    CSV_COLUMNS.join(','),
  ];
  for (const rec of bundle.decisions) {
    lines.push(rowValues(bundle, rec).map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function bundleToJson(bundle: DecisionBundlePlain): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function recordToJson(record: DecisionRecordPlain): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function formatExport(args: {
  rows: readonly ExportableDecision[];
  scope: ShareScope;
  shape: 'csv' | 'json';
  ctx: ExportContext;
}): string {
  const selected = selectExportRows(args.rows, args.scope);
  if (args.shape === 'json' && args.scope.type === 'decision') {
    const signed = signedExportRows(selected);
    const row = signed[0];
    if (!row) {
      throw new Error(
        'This decision has no transaction signature on this RPC, so it cannot be exported as a record anyone can check.',
      );
    }
    return recordToJson(recordToPlain(row, args.ctx));
  }
  const bundle = makeBundle(selected, args.scope, args.ctx);
  if (args.shape === 'csv') {
    return bundleToCsv(bundle);
  }
  return bundleToJson(bundle);
}

export function parseDayBound(raw: string, endOfDay: boolean): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!day) {
    throw new Error('date must be YYYY-MM-DD');
  }
  const year = Number(day[1]);
  const month = Number(day[2]);
  const date = Number(day[3]);
  if (endOfDay) {
    return Math.floor(Date.UTC(year, month - 1, date, 23, 59, 59) / 1000);
  }
  return Math.floor(Date.UTC(year, month - 1, date) / 1000);
}

export function encodeDecisionId(mandate: string, row: { ts: bigint; kind: number; nonce: bigint }): string {
  return `${mandate}:${row.ts.toString()}:${row.kind}:${row.nonce.toString()}`;
}

export function parseDecisionId(
  id: string,
): { mandate: string; ts: bigint; kind: number; nonce: bigint } | null {
  const parts = id.split(':');
  if (parts.length !== 4) {
    return null;
  }
  const [mandate, tsRaw, kindRaw, nonceRaw] = parts;
  if (!mandate || !tsRaw || !kindRaw || !nonceRaw) {
    return null;
  }
  if (!/^-?\d+$/.test(tsRaw) || !/^\d+$/.test(kindRaw) || !/^-?\d+$/.test(nonceRaw)) {
    return null;
  }
  return {
    mandate,
    ts: BigInt(tsRaw),
    kind: Number.parseInt(kindRaw, 10),
    nonce: BigInt(nonceRaw),
  };
}
