import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import {
  buffersEqual,
  KIND_PAID,
  kindName,
  PURPOSE_MAX_LEN,
  readI64Le,
  readU16Le,
  readU32Le,
  readU64Le,
  reasonText,
  STATUS_ACTIVE,
  TRADE_ENTRY_SIZE,
  TRADE_LEDGER_ACCOUNT_SIZE,
  TRADE_LEDGER_CAPACITY,
  TRADE_LEDGER_DISCRIMINATOR,
  TRADE_LEDGER_HEADER_SIZE,
  TRADE_RULE_DISCRIMINATOR,
  u64Le,
} from './constants';
import { formatTokenAmount } from './tokens';
import type { MandateAccount } from './mandate';
import type { LedgerRow, LedgerSnapshot, RingEntry } from './ring';
import { poolByAddress } from './pools';

export const MAX_TRADE_TOKEN_SEED_LENGTH = 32;

export type TradeRuleAccount = {
  address: string;
  owner: string;
  agent: string;
  source: string;
  destination: string;
  inMint: string;
  outMint: string;
  exchangeProgram: string;
  exchangeKind: number;
  pool: string;
  poolAuthority: string;
  poolInVault: string;
  poolOutVault: string;
  poolMint: string;
  poolFeeAccount: string;
  ruleId: bigint;
  cap: bigint;
  spent: bigint;
  perTradeMax: bigint;
  dailyLimit: bigint;
  dailyBuckets: { hour: bigint; amount: bigint }[];
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

function readPubkey(data: Uint8Array, offset: number): { key: string; next: number } {
  return {
    key: new PublicKey(data.subarray(offset, offset + 32)).toBase58(),
    next: offset + 32,
  };
}

export function decodeTradeRuleAccount(address: string, data: Uint8Array): TradeRuleAccount {
  if (data.length < 8 || !buffersEqual(data.subarray(0, 8), TRADE_RULE_DISCRIMINATOR)) {
    throw new Error(`account ${address} does not have the TradeRule discriminator`);
  }
  let o = 8;
  const owner = readPubkey(data, o);
  o = owner.next;
  const agent = readPubkey(data, o);
  o = agent.next;
  const source = readPubkey(data, o);
  o = source.next;
  const destination = readPubkey(data, o);
  o = destination.next;
  const inMint = readPubkey(data, o);
  o = inMint.next;
  const outMint = readPubkey(data, o);
  o = outMint.next;
  const exchangeProgram = readPubkey(data, o);
  o = exchangeProgram.next;
  const exchangeKind = data[o] ?? 0;
  o += 1;
  const pool = readPubkey(data, o);
  o = pool.next;
  const poolAuthority = readPubkey(data, o);
  o = poolAuthority.next;
  const poolInVault = readPubkey(data, o);
  o = poolInVault.next;
  const poolOutVault = readPubkey(data, o);
  o = poolOutVault.next;
  const poolMint = readPubkey(data, o);
  o = poolMint.next;
  const poolFeeAccount = readPubkey(data, o);
  o = poolFeeAccount.next;
  const ruleId = readU64Le(data, o);
  o += 8;
  const cap = readU64Le(data, o);
  o += 8;
  const spent = readU64Le(data, o);
  o += 8;
  const perTradeMax = readU64Le(data, o);
  o += 8;
  const dailyLimit = readU64Le(data, o);
  o += 8;
  const dailyBuckets = Array.from({ length: 25 }, () => {
    const hour = readI64Le(data, o);
    const amount = readU64Le(data, o + 8);
    o += 16;
    return { hour, amount };
  });
  const floorNum = readU64Le(data, o);
  o += 8;
  const floorDen = readU64Le(data, o);
  o += 8;
  const expiresAt = readI64Le(data, o);
  o += 8;
  const overrideAmount = readU64Le(data, o);
  o += 8;
  const overrideNonce = readU64Le(data, o);
  o += 8;
  const lastNonce = readU64Le(data, o);
  o += 8;
  const purposeLen = readU32Le(data, o);
  o += 4;
  if (purposeLen > PURPOSE_MAX_LEN) {
    throw new Error(`purpose longer than the on-chain max (${purposeLen})`);
  }
  if (o + purposeLen > data.length) {
    throw new Error('purpose overruns account data');
  }
  const purpose = Buffer.from(data.subarray(o, o + purposeLen)).toString('utf8');
  o += purposeLen;
  const status = data[o] ?? 0;
  o += 1;
  const tradeCount = readU32Le(data, o);
  o += 4;
  const refusalCount = readU32Le(data, o);
  o += 4;
  const bump = data[o] ?? 0;
  return {
    address,
    owner: owner.key,
    agent: agent.key,
    source: source.key,
    destination: destination.key,
    inMint: inMint.key,
    outMint: outMint.key,
    exchangeProgram: exchangeProgram.key,
    exchangeKind,
    pool: pool.key,
    poolAuthority: poolAuthority.key,
    poolInVault: poolInVault.key,
    poolOutVault: poolOutVault.key,
    poolMint: poolMint.key,
    poolFeeAccount: poolFeeAccount.key,
    ruleId,
    cap,
    spent,
    perTradeMax,
    dailyLimit,
    dailyBuckets,
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

export function tradeRulePda(programId: PublicKey, owner: PublicKey, ruleId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('trade'), owner.toBuffer(), u64Le(ruleId)],
    programId,
  );
  return pda;
}

export function tradeLedgerPda(programId: PublicKey, rule: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('trade-ledger'), rule.toBuffer()],
    programId,
  );
  return pda;
}

