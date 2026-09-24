import { PublicKey } from "@solana/web3.js";
import {
  CHARGE_DISCRIMINATOR,
  PAID_EVENT_DISCRIMINATOR,
  REFUSED_EVENT_DISCRIMINATOR,
} from "./idl.js";
import { reasonText } from "./reasons.js";

const PROGRAM_DATA = /^Program data: ([A-Za-z0-9+/=]+)$/;
const PROGRAM_INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/;
const PROGRAM_END = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed\b.*)$/;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type DecisionKind = "paid" | "refused" | "advisory_declined";

export type TxMessageHeader = {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
};

export type Decision = {
  signature: string;
  slot: number;
  timestamp: number | null;
  mandate: string;
  amount: bigint;
  nonce: bigint;
  counterparty: string;
  kind: DecisionKind;
  reason: number;
  reasonText: string;
  suggestedOverride: bigint;
  /** Set when kind is advisory_declined. The reason written in the memo. */
  advisoryReason?: string;
  /** Set when kind is advisory_declined. Lowercase hex sha256 of the description. */
  descriptionSha256?: string;
};

type CompiledIx = {
  programId: string;
  accounts: string[];
  data: Buffer;
};

export type TxView = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  logs: string[];
  accountKeys: string[];
  instructions: CompiledIx[];
  /** Absent when the RPC message has no header. Advisory reads need it to name the signers. */
  header?: TxMessageHeader | null;
  /** Static account keys. Loaded addresses, when present, follow them in accountKeys. */
  staticKeyCount?: number;
  loadedWritableCount?: number;
};

type KeyLike = string | PublicKey | { toBase58: () => string; pubkey?: unknown };

type RpcInstruction = {
  programIdIndex: number;
  accounts?: number[];
  accountKeyIndexes?: number[];
  data: string | Uint8Array | number[];
};

type RpcMessage = {
  header?: {
    numRequiredSignatures?: number;
    numReadonlySignedAccounts?: number;
    numReadonlyUnsignedAccounts?: number;
  };
  accountKeys?: KeyLike[];
  staticAccountKeys?: KeyLike[];
  instructions?: RpcInstruction[];
  compiledInstructions?: RpcInstruction[];
};

export type RpcTransaction = {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    logMessages?: string[] | null;
    loadedAddresses?: { writable?: KeyLike[]; readonly?: KeyLike[] };
  } | null;
  transaction?: {
    signatures?: string[];
    message?: RpcMessage;
  };
};

// Solana writes one frame per program: "Program <id> invoke [n]" ... success or failed.
// Program log and Program data belong to the program on top of that stack.
// A sibling instruction cannot supply a Veto line or a Paid event.
// A trace with no invoke line has nothing to separate, so those lines stay.
export function linesForProgram(logs: readonly string[], programId: string): readonly string[] {
  let framed = false;
  for (const line of logs) {
    if (PROGRAM_INVOKE.test(line)) {
      framed = true;
      break;
    }
  }
  if (!framed) return logs;
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of logs) {
    const invoke = PROGRAM_INVOKE.exec(line);
    if (invoke?.[1]) {
      stack.push(invoke[1]);
      continue;
    }
    const ended = PROGRAM_END.exec(line);
    const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
    if (ended?.[1] && top !== undefined && top === ended[1]) {
      stack.pop();
      continue;
    }
    if (!line.startsWith("Program log:") && !line.startsWith("Program data:")) continue;
    if (top === programId) out.push(line);
  }
  return out;
}

export type DecodedEvent = {
  kind: DecisionKind;
  mandate: string;
  amount: bigint;
  nonce: bigint;
  reason: number;
  suggestedOverride: bigint;
};

function readU64Le(buf: Uint8Array, offset: number): bigint {
  return Buffer.from(buf.subarray(offset, offset + 8)).readBigUInt64LE(0);
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function decodeBase58(str: string): Buffer {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  bytes.reverse();
  let leading = 0;
  for (const c of str) {
    if (c === "1") leading += 1;
    else break;
  }
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(bytes)]);
}

export function decodeEventBytes(raw: Uint8Array): DecodedEvent | null {
  if (raw.length < 8) return null;
  const disc = raw.subarray(0, 8);
  if (buffersEqual(disc, PAID_EVENT_DISCRIMINATOR)) {
    if (raw.length < 64) return null;
    return {
      kind: "paid",
      mandate: new PublicKey(raw.subarray(8, 40)).toBase58(),
      amount: readU64Le(raw, 40),
      nonce: readU64Le(raw, 48),
      reason: 0,
      suggestedOverride: 0n,
    };
  }
  if (buffersEqual(disc, REFUSED_EVENT_DISCRIMINATOR)) {
    if (raw.length < 65) return null;
    return {
      kind: "refused",
      mandate: new PublicKey(raw.subarray(8, 40)).toBase58(),
      amount: readU64Le(raw, 40),
      nonce: readU64Le(raw, 48),
      reason: raw[56] ?? 0,
      suggestedOverride: readU64Le(raw, 57),
    };
  }
  return null;
}

