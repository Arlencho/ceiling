import { Buffer } from 'buffer';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

import { OPEN_MANDATE_DISC, REVOKE_MANDATE_DISC, writeI64Le, writeU32Le, writeU64Le } from './constants';
import { ledgerPda, mandatePda } from './ring';

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

export function revokeMandateInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  mandate: PublicKey;
  source: PublicKey;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  const ledger = ledgerPda(args.programId, args.mandate);
  return new TransactionInstruction({
    programId: args.programId,
    data: Buffer.from(REVOKE_MANDATE_DISC),
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.mandate, isSigner: false, isWritable: true },
      { pubkey: ledger, isSigner: false, isWritable: true },
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
    ],
  });
}
