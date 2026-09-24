import { Buffer } from 'buffer';
import { ACCOUNT_SIZE, AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

import { readU64Le } from './constants';
import { formatBaseUnits } from './format';

/** createAccountWithSeed limit. A u64 mandate id keeps veto-rule-<id> inside it. */
export const MAX_RULE_TOKEN_SEED_LENGTH = 32;

const DECISION_HISTORY =
  "Closing removes this rule's decision history from the chain, because the ledger closes to the owner.";

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

export function readTokenDelegate(data: Uint8Array): PublicKey | null {
  if (data.length < ACCOUNT_SIZE) {
    return null;
  }
  const raw = AccountLayout.decode(Buffer.from(data.subarray(0, ACCOUNT_SIZE)));
  if (raw.delegateOption !== 1) {
    return null;
  }
  const delegate = new PublicKey(raw.delegate);
  if (delegate.equals(PublicKey.default)) {
    return null;
  }
  return delegate;
}

export function readConfirmedTokenAmount(args: {
  data: Uint8Array;
  accountProgram: PublicKey;
  tokenProgram: PublicKey;
  mint: PublicKey;
  owner: PublicKey;
}): bigint | null {
  if (!args.accountProgram.equals(args.tokenProgram)) {
    return null;
  }
  if (args.data.length < 72) {
    return null;
  }
  const accountMint = new PublicKey(args.data.subarray(0, 32));
  const accountOwner = new PublicKey(args.data.subarray(32, 64));
  // Amount-only buffers leave mint and owner at zero. A set field must match.
  if (!accountMint.equals(PublicKey.default) && !accountMint.equals(args.mint)) {
    return null;
  }
  if (!accountOwner.equals(PublicKey.default) && !accountOwner.equals(args.owner)) {
    return null;
  }
  return readTokenAmount(args.data);
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

export function closedLine(kind: RuleAccountKind): string {
  if (kind === 'dedicated') {
    return 'Closed on chain. The remaining budget and the rent are back with the owner.';
  }
  return 'Closed on chain. The rent is back with the owner.';
}

export function revokeNote(): string {
  return "Revoking ends authority for the agent now and is recorded on chain. This signature clears that account's single delegate. Nothing already paid changes. The decisions stay readable.";
}

export function otherDelegateWarning(ruleName: string): string {
  return `This signature also clears the delegate another rule depends on: ${ruleName}.`;
}

export function closeNote(kind: RuleAccountKind, revokesFirst: boolean): string {
  if (revokesFirst && kind === 'dedicated') {
    return `This signature revokes the rule first, then returns any remaining budget and the rent. ${DECISION_HISTORY}`;
  }
  if (revokesFirst && kind === 'associated') {
    return `This signature revokes the rule first and clears the associated token account's single delegate, then returns the mandate and ledger rent. ${DECISION_HISTORY} The token account stays open.`;
  }
  if (revokesFirst) {
    return `This signature revokes the rule first and clears that token account's single delegate, then returns the mandate and ledger rent. ${DECISION_HISTORY} The token account stays open.`;
  }
  if (kind === 'dedicated') {
    return `This signature returns any remaining budget to your token account and the rent to your wallet. ${DECISION_HISTORY}`;
  }
  return `This signature returns the mandate and ledger rent to your wallet. ${DECISION_HISTORY} The token account stays open.`;
}

export function openFundsRefusal(args: {
  ata: PublicKey;
  ataFound: boolean;
  balance: bigint;
  cap: bigint;
  decimals: number;
}): string | null {
  if (args.ataFound && args.balance >= args.cap) {
    return null;
  }
  const held = args.ataFound ? args.balance : 0n;
  const short = args.cap > held ? args.cap - held : 0n;
  const heldText = formatBaseUnits(held, args.decimals);
  const capText = formatBaseUnits(args.cap, args.decimals);
  const shortText = formatBaseUnits(short, args.decimals);
  const where = args.ataFound
    ? `The associated token account ${args.ata.toBase58()} holds ${heldText}.`
    : `The associated token account ${args.ata.toBase58()} was not found. It holds ${heldText}.`;
  return `${where} This rule needs ${capText}. Short by ${shortText}.`;
}
