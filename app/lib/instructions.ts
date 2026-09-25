import { Buffer } from 'buffer';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  CLOSE_MANDATE_DISC,
  CLOSE_TRADE_RULE_DISC,
  GRANT_OVERRIDE_DISC,
  GRANT_TRADE_OVERRIDE_DISC,
  OPEN_MANDATE_DISC,
  OPEN_TRADE_RULE_DISC,
  REVOKE_MANDATE_DISC,
  REVOKE_TRADE_RULE_DISC,
  writeI64Le,
  writeU32Le,
  writeU64Le,
} from './constants';
import { ledgerPda, mandatePda } from './ring';
import { tradeLedgerPda } from './tradeRule';

export type OpenMandateIxArgs = {
  programId: PublicKey;
  owner: PublicKey;
  agent: PublicKey;
  merchant: PublicKey;
  mint: PublicKey;
  source: PublicKey;
  tokenProgram: PublicKey;
  mandateId: bigint;
  cap: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  purpose: string;
};

export function encodeOpenMandateData(args: {
  mandateId: bigint;
  agent: PublicKey;
  merchant: PublicKey;
  cap: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  purpose: string;
}): Buffer {
  const purpose = Buffer.from(args.purpose, 'utf8');
  const buf = Buffer.alloc(8 + 8 + 32 + 32 + 8 + 8 + 8 + 4 + purpose.length);
  OPEN_MANDATE_DISC.copy(buf, 0);
  writeU64Le(buf, 8, args.mandateId);
  Buffer.from(args.agent.toBytes()).copy(buf, 16);
  Buffer.from(args.merchant.toBytes()).copy(buf, 48);
  writeU64Le(buf, 80, args.cap);
  writeU64Le(buf, 88, args.perTxMax);
  writeI64Le(buf, 96, args.expiresAt);
  writeU32Le(buf, 104, purpose.length);
  purpose.copy(buf, 108);
  return buf;
}

export function openMandateInstruction(args: OpenMandateIxArgs): {
  instruction: TransactionInstruction;
  mandate: PublicKey;
  ledger: PublicKey;
} {
  const mandate = mandatePda(args.programId, args.owner, args.mandateId);
  const ledger = ledgerPda(args.programId, mandate);
  const data = encodeOpenMandateData({
    mandateId: args.mandateId,
    agent: args.agent,
    merchant: args.merchant,
    cap: args.cap,
    perTxMax: args.perTxMax,
    expiresAt: args.expiresAt,
    purpose: args.purpose,
  });
  const instruction = new TransactionInstruction({
    programId: args.programId,
    data,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: mandate, isSigner: false, isWritable: true },
      { pubkey: ledger, isSigner: false, isWritable: true },
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  return { instruction, mandate, ledger };
}

export function closeMandateInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  mandate: PublicKey;
}): TransactionInstruction {
  const ledger = ledgerPda(args.programId, args.mandate);
  return new TransactionInstruction({
    programId: args.programId,
    data: Buffer.from(CLOSE_MANDATE_DISC),
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: args.mandate, isSigner: false, isWritable: true },
      { pubkey: ledger, isSigner: false, isWritable: true },
    ],
  });
}

export function revokeMandateInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  mandate: PublicKey;
  source: PublicKey;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    data: Buffer.from(REVOKE_MANDATE_DISC),
    keys: ownerActionKeys(args),
  });
}

export function encodeGrantOverrideData(amount: bigint, nonce: bigint): Buffer {
  const buf = Buffer.alloc(24);
  GRANT_OVERRIDE_DISC.copy(buf, 0);
  writeU64Le(buf, 8, amount);
  writeU64Le(buf, 16, nonce);
  return buf;
}

export function grantOverrideInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  mandate: PublicKey;
  source: PublicKey;
  tokenProgram: PublicKey;
  amount: bigint;
  nonce: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    data: encodeGrantOverrideData(args.amount, args.nonce),
    keys: ownerActionKeys(args),
  });
}

