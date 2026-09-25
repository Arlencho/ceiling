import { PublicKey } from "@solana/web3.js";
import {
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TRADE_LEDGER_DISCRIMINATOR,
  TRADE_RULE_DISCRIMINATOR,
} from "./idl.js";

export const LEDGER_CAPACITY = 32;
export const ENTRY_SIZE = 72;
/** Bytes of the ledger body before the first entry, after the 8-byte discriminator. */
export const LEDGER_HEADER_SIZE = 40;
/** Byte offset of the agent pubkey: the 8-byte discriminator, then the owner pubkey. */
export const MANDATE_AGENT_OFFSET = 8 + 32;
/**
 * TradeRule agent pubkey. Same slot as a mandate (discriminator, then owner),
 * so a getProgramAccounts filter also has to match the TradeRule discriminator.
 * Borsh does not pad the exchange_kind byte that sits in front of the pool pubkey.
 */
export const TRADE_RULE_AGENT_OFFSET = 8 + 32;
export const TRADE_LEDGER_CAPACITY = 32;
/** repr(C) TradeEntry: four u64/i64 words, a pubkey, two more u64s, kind, reason, 6 pad bytes. */
export const TRADE_ENTRY_SIZE = 88;
/** rule pubkey, total u32, head u16, bump u8, one pad byte. After the discriminator. */
export const TRADE_LEDGER_HEADER_SIZE = 40;
/** Fixed window the program uses for the daily total. */
export const TRADE_WINDOW_SECS = 24 * 60 * 60;

export type MandateAccount = {
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  source: PublicKey;
  merchant: PublicKey;
  mandateId: bigint;
  cap: bigint;
  spent: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  overrideAmount: bigint;
  overrideNonce: bigint;
  lastNonce: bigint;
  purpose: string;
  status: number;
  spendCount: number;
  refusalCount: number;
  bump: number;
};

export type LedgerEntry = {
  ts: bigint;
  amount: bigint;
  counterparty: PublicKey;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  reason: number;
};

export type LedgerAccount = {
  mandate: PublicKey;
  total: number;
  head: number;
  bump: number;
  entries: LedgerEntry[];
};

export function u64Le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function asU64(value: bigint | number, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new Error(`${field} is outside u64`);
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer or a bigint`);
  }
  return BigInt(value);
}

export function toPublicKey(value: PublicKey | string, field: string): PublicKey {
  if (value instanceof PublicKey) return value;
  try {
    return new PublicKey(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${field} is not a public key: ${message}`);
  }
}

/** PDA seeds: "mandate", owner, mandate id as a u64 little-endian. */
export function mandatePda(programId: PublicKey, owner: PublicKey, mandateId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), owner.toBuffer(), u64Le(mandateId)],
    programId,
  );
  return pda;
}

/** PDA seeds: "ledger", mandate address. */
export function ledgerPda(programId: PublicKey, mandate: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ledger"), mandate.toBuffer()],
    programId,
  );
  return pda;
}

function requireDisc(data: Buffer, expected: Buffer, what: string): void {
  if (data.length < expected.length || !data.subarray(0, expected.length).equals(expected)) {
    throw new Error(`${what} account discriminator mismatch`);
  }
}

function need(data: Buffer, offset: number, length: number, what: string): void {
  if (offset < 0 || offset + length > data.length) {
    throw new Error(`${what} overruns account data`);
  }
}

function readPubkey(data: Buffer, offset: number, what: string): [PublicKey, number] {
  need(data, offset, 32, what);
  return [new PublicKey(data.subarray(offset, offset + 32)), offset + 32];
}

function readU64(data: Buffer, offset: number, what: string): [bigint, number] {
  need(data, offset, 8, what);
  return [data.readBigUInt64LE(offset), offset + 8];
}

function readI64(data: Buffer, offset: number, what: string): [bigint, number] {
  need(data, offset, 8, what);
  return [data.readBigInt64LE(offset), offset + 8];
}

