import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccount3Instruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

import { EXCHANGE_KIND_SPL_TOKEN_SWAP, STATUS_ACTIVE } from './constants';
import {
  closeTradeRuleInstruction,
  openTradeRuleInstruction,
  revokeTradeRuleInstruction,
} from './instructions';
import { SPL_TOKEN_SWAP_PROGRAM_ID } from './pools';
import { deriveTradeTokenAccount } from './tradeRule';
import type { PoolSides } from './tradePool';

export type OpenTradeBuild = {
  instructions: TransactionInstruction[];
  source: PublicKey;
  destination: PublicKey;
  rule: PublicKey;
  ledger: PublicKey;
};

export async function buildOpenTradeInstructions(args: {
  programId: PublicKey;
  owner: PublicKey;
  agent: PublicKey;
  rule: PublicKey;
  ledger: PublicKey;
  ruleId: bigint;
  poolAccount: PublicKey;
  pool: PoolSides;
  exchangeProgram?: PublicKey;
  cap: bigint;
  perTradeMax: bigint;
  dailyLimit: bigint;
  floorNum: bigint;
  floorDen: bigint;
  expiresAt: bigint;
  purpose: string;
  tokenRent: number;
  destinationExists: boolean;
  decimals: number;
  /** Owner's associated account of the input mint. Unused when the input is wrapped SOL. */
  ownerInputAta?: PublicKey;
}): Promise<OpenTradeBuild> {
  const tokenProgram = args.pool.tokenProgram;
  const native = args.pool.inputMint.equals(NATIVE_MINT);
  if (native && args.cap > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The total set aside is too large to wrap in one account.');
  }
  const lamports = native ? args.tokenRent + Number(args.cap) : args.tokenRent;
  const source = await deriveTradeTokenAccount(args.owner, args.ruleId, tokenProgram);
  const destination = getAssociatedTokenAddressSync(
    args.pool.outputMint,
    args.owner,
    false,
    tokenProgram,
  );
  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccountWithSeed({
      fromPubkey: args.owner,
      basePubkey: args.owner,
      seed: `veto-trade-${args.ruleId.toString(10)}`,
      newAccountPubkey: source,
      lamports,
      space: ACCOUNT_SIZE,
      programId: tokenProgram,
    }),
    createInitializeAccount3Instruction(source, args.pool.inputMint, args.owner, tokenProgram),
  ];
  if (native) {
    instructions.push(createSyncNativeInstruction(source, tokenProgram));
  } else {
    if (!args.ownerInputAta) {
      throw new Error('The owner account for the input token is missing, so nothing was built.');
    }
    instructions.push(
      createTransferCheckedInstruction(
        args.ownerInputAta,
        args.pool.inputMint,
        source,
        args.owner,
        args.cap,
        args.decimals,
        [],
        tokenProgram,
      ),
    );
  }
  if (!args.destinationExists) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        args.owner,
        destination,
        args.owner,
        args.pool.outputMint,
        tokenProgram,
      ),
    );
  }
  instructions.push(
    openTradeRuleInstruction({
      programId: args.programId,
      owner: args.owner,
      rule: args.rule,
      ledger: args.ledger,
      source,
      destination,
      inMint: args.pool.inputMint,
      outMint: args.pool.outputMint,
      exchangeProgram: args.exchangeProgram ?? SPL_TOKEN_SWAP_PROGRAM_ID,
      pool: args.poolAccount,
      poolAuthority: args.pool.authority,
      poolInVault: args.pool.inputVault,
      poolOutVault: args.pool.outputVault,
      poolMint: args.pool.poolMint,
      poolFeeAccount: args.pool.feeAccount,
      tokenProgram,
      ruleId: args.ruleId,
      agent: args.agent,
      exchangeKind: EXCHANGE_KIND_SPL_TOKEN_SWAP,
      cap: args.cap,
      perTradeMax: args.perTradeMax,
      dailyLimit: args.dailyLimit,
      floorNum: args.floorNum,
      floorDen: args.floorDen,
      expiresAt: args.expiresAt,
      purpose: args.purpose,
    }),
  );
  return { instructions, source, destination, rule: args.rule, ledger: args.ledger };
}

export function buildCloseTradeInstructions(args: {
  programId: PublicKey;
  owner: PublicKey;
  rule: PublicKey;
  source: PublicKey;
  inputMint: PublicKey;
  tokenProgram: PublicKey;
  status: number;
  amount: bigint;
  decimals: number;
  sourceExists: boolean;
  ownerAtaExists: boolean;
}): TransactionInstruction[] {
  const instructions: TransactionInstruction[] = [];
  if (args.status === STATUS_ACTIVE && args.sourceExists) {
    instructions.push(
      revokeTradeRuleInstruction({
        programId: args.programId,
        owner: args.owner,
        rule: args.rule,
        source: args.source,
        tokenProgram: args.tokenProgram,
      }),
    );
  }
  if (args.sourceExists) {
    const native = args.inputMint.equals(NATIVE_MINT);
    if (native) {
      instructions.push(
        createCloseAccountInstruction(args.source, args.owner, args.owner, [], args.tokenProgram),
      );
    } else {
      const ata = getAssociatedTokenAddressSync(args.inputMint, args.owner, false, args.tokenProgram);
      if (args.amount > 0n) {
        if (!args.ownerAtaExists) {
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              args.owner,
              ata,
              args.owner,
              args.inputMint,
              args.tokenProgram,
            ),
          );
        }
        instructions.push(
          createTransferCheckedInstruction(
            args.source,
            args.inputMint,
            ata,
            args.owner,
            args.amount,
            args.decimals,
            [],
            args.tokenProgram,
          ),
        );
      }
      instructions.push(
        createCloseAccountInstruction(args.source, args.owner, args.owner, [], args.tokenProgram),
      );
    }
  }
  instructions.push(
    closeTradeRuleInstruction({
      programId: args.programId,
      owner: args.owner,
      rule: args.rule,
    }),
  );
  return instructions;
}