export function encodeOpenTradeData(args: {
  ruleId: bigint;
  agent: PublicKey;
  exchangeKind: number;
  cap: bigint;
  perTradeMax: bigint;
  dailyLimit: bigint;
  floorNum: bigint;
  floorDen: bigint;
  expiresAt: bigint;
  purpose: string;
}): Buffer {
  const purpose = Buffer.from(args.purpose, 'utf8');
  const buf = Buffer.alloc(8 + 8 + 32 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 4 + purpose.length);
  OPEN_TRADE_RULE_DISC.copy(buf, 0);
  let offset = 8;
  writeU64Le(buf, offset, args.ruleId);
  offset += 8;
  Buffer.from(args.agent.toBytes()).copy(buf, offset);
  offset += 32;
  buf[offset] = args.exchangeKind;
  offset += 1;
  writeU64Le(buf, offset, args.cap);
  offset += 8;
  writeU64Le(buf, offset, args.perTradeMax);
  offset += 8;
  writeU64Le(buf, offset, args.dailyLimit);
  offset += 8;
  writeU64Le(buf, offset, args.floorNum);
  offset += 8;
  writeU64Le(buf, offset, args.floorDen);
  offset += 8;
  writeI64Le(buf, offset, args.expiresAt);
  offset += 8;
  writeU32Le(buf, offset, purpose.length);
  offset += 4;
  purpose.copy(buf, offset);
  return buf;
}

export function openTradeRuleInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  rule: PublicKey;
  ledger: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  inMint: PublicKey;
  outMint: PublicKey;
  exchangeProgram: PublicKey;
  pool: PublicKey;
  poolAuthority: PublicKey;
  poolInVault: PublicKey;
  poolOutVault: PublicKey;
  poolMint: PublicKey;
  poolFeeAccount: PublicKey;
  tokenProgram: PublicKey;
  ruleId: bigint;
  agent: PublicKey;
  exchangeKind: number;
  cap: bigint;
  perTradeMax: bigint;
  dailyLimit: bigint;
  floorNum: bigint;
  floorDen: bigint;
  expiresAt: bigint;
  purpose: string;
}): TransactionInstruction {
  const data = encodeOpenTradeData(args);
  return new TransactionInstruction({
    programId: args.programId,
    data,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: args.rule, isSigner: false, isWritable: true },
      { pubkey: args.ledger, isSigner: false, isWritable: true },
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.destination, isSigner: false, isWritable: false },
      { pubkey: args.inMint, isSigner: false, isWritable: false },
      { pubkey: args.outMint, isSigner: false, isWritable: false },
      { pubkey: args.exchangeProgram, isSigner: false, isWritable: false },
      { pubkey: args.pool, isSigner: false, isWritable: false },
      { pubkey: args.poolAuthority, isSigner: false, isWritable: false },
      { pubkey: args.poolInVault, isSigner: false, isWritable: false },
      { pubkey: args.poolOutVault, isSigner: false, isWritable: false },
      { pubkey: args.poolMint, isSigner: false, isWritable: false },
      { pubkey: args.poolFeeAccount, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function grantTradeOverrideInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  rule: PublicKey;
  amount: bigint;
  nonce: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(24);
  GRANT_TRADE_OVERRIDE_DISC.copy(data, 0);
  writeU64Le(data, 8, args.amount);
  writeU64Le(data, 16, args.nonce);
  const ledger = tradeLedgerPda(args.programId, args.rule);
  return new TransactionInstruction({
    programId: args.programId,
    data,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.rule, isSigner: false, isWritable: true },
      { pubkey: ledger, isSigner: false, isWritable: true },
    ],
  });
}

export function revokeTradeRuleInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  rule: PublicKey;
  source: PublicKey;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  const ledger = tradeLedgerPda(args.programId, args.rule);
  return new TransactionInstruction({
    programId: args.programId,
    data: Buffer.from(REVOKE_TRADE_RULE_DISC),
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.rule, isSigner: false, isWritable: true },
      { pubkey: ledger, isSigner: false, isWritable: true },
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
    ],
  });
}

export function closeTradeRuleInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  rule: PublicKey;
  source: PublicKey;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  const ledger = tradeLedgerPda(args.programId, args.rule);
  return new TransactionInstruction({
    programId: args.programId,
    data: Buffer.from(CLOSE_TRADE_RULE_DISC),
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: args.rule, isSigner: false, isWritable: true },
      { pubkey: ledger, isSigner: false, isWritable: true },
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
    ],
  });
}

function ownerActionKeys(args: {
  owner: PublicKey;
  mandate: PublicKey;
  source: PublicKey;
  tokenProgram: PublicKey;
  programId: PublicKey;
}): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  const ledger = ledgerPda(args.programId, args.mandate);
  return [
    { pubkey: args.owner, isSigner: true, isWritable: false },
    { pubkey: args.mandate, isSigner: false, isWritable: true },
    { pubkey: ledger, isSigner: false, isWritable: true },
    { pubkey: args.source, isSigner: false, isWritable: true },
    { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
  ];
}