function readU32(data: Buffer, offset: number, what: string): [number, number] {
  need(data, offset, 4, what);
  return [data.readUInt32LE(offset), offset + 4];
}

function readU8(data: Buffer, offset: number, what: string): [number, number] {
  need(data, offset, 1, what);
  return [data.readUInt8(offset), offset + 1];
}

function readString(data: Buffer, offset: number): [string, number] {
  const [len, mid] = readU32(data, offset, "purpose length");
  if (len > 64) throw new Error(`purpose longer than on-chain max (${len})`);
  need(data, mid, len, "purpose");
  return [data.subarray(mid, mid + len).toString("utf8"), mid + len];
}

export function decodeMandate(data: Buffer): MandateAccount {
  requireDisc(data, MANDATE_DISCRIMINATOR, "Mandate");
  let o = 8;
  let owner: PublicKey;
  let agent: PublicKey;
  let mint: PublicKey;
  let source: PublicKey;
  let merchant: PublicKey;
  [owner, o] = readPubkey(data, o, "owner");
  [agent, o] = readPubkey(data, o, "agent");
  [mint, o] = readPubkey(data, o, "mint");
  [source, o] = readPubkey(data, o, "source");
  [merchant, o] = readPubkey(data, o, "merchant");
  let mandateId: bigint;
  let cap: bigint;
  let spent: bigint;
  let perTxMax: bigint;
  let expiresAt: bigint;
  let overrideAmount: bigint;
  let overrideNonce: bigint;
  let lastNonce: bigint;
  let purpose: string;
  let status: number;
  let spendCount: number;
  let refusalCount: number;
  let bump: number;
  [mandateId, o] = readU64(data, o, "mandate_id");
  [cap, o] = readU64(data, o, "cap");
  [spent, o] = readU64(data, o, "spent");
  [perTxMax, o] = readU64(data, o, "per_tx_max");
  [expiresAt, o] = readI64(data, o, "expires_at");
  [overrideAmount, o] = readU64(data, o, "override_amount");
  [overrideNonce, o] = readU64(data, o, "override_nonce");
  [lastNonce, o] = readU64(data, o, "last_nonce");
  [purpose, o] = readString(data, o);
  [status, o] = readU8(data, o, "status");
  [spendCount, o] = readU32(data, o, "spend_count");
  [refusalCount, o] = readU32(data, o, "refusal_count");
  [bump] = readU8(data, o, "bump");
  return {
    owner,
    agent,
    mint,
    source,
    merchant,
    mandateId,
    cap,
    spent,
    perTxMax,
    expiresAt,
    overrideAmount,
    overrideNonce,
    lastNonce,
    purpose,
    status,
    spendCount,
    refusalCount,
    bump,
  };
}

function decodeEntry(data: Buffer, offset: number): LedgerEntry {
  need(data, offset, ENTRY_SIZE, "ledger entry");
  return {
    ts: data.readBigInt64LE(offset),
    amount: data.readBigUInt64LE(offset + 8),
    counterparty: new PublicKey(data.subarray(offset + 16, offset + 48)),
    nonce: data.readBigUInt64LE(offset + 48),
    suggestedOverride: data.readBigUInt64LE(offset + 56),
    kind: data.readUInt8(offset + 64),
    reason: data.readUInt8(offset + 65),
  };
}

export function decodeLedger(data: Buffer): LedgerAccount {
  requireDisc(data, LEDGER_DISCRIMINATOR, "Ledger");
  const min = 8 + LEDGER_HEADER_SIZE + LEDGER_CAPACITY * ENTRY_SIZE;
  if (data.length < min) {
    throw new Error(`Ledger account is ${data.length} bytes, need ${min}`);
  }
  const mandate = new PublicKey(data.subarray(8, 40));
  const total = data.readUInt32LE(40);
  const head = data.readUInt16LE(44);
  const bump = data.readUInt8(46);
  const entries: LedgerEntry[] = [];
  const base = 8 + LEDGER_HEADER_SIZE;
  for (let i = 0; i < LEDGER_CAPACITY; i += 1) {
    entries.push(decodeEntry(data, base + i * ENTRY_SIZE));
  }
  return { mandate, total, head, bump, entries };
}

