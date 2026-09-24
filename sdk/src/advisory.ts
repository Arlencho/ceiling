import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Decision, TxView } from "./events.js";

/**
 * SPL Memo program (v1). The memo text is the instruction data, UTF-8.
 * This deployment accepts a read-only non-signer in the account list.
 * MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr requires every account on the
 * instruction to sign, so it cannot name the mandate without the mandate's signature.
 */
export const MEMO_PROGRAM_ID = new PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");

export const ADVISORY_MEMO_PREFIX = "veto-advisory:v1";

/** Reason field stored in the memo, in UTF-8 bytes, cut on a character boundary. */
export const ADVISORY_REASON_MAX_BYTES = 256;

/** Shown on an advisory record. This is not a program refusal. */
export const ADVISORY_DECLINED_TEXT = "Agent declined (advisory)";

const U64_MAX = (1n << 64n) - 1n;

export type PurposeCheckContext = {
  /** Purpose string stored on the mandate. */
  purpose: string;
  /** Charge amount in base units. */
  amount: bigint;
  /** Mint decimals. */
  decimals: number;
  /** Mandate merchant address. */
  payee: string;
  /** Mandate address. */
  mandate: string;
  /** Caller description of this charge. */
  description: string;
};

export type PurposeCheckResult = {
  allow: boolean;
  reason: string;
};

/** Caller-supplied check. The SDK does not call a model. */
export type PurposeCheck = (ctx: PurposeCheckContext) => Promise<PurposeCheckResult>;

export type AdvisoryBody = {
  mandate: string;
  amount: bigint;
  nonce: bigint;
  reason: string;
  descriptionSha256: string;
};

export function capAdvisoryReason(reason: string): string {
  const buf = Buffer.from(reason, "utf8");
  if (buf.length <= ADVISORY_REASON_MAX_BYTES) return reason;
  let end = ADVISORY_REASON_MAX_BYTES;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  if (end < buf.length) {
    const lead = buf[end]!;
    if ((lead & 0xc0) !== 0x80 && end + utf8Width(lead) > ADVISORY_REASON_MAX_BYTES) {
      return buf.subarray(0, end).toString("utf8");
    }
  }
  return buf.subarray(0, end).toString("utf8");
}

function utf8Width(lead: number): number {
  if ((lead & 0x80) === 0) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

export function descriptionSha256(description: string): string {
  return createHash("sha256").update(description, "utf8").digest("hex");
}

export function advisoryMemoText(fields: {
  mandate: string;
  amount: bigint;
  nonce: bigint;
  reason: string;
  description: string;
}): { text: string; reason: string } {
  const reason = capAdvisoryReason(fields.reason);
  const text =
    ADVISORY_MEMO_PREFIX +
    JSON.stringify({
      mandate: fields.mandate,
      amount: fields.amount.toString(),
      nonce: fields.nonce.toString(),
      reason,
      description_sha256: descriptionSha256(fields.description),
    });
  return { text, reason };
}

export function advisoryMemoInstruction(
  agent: PublicKey,
  mandate: PublicKey,
  memo: string,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [
      { pubkey: agent, isSigner: true, isWritable: false },
      { pubkey: mandate, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(memo, "utf8"),
  });
}

type AccountFlag = { signer: boolean; writable: boolean };

function accountFlags(tx: TxView): AccountFlag[] | null {
  const header = tx.header;
  if (!header) return null;
  const keys = tx.accountKeys;
  const staticCount = tx.staticKeyCount ?? keys.length;
  const loadedWritable = tx.loadedWritableCount ?? 0;
  const req = header.numRequiredSignatures;
  const roSigned = header.numReadonlySignedAccounts;
  const roUnsigned = header.numReadonlyUnsignedAccounts;
  if (
    !Number.isInteger(req) ||
    !Number.isInteger(roSigned) ||
    !Number.isInteger(roUnsigned) ||
    !Number.isInteger(staticCount) ||
    !Number.isInteger(loadedWritable)
  ) {
    return null;
  }
  if (req < 1 || roSigned < 0 || roUnsigned < 0 || staticCount < 0 || loadedWritable < 0) return null;
  if (roSigned > req || req > staticCount || staticCount > keys.length) return null;
  if (roUnsigned > staticCount - req) return null;
  const writableSigners = req - roSigned;
  const writableUnsigned = staticCount - req - roUnsigned;
  const flags: AccountFlag[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    if (i < staticCount) {
      const signer = i < req;
      const writable = signer ? i < writableSigners : i < req + writableUnsigned;
      flags.push({ signer, writable });
    } else {
      flags.push({ signer: false, writable: i - staticCount < loadedWritable });
    }
  }
  return flags;
}

function decodeUtf8(data: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function parseU64(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed > U64_MAX) return null;
  return parsed;
}

export function parseAdvisoryMemo(text: string): AdvisoryBody | null {
  if (!text.startsWith(ADVISORY_MEMO_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(ADVISORY_MEMO_PREFIX.length));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expected = ["mandate", "amount", "nonce", "reason", "description_sha256"];
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) return null;
  const mandate = record.mandate;
  const amountText = record.amount;
  const nonceText = record.nonce;
  const reason = record.reason;
  const hash = record.description_sha256;
  if (typeof mandate !== "string" || typeof reason !== "string") return null;
  if (typeof amountText !== "string" || typeof nonceText !== "string" || typeof hash !== "string") return null;
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const amount = parseU64(amountText);
  const nonce = parseU64(nonceText);
  if (amount === null || nonce === null) return null;
  try {
    if (new PublicKey(mandate).toBase58() !== mandate) return null;
  } catch {
    return null;
  }
  return { mandate, amount, nonce, reason, descriptionSha256: hash };
}

/**
 * An advisory decline from this transaction, or nothing.
 * Counted only when the transaction succeeded, the mandate's agent signed it,
 * the memo names that mandate as a read-only non-signer, and the text is veto-advisory:v1.
 */
export function advisoryDecisionsFromTx(tx: TxView, mandate: string, agent: string): Decision[] {
  if (tx.err) return [];
  if (!mandate || !agent) return [];
  const flags = accountFlags(tx);
  if (!flags) return [];
  const agentSigned = flags.some((flag, index) => flag.signer && tx.accountKeys[index] === agent);
  if (!agentSigned) return [];
  const memoProgram = MEMO_PROGRAM_ID.toBase58();
  const out: Decision[] = [];
  for (const ix of tx.instructions) {
    if (ix.programId !== memoProgram) continue;
    const namesMandate = ix.accounts.some((pubkey) => {
      if (pubkey !== mandate) return false;
      const index = tx.accountKeys.indexOf(pubkey);
      const flag = index >= 0 ? flags[index] : undefined;
      return flag !== undefined && !flag.signer && !flag.writable;
    });
    if (!namesMandate) continue;
    const text = decodeUtf8(ix.data);
    if (text === null) continue;
    const parsed = parseAdvisoryMemo(text);
    if (!parsed || parsed.mandate !== mandate) continue;
    out.push({
      signature: tx.signature,
      slot: tx.slot,
      timestamp: tx.blockTime,
      mandate,
      amount: parsed.amount,
      nonce: parsed.nonce,
      counterparty: "",
      kind: "advisory_declined",
      reason: 0,
      reasonText: ADVISORY_DECLINED_TEXT,
      suggestedOverride: 0n,
      advisoryReason: parsed.reason,
      descriptionSha256: parsed.descriptionSha256,
    });
  }
  return out;
}