export function decodeEventsFromLogs(logs: readonly string[], programId?: string): DecodedEvent[] {
  const source = programId === undefined ? logs : linesForProgram(logs, programId);
  const out: DecodedEvent[] = [];
  for (const line of source) {
    const match = PROGRAM_DATA.exec(line);
    if (!match?.[1]) continue;
    const raw = Buffer.from(match[1], "base64");
    const event = decodeEventBytes(raw);
    if (event) out.push(event);
  }
  return out;
}

function ixData(data: string | Uint8Array | number[]): Buffer {
  if (typeof data === "string") return decodeBase58(data);
  return Buffer.from(data);
}

function isChargeIx(ix: CompiledIx): boolean {
  return ix.data.length >= 8 && buffersEqual(ix.data.subarray(0, 8), CHARGE_DISCRIMINATOR);
}

function counterpartyFromCharge(tx: TxView, mandate: string): string {
  for (const ix of tx.instructions) {
    if (!isChargeIx(ix)) continue;
    if (ix.accounts.length < 5) continue;
    if (ix.accounts[1] === mandate || ix.accounts.includes(mandate)) {
      return ix.accounts[4] ?? "";
    }
  }
  const charge = tx.instructions.find(isChargeIx);
  return charge?.accounts[4] ?? "";
}

// A Veto frame without its Program data event is not a decision. The program
// writes the text line before emit!, so a text line alone is a cut log.
export function decisionsFromTx(tx: TxView, programId: string, mandateFilter?: string): Decision[] {
  if (tx.err) return [];
  const events = decodeEventsFromLogs(tx.logs, programId);
  const out: Decision[] = [];
  for (const event of events) {
    if (mandateFilter && event.mandate !== mandateFilter) continue;
    out.push({
      signature: tx.signature,
      slot: tx.slot,
      timestamp: tx.blockTime,
      mandate: event.mandate,
      amount: event.amount,
      nonce: event.nonce,
      counterparty: counterpartyFromCharge(tx, event.mandate),
      kind: event.kind,
      reason: event.reason,
      reasonText: reasonText(event.reason),
      suggestedOverride: event.suggestedOverride,
    });
  }
  return out;
}

function keyToBase58(value: KeyLike): string {
  if (typeof value === "string") return value;
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value.toBase58 === "function") return value.toBase58();
  throw new Error("events.keyToBase58: not a public key");
}

function messageKeys(tx: RpcTransaction): {
  keys: string[];
  staticKeyCount: number;
  loadedWritableCount: number;
} {
  const message = tx.transaction?.message;
  const staticKeys = message?.staticAccountKeys ?? message?.accountKeys ?? [];
  const loadedW = tx.meta?.loadedAddresses?.writable ?? [];
  const loadedR = tx.meta?.loadedAddresses?.readonly ?? [];
  return {
    keys: [
      ...staticKeys.map((key) => keyToBase58(key)),
      ...loadedW.map((key) => keyToBase58(key)),
      ...loadedR.map((key) => keyToBase58(key)),
    ],
    staticKeyCount: staticKeys.length,
    loadedWritableCount: loadedW.length,
  };
}

function headerOf(message: RpcMessage | undefined): TxMessageHeader | null {
  const header = message?.header;
  if (!header) return null;
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = header;
  if (
    typeof numRequiredSignatures !== "number" ||
    typeof numReadonlySignedAccounts !== "number" ||
    typeof numReadonlyUnsignedAccounts !== "number"
  ) {
    return null;
  }
  return { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts };
}

function instructionsOf(message: RpcMessage | undefined, keys: string[]): CompiledIx[] {
  const compiled = message?.compiledInstructions;
  const legacy = message?.instructions;
  const raw = compiled && compiled.length > 0 ? compiled : (legacy ?? []);
  return raw.map((ix) => {
    const indexes = ix.accountKeyIndexes ?? ix.accounts ?? [];
    return {
      programId: keys[ix.programIdIndex] ?? "",
      accounts: indexes.map((index) => keys[index] ?? ""),
      data: ixData(ix.data),
    };
  });
}

export function viewFromRpc(
  tx: RpcTransaction,
  fallback: { signature: string; slot: number },
): TxView {
  const message = tx.transaction?.message;
  const listed = messageKeys(tx);
  return {
    signature: tx.transaction?.signatures?.[0] || fallback.signature,
    slot: typeof tx.slot === "number" ? tx.slot : fallback.slot,
    blockTime: tx.blockTime ?? null,
    err: tx.meta?.err ?? null,
    logs: tx.meta?.logMessages ?? [],
    accountKeys: listed.keys,
    instructions: instructionsOf(message, listed.keys),
    header: headerOf(message),
    staticKeyCount: listed.staticKeyCount,
    loadedWritableCount: listed.loadedWritableCount,
  };
}

export function compareDecisions(a: Decision, b: Decision): number {
  const ta = a.timestamp ?? 0;
  const tb = b.timestamp ?? 0;
  if (ta !== tb) return ta - tb;
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1;
  return a.signature.localeCompare(b.signature);
}