export type TradeRuleAccount = {
  owner: PublicKey;
  agent: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  inMint: PublicKey;
  outMint: PublicKey;
  exchangeProgram: PublicKey;
  exchangeKind: number;
  pool: PublicKey;
  poolAuthority: PublicKey;
  poolInVault: PublicKey;
  poolOutVault: PublicKey;
  poolMint: PublicKey;
  poolFeeAccount: PublicKey;
  ruleId: bigint;
  cap: bigint;
  spent: bigint;
  perTradeMax: bigint;
  dailyLimit: bigint;
  windowSpent: bigint;
  windowStart: bigint;
  floorNum: bigint;
  floorDen: bigint;
  expiresAt: bigint;
  overrideAmount: bigint;
  overrideNonce: bigint;
  lastNonce: bigint;
  purpose: string;
  status: number;
  tradeCount: number;
  refusalCount: number;
  bump: number;
};

export type TradeLedgerEntry = {
  ts: bigint;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  counterparty: PublicKey;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  reason: number;
};

export type TradeLedgerAccount = {
  rule: PublicKey;
  total: number;
  head: number;
  bump: number;
  /** Live ring entries, oldest first. */
  entries: TradeLedgerEntry[];
};

/** PDA seeds: "trade", owner, rule id as a u64 little-endian. */
export function tradeRulePda(programId: PublicKey, owner: PublicKey, ruleId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("trade"), owner.toBuffer(), u64Le(ruleId)],
    programId,
  );
  return pda;
}

/** PDA seeds: "trade-ledger", rule address. */
export function tradeLedgerPda(programId: PublicKey, rule: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("trade-ledger"), rule.toBuffer()],
    programId,
  );
  return pda;
}

export function decodeTradeRule(data: Buffer): TradeRuleAccount {
  requireDisc(data, TRADE_RULE_DISCRIMINATOR, "TradeRule");
  let o = 8;
  let owner: PublicKey;
  let agent: PublicKey;
  let source: PublicKey;
  let destination: PublicKey;
  let inMint: PublicKey;
  let outMint: PublicKey;
  let exchangeProgram: PublicKey;
  let exchangeKind: number;
  let pool: PublicKey;
  let poolAuthority: PublicKey;
  let poolInVault: PublicKey;
  let poolOutVault: PublicKey;
  let poolMint: PublicKey;
  let poolFeeAccount: PublicKey;
  [owner, o] = readPubkey(data, o, "owner");
  [agent, o] = readPubkey(data, o, "agent");
  [source, o] = readPubkey(data, o, "source");
  [destination, o] = readPubkey(data, o, "destination");
  [inMint, o] = readPubkey(data, o, "in_mint");
  [outMint, o] = readPubkey(data, o, "out_mint");
  [exchangeProgram, o] = readPubkey(data, o, "exchange_program");
  [exchangeKind, o] = readU8(data, o, "exchange_kind");
  [pool, o] = readPubkey(data, o, "pool");
  [poolAuthority, o] = readPubkey(data, o, "pool_authority");
  [poolInVault, o] = readPubkey(data, o, "pool_in_vault");
  [poolOutVault, o] = readPubkey(data, o, "pool_out_vault");
  [poolMint, o] = readPubkey(data, o, "pool_mint");
  [poolFeeAccount, o] = readPubkey(data, o, "pool_fee_account");
  let ruleId: bigint;
  let cap: bigint;
  let spent: bigint;
  let perTradeMax: bigint;
  let dailyLimit: bigint;
  let windowSpent: bigint;
  let windowStart: bigint;
  let floorNum: bigint;
  let floorDen: bigint;
  let expiresAt: bigint;
  let overrideAmount: bigint;
  let overrideNonce: bigint;
  let lastNonce: bigint;
  let purpose: string;
  let status: number;
  let tradeCount: number;
  let refusalCount: number;
  let bump: number;
  [ruleId, o] = readU64(data, o, "rule_id");
  [cap, o] = readU64(data, o, "cap");
  [spent, o] = readU64(data, o, "spent");
  [perTradeMax, o] = readU64(data, o, "per_trade_max");
  [dailyLimit, o] = readU64(data, o, "daily_limit");
  [windowSpent, o] = readU64(data, o, "window_spent");
  [windowStart, o] = readI64(data, o, "window_start");
  [floorNum, o] = readU64(data, o, "floor_num");
  [floorDen, o] = readU64(data, o, "floor_den");
  [expiresAt, o] = readI64(data, o, "expires_at");
  [overrideAmount, o] = readU64(data, o, "override_amount");
  [overrideNonce, o] = readU64(data, o, "override_nonce");
  [lastNonce, o] = readU64(data, o, "last_nonce");
  [purpose, o] = readString(data, o);
  [status, o] = readU8(data, o, "status");
  [tradeCount, o] = readU32(data, o, "trade_count");
  [refusalCount, o] = readU32(data, o, "refusal_count");
  [bump] = readU8(data, o, "bump");
  return {
    owner,
    agent,
    source,
    destination,
    inMint,
    outMint,
    exchangeProgram,
    exchangeKind,
    pool,
    poolAuthority,
    poolInVault,
    poolOutVault,
    poolMint,
    poolFeeAccount,
    ruleId,
    cap,
    spent,
    perTradeMax,
    dailyLimit,
    windowSpent,
    windowStart,
    floorNum,
    floorDen,
    expiresAt,
    overrideAmount,
    overrideNonce,
    lastNonce,
    purpose,
    status,
    tradeCount,
    refusalCount,
    bump,
  };
}

