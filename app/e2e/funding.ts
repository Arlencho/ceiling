import { createMintToInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

export const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const VTEST_MINT = '2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU';

export async function fundingInstruction(args: {
  mint: PublicKey;
  destination: PublicKey;
  funder: PublicKey;
  amount: bigint;
  readBalance: (address: PublicKey) => Promise<bigint>;
}) {
  const { mint, destination, funder, amount } = args;
  if (mint.toBase58() === USDC_MINT) {
    const source = getAssociatedTokenAddressSync(mint, funder);
    const balance = await args.readBalance(source);
    if (balance < amount) {
      throw new Error(`Funder ${funder.toBase58()} holds ${balance} USDC base units; this journey needs ${amount} USDC base units. Request devnet USDC at https://faucet.circle.com for that funder address.`);
    }
    return createTransferCheckedInstruction(source, mint, destination, funder, amount, 6);
  }
  if (mint.toBase58() !== VTEST_MINT) throw new Error(`Unsupported journey mint ${mint.toBase58()}`);
  return createMintToInstruction(mint, destination, funder, amount);
}
