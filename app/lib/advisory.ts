import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type VersionedTransactionResponse,
} from '@solana/web3.js';

import type { LedgerRow } from './ring';

// Memo v1 names the mandate as a read-only account without the mandate's signature.
const MEMO_PROGRAM_ID = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');

export const ADVISORY_MEMO_PREFIX = 'veto-advisory:v1';

export const ADVISORY_DECLINE_LABEL = 'Agent declined (advisory)';

export const KIND_ADVISORY_DECLINE = 100;

const U64_MAX = (1n << 64n) - 1n;

const ADVISORY_MEMO_KEYS = ['mandate', 'amount', 'nonce', 'reason', 'description_sha256'] as const;

export type AdvisoryMemoBody = {
  mandate: string;
  amount: bigint;
  nonce: bigint;
  reason: string;
  descriptionSha256: string;
};

function parseU64(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    return null;
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) {
    return null;
  }
  return parsed;
}

export function parseAdvisoryMemo(text: string): AdvisoryMemoBody | null {
  if (!text.startsWith(ADVISORY_MEMO_PREFIX)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(ADVISORY_MEMO_PREFIX.length));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== ADVISORY_MEMO_KEYS.length ||
    ADVISORY_MEMO_KEYS.some((key) => !Object.hasOwn(record, key))
  ) {
    return null;
  }
  const mandate = record.mandate;
  const amountText = record.amount;
  const nonceText = record.nonce;
  const reason = record.reason;
  const hash = record.description_sha256;
  if (typeof mandate !== 'string' || typeof reason !== 'string') {
    return null;
  }
  if (typeof amountText !== 'string' || typeof nonceText !== 'string' || typeof hash !== 'string') {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return null;
  }
  const amount = parseU64(amountText);
  const nonce = parseU64(nonceText);
  if (amount === null || nonce === null) {
    return null;
  }
  try {
    if (new PublicKey(mandate).toBase58() !== mandate) {
      return null;
    }
  } catch {
    return null;
  }
  return { mandate, amount, nonce, reason, descriptionSha256: hash };
}

export const ADVISORY_DETAIL_LINE =
  'The agent chose not to submit this charge; the program did not decide it.';

type AccountKeys = {
  get(index: number): PublicKey | undefined;
  length: number;
};

type MemoMessage = {
  getAccountKeys(args?: {
    accountKeysFromLookups?: { writable: PublicKey[]; readonly: PublicKey[] } | null;
  }): AccountKeys;
  compiledInstructions: ReadonlyArray<{
    programIdIndex: number;
    accountKeyIndexes: number[];
    data: Uint8Array;
  }>;
  isAccountSigner(index: number): boolean;
  isAccountWritable(index: number): boolean;
};

function memoText(data: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function messageOf(tx: VersionedTransactionResponse): MemoMessage | null {
  const message = tx.transaction?.message as Partial<MemoMessage> | undefined;
  if (
    !message ||
    typeof message.getAccountKeys !== 'function' ||
    typeof message.isAccountSigner !== 'function' ||
    typeof message.isAccountWritable !== 'function' ||
    !message.compiledInstructions
  ) {
    return null;
  }
  return message as MemoMessage;
}

export function advisoryRowFromTransaction(
  signature: string,
  tx: VersionedTransactionResponse,
  mandate: PublicKey,
  agent: PublicKey,
  blockTime: number | null,
  slot: number | null,
): LedgerRow | null {
  try {
    if (tx.meta?.err) {
      return null;
    }
    const message = messageOf(tx);
    if (!message) {
      return null;
    }
    const loaded = tx.meta?.loadedAddresses;
    const keys = loaded
      ? message.getAccountKeys({ accountKeysFromLookups: loaded })
      : message.getAccountKeys();
    let agentSigned = false;
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys.get(i);
      if (key && key.equals(agent) && message.isAccountSigner(i)) {
        agentSigned = true;
        break;
      }
    }
    if (!agentSigned) {
      return null;
    }
    const mandateAddress = mandate.toBase58();
    for (const ix of message.compiledInstructions) {
      const program = keys.get(ix.programIdIndex);
      if (!program || !program.equals(MEMO_PROGRAM_ID)) {
        continue;
      }
      const namesMandate = ix.accountKeyIndexes.some((index) => {
        const key = keys.get(index);
        return (
          !!key &&
          key.equals(mandate) &&
          !message.isAccountSigner(index) &&
          !message.isAccountWritable(index)
        );
      });
      if (!namesMandate) {
        continue;
      }
      const text = memoText(ix.data);
      if (text === null) {
        continue;
      }
      const parsed = parseAdvisoryMemo(text);
      if (!parsed || parsed.mandate !== mandateAddress) {
        continue;
      }
      return {
        ts: BigInt(blockTime ?? 0),
        amount: parsed.amount,
        counterparty: agent.toBase58(),
        nonce: parsed.nonce,
        suggestedOverride: 0n,
        kind: KIND_ADVISORY_DECLINE,
        kindName: 'advisory',
        reason: 0,
        reasonText: parsed.reason,
        signature,
        slot,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function readAdvisoryDeclines(args: {
  mandate: PublicKey;
  agent: PublicKey;
  signatures: readonly ConfirmedSignatureInfo[];
  loadTransaction: (signature: string) => Promise<VersionedTransactionResponse | null>;
}): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  for (const info of args.signatures) {
    try {
      if (info.err) {
        continue;
      }
      if (typeof info.memo !== 'string' || !info.memo.includes(ADVISORY_MEMO_PREFIX)) {
        continue;
      }
      let tx: VersionedTransactionResponse | null = null;
      try {
        tx = await args.loadTransaction(info.signature);
      } catch {
        continue;
      }
      if (!tx) {
        continue;
      }
      const blockTime = info.blockTime ?? tx.blockTime ?? null;
      const row = advisoryRowFromTransaction(
        info.signature,
        tx,
        args.mandate,
        args.agent,
        blockTime,
        info.slot,
      );
      if (row) {
        rows.push(row);
      }
    } catch {
      continue;
    }
  }
  return rows;
}

export function mergeDecisionRows(ring: readonly LedgerRow[], advisory: readonly LedgerRow[]): LedgerRow[] {
  const seen = new Set<string>();
  for (const row of ring) {
    if (row.signature) {
      seen.add(row.signature);
    }
  }
  const extra: LedgerRow[] = [];
  for (const row of advisory) {
    if (row.signature && seen.has(row.signature)) {
      continue;
    }
    if (row.signature) {
      seen.add(row.signature);
    }
    extra.push(row);
  }
  return [...ring, ...extra].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