function decodeTradeEntry(data: Buffer, offset: number): TradeLedgerEntry {
  need(data, offset, TRADE_ENTRY_SIZE, "trade ledger entry");
  return {
    ts: data.readBigInt64LE(offset),
    amountIn: data.readBigUInt64LE(offset + 8),
    amountOut: data.readBigUInt64LE(offset + 16),
    minOut: data.readBigUInt64LE(offset + 24),
    counterparty: new PublicKey(data.subarray(offset + 32, offset + 64)),
    nonce: data.readBigUInt64LE(offset + 64),
    suggestedOverride: data.readBigUInt64LE(offset + 72),
    kind: data.readUInt8(offset + 80),
    reason: data.readUInt8(offset + 81),
  };
}

export function decodeTradeLedger(data: Buffer): TradeLedgerAccount {
  requireDisc(data, TRADE_LEDGER_DISCRIMINATOR, "TradeLedger");
  const min = 8 + TRADE_LEDGER_HEADER_SIZE + TRADE_LEDGER_CAPACITY * TRADE_ENTRY_SIZE;
  if (data.length < min) {
    throw new Error(`TradeLedger account is ${data.length} bytes, need ${min}`);
  }
  const total = data.readUInt32LE(40);
  const head = data.readUInt16LE(44);
  const live = Math.min(total, TRADE_LEDGER_CAPACITY);
  const start = total >= TRADE_LEDGER_CAPACITY ? head % TRADE_LEDGER_CAPACITY : 0;
  const entries: TradeLedgerEntry[] = [];
  const base = 8 + TRADE_LEDGER_HEADER_SIZE;
  for (let n = 0; n < live; n += 1) {
    const index = (start + n) % TRADE_LEDGER_CAPACITY;
    entries.push(decodeTradeEntry(data, base + index * TRADE_ENTRY_SIZE));
  }
  return {
    rule: new PublicKey(data.subarray(8, 40)),
    total,
    head,
    bump: data.readUInt8(46),
    entries,
  };
}
