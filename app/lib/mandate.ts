import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import {
  buffersEqual,
  MANDATE_DISCRIMINATOR,
  PURPOSE_MAX_LEN,
  readI64Le,
  readU32Le,
  readU64Le,
  STATUS_ACTIVE,
} from './constants';
import { remainingCap } from './format';

export type MandateAccount = {
  address: string;
  owner: string;
  agent: string;
  mint: string;
  source: string;
  merchant: string;
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

export function decodeMandateAccount(address: string, data: Uint8Array): MandateAccount {
  if (data.length < 8 || !buffersEqual(data.subarray(0, 8), MANDATE_DISCRIMINATOR)) {
    throw new Error(`account ${address} does not have the Mandate discriminator`);
  }
  let o = 8;
  const owner = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const agent = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const mint = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const source = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const merchant = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const mandateId = readU64Le(data, o);
  o += 8;
  const cap = readU64Le(data, o);
  o += 8;
  const spent = readU64Le(data, o);
  o += 8;
  const perTxMax = readU64Le(data, o);
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
  const spendCount = readU32Le(data, o);
  o += 4;
  const refusalCount = readU32Le(data, o);
  o += 4;
  const bump = data[o] ?? 0;
  return {
    address,
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

export function mandateRemaining(mandate: MandateAccount): bigint {
  return remainingCap(mandate.cap, mandate.spent);
}

export function isActive(mandate: MandateAccount, nowSec: bigint): boolean {
  return mandate.status === STATUS_ACTIVE && nowSec < mandate.expiresAt;
}