export function tradeTokenSeed(ruleId: bigint): string {
  const seed = `veto-trade-${ruleId.toString(10)}`;
  if (seed.length > MAX_TRADE_TOKEN_SEED_LENGTH) {
    throw new Error(
      `trade token seed is ${seed.length} bytes, and the limit is ${MAX_TRADE_TOKEN_SEED_LENGTH}`,
    );
  }
  return seed;
}

export async function deriveTradeTokenAccount(
  owner: PublicKey,
  ruleId: bigint,
  tokenProgram: PublicKey,
): Promise<PublicKey> {
  return PublicKey.createWithSeed(owner, tradeTokenSeed(ruleId), tokenProgram);
}

export function isTradeActive(rule: TradeRuleAccount, nowSec: bigint): boolean {
  return rule.status === STATUS_ACTIVE && nowSec < rule.expiresAt;
}

/** Conservatively count the current hour and the preceding 24 hours. */
export function inputSentToday(rule: Pick<TradeRuleAccount, 'dailyBuckets'>, nowSec: bigint): bigint {
  const hour = nowSec >= 0n ? nowSec / 3600n : (nowSec - 3599n) / 3600n;
  return rule.dailyBuckets.reduce((sum, bucket) =>
    bucket.hour >= hour - 24n ? sum + bucket.amount : sum, 0n);
}

export function outputReceived(rows: readonly Pick<RingEntry, 'kind' | 'amountOut'>[]): bigint {
  let total = 0n;
  for (const row of rows) {
    if (row.kind === KIND_PAID && row.amountOut != null) {
      total += row.amountOut;
    }
  }
  return total;
}

export function floorPriceLabel(args: {
  floorNum: bigint;
  floorDen: bigint;
  inDecimals: number;
  outDecimals: number;
  inSymbol: string;
  outSymbol: string;
}): string {
  if (args.floorDen <= 0n) {
    return 'Floor is not set.';
  }
  const scale = 1_000_000n;
  const numerator = args.floorNum * 10n ** BigInt(args.inDecimals) * scale;
  const denominator = args.floorDen * 10n ** BigInt(args.outDecimals);
  const scaled = denominator === 0n ? 0n : numerator / denominator;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(6, '0').replace(/0+$/, '');
  const price = frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
  return `1 ${args.inSymbol} buys at least ${price} ${args.outSymbol}, from the rate when this rule opened.`;
}

