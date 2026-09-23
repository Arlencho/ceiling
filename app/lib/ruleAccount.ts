import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

import { readU64Le } from './constants';

/** createAccountWithSeed limit. A u64 mandate id keeps veto-rule-<id> inside it. */
export const MAX_RULE_TOKEN_SEED_LENGTH = 32;

/** One owner signature, at the base fee. The open transaction has no other signer. */
export const OPEN_SIGNATURE_FEE_LAMPORTS = 5_000n;

export type RuleAccountKind = 'dedicated' | 'associated' | 'other';

export function ruleTokenSeed(mandateId: bigint): string {
  const seed = `veto-rule-${mandateId.toString(10)}`;
  if (seed.length > MAX_RULE_TOKEN_SEED_LENGTH) {
    throw new Error(
      `rule token seed is ${seed.length} bytes, and the limit is ${MAX_RULE_TOKEN_SEED_LENGTH}`,
    );
  }
  return seed;
}

export async function deriveRuleTokenAccount(
  owner: PublicKey,
  mandateId: bigint,
  tokenProgram: PublicKey,
): Promise<PublicKey> {
  return PublicKey.createWithSeed(owner, ruleTokenSeed(mandateId), tokenProgram);
}

export async function classifyRuleSource(args: {
  owner: PublicKey;
  mandateId: bigint;
  mint: PublicKey;
  tokenProgram: PublicKey;
  source: PublicKey;
}): Promise<RuleAccountKind> {
  const dedicated = await deriveRuleTokenAccount(args.owner, args.mandateId, args.tokenProgram);
  if (dedicated.equals(args.source)) {
    return 'dedicated';
  }
  const associated = getAssociatedTokenAddressSync(args.mint, args.owner, false, args.tokenProgram);
  if (associated.equals(args.source)) {
    return 'associated';
  }
  return 'other';
}

export function readMintDecimals(data: Uint8Array): number {
  if (data.length < 45) {
    throw new Error('The mint account is too short to read decimals, so the transfer was not built.');
  }
  const decimals = data[44] ?? 0;
  if (decimals > 18) {
    throw new Error(`Mint decimals ${decimals} are outside the range this app can transfer.`);
  }
  return decimals;
}

export function readTokenAmount(data: Uint8Array): bigint | null {
  if (data.length < 72) {
    return null;
  }
  return readU64Le(data, 64);
}

export function budgetLine(kind: RuleAccountKind): string {
  if (kind === 'dedicated') {
    return "The budget sits in this rule's own account and comes back to you when you close the rule.";
  }
  if (kind === 'associated') {
    return 'This rule keeps its budget in the associated token account it was opened with. Closing returns the mandate rent and leaves that token account in place.';
  }
  return 'This rule spends from the token account shown above. Closing returns the mandate rent and leaves that token account in place.';
}

export function closeNote(kind: RuleAccountKind, stillActive: boolean): string {
  if (stillActive && kind === 'dedicated') {
    return 'This signature revokes the rule first, because it is still marked active, then returns any remaining budget and the rent.';
  }
  if (stillActive) {
    return 'This signature revokes the rule first, because it is still marked active, then returns the mandate and ledger rent. The token account stays open.';
  }
  if (kind === 'dedicated') {
    return 'This signature returns any remaining budget to your token account and the rent to your wallet.';
  }
  return 'This signature returns the mandate and ledger rent to your wallet. The token account stays open.';
}

export function openFundsRefusal(args: {
  ata: PublicKey;
  ataFound: boolean;
  balance: bigint;
  cap: bigint;
  solBalance: bigint;
  tokenRent: bigint;
  mandateRent: bigint;
  ledgerRent: bigint;
  feeLamports: bigint;
}): string | null {
  const solNeeded = args.tokenRent + args.mandateRent + args.ledgerRent + args.feeLamports;
  const parts: string[] = [];
  if (!args.ataFound || args.balance < args.cap) {
    const held = args.ataFound ? args.balance : 0n;
    const short = args.cap - held;
    const where = args.ataFound
      ? `The associated token account ${args.ata.toBase58()} holds ${held.toString()} base units.`
      : `The associated token account ${args.ata.toBase58()} was not found. It holds 0 base units.`;
    parts.push(
      `${where} This rule needs ${args.cap.toString()}. Short by ${short.toString()} base units.`,
    );
  }
  if (args.solBalance < solNeeded) {
    const short = solNeeded - args.solBalance;
    parts.push(
      `The wallet holds ${args.solBalance.toString()} lamports. This open needs ${solNeeded.toString()} lamports: ${args.tokenRent.toString()} for the rule token account, ${args.mandateRent.toString()} for the mandate, ${args.ledgerRent.toString()} for the ledger, and ${args.feeLamports.toString()} for the fee. Short by ${short.toString()} lamports.`,
    );
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(' ');
}