export function tradePairLabel(rule: Pick<TradeRuleAccount, 'pool' | 'inMint' | 'outMint'>): string {
  return poolByAddress(rule.pool)?.pair ?? 'The pinned pool';
}

function decodeTradeEntry(raw: Uint8Array, outMint?: string, outDecimals?: number): RingEntry {
  const kind = raw[80] ?? 0;
  const reason = raw[81] ?? 0;
  return {
    ts: readI64Le(raw, 0),
    amount: readU64Le(raw, 8),
    amountOut: readU64Le(raw, 16),
    minOut: readU64Le(raw, 24),
    counterparty: new PublicKey(raw.subarray(32, 64)).toBase58(),
    nonce: readU64Le(raw, 64),
    suggestedOverride: readU64Le(raw, 72),
    kind,
    kindName: kindName(kind),
    reason,
    reasonText: reasonText(reason),
    outMint,
    outDecimals,
    family: 'trade',
  };
}

export function decodeTradeLedgerAccount(
  address: string,
  data: Uint8Array,
  extra?: { outMint?: string; outDecimals?: number },
): LedgerSnapshot {
  if (data.length < TRADE_LEDGER_ACCOUNT_SIZE) {
    throw new Error(`trade ledger ${address} is ${data.length} bytes, expected ${TRADE_LEDGER_ACCOUNT_SIZE}`);
  }
  if (!buffersEqual(data.subarray(0, 8), TRADE_LEDGER_DISCRIMINATOR)) {
    throw new Error(`trade ledger ${address} does not have the TradeLedger discriminator`);
  }
  const body = data.subarray(8);
  const mandate = new PublicKey(body.subarray(0, 32)).toBase58();
  const total = readU32Le(body, 32);
  const head = readU16Le(body, 36);
  const bump = body[38] ?? 0;
  const occupied = Math.min(total, TRADE_LEDGER_CAPACITY);
  const start = total >= TRADE_LEDGER_CAPACITY ? head % TRADE_LEDGER_CAPACITY : 0;
  const entries: RingEntry[] = [];
  for (let i = 0; i < occupied; i++) {
    const idx = (start + i) % TRADE_LEDGER_CAPACITY;
    const off = TRADE_LEDGER_HEADER_SIZE + idx * TRADE_ENTRY_SIZE;
    entries.push(decodeTradeEntry(body.subarray(off, off + TRADE_ENTRY_SIZE), extra?.outMint, extra?.outDecimals));
  }
  return { address, mandate, total, head, bump, entries };
}

export function withTradeOutput(
  rows: readonly LedgerRow[],
  outMint: string,
  outDecimals: number,
): LedgerRow[] {
  return rows.map((row) => ({ ...row, family: 'trade' as const, outMint, outDecimals }));
}

/** Shape Allow-once already understands. Amounts stay on the input token. */
export function tradeRuleAsMandate(rule: TradeRuleAccount): MandateAccount {
  return {
    address: rule.address,
    owner: rule.owner,
    agent: rule.agent,
    mint: rule.inMint,
    source: rule.source,
    merchant: rule.destination,
    mandateId: rule.ruleId,
    cap: rule.cap,
    spent: rule.spent,
    perTxMax: rule.perTradeMax,
    expiresAt: rule.expiresAt,
    overrideAmount: rule.overrideAmount,
    overrideNonce: rule.overrideNonce,
    lastNonce: rule.lastNonce,
    purpose: rule.purpose,
    status: rule.status,
    spendCount: rule.tradeCount,
    refusalCount: rule.refusalCount,
    bump: rule.bump,
  };
}

export function tradeAmountLabel(amount: bigint, decimals: number, mint: string): string {
  return formatTokenAmount(amount, decimals, mint);
}
