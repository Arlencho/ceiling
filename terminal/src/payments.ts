/** Reads what arrived at the merchant token account.
 *
 * Amounts are computed as the per-account token balance delta inside each
 * confirmed transaction, in bigint base units. Only positive deltas are
 * payments to the terminal.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";

export type Payment = {
  signature: string;
  blockTime: string | null;
  amount: bigint;
};

/** Token delta for one account inside one parsed transaction.
 *
 * Matches by the account address itself (via the message account keys), not
 * by owner plus mint, so a second account of the same owner cannot be
 * counted twice.
 */
export function receivedForAccount(
  tx: ParsedTransactionWithMeta,
  tokenAccount: string,
): bigint {
  const keys = tx.transaction.message.accountKeys;
  const post = tx.meta?.postTokenBalances ?? [];
  const pre = tx.meta?.preTokenBalances ?? [];
  let total = 0n;
  for (const postBal of post) {
    const key = keys[postBal.accountIndex];
    if (key === undefined || key.pubkey.toBase58() !== tokenAccount) continue;
    const preBal = pre.find((b) => b.accountIndex === postBal.accountIndex);
    const delta = BigInt(postBal.uiTokenAmount.amount) - BigInt(preBal?.uiTokenAmount.amount ?? "0");
    if (delta > 0n) total += delta;
  }
  return total;
}

export async function fetchBalance(args: {
  connection: Connection;
  tokenAccount: string;
}): Promise<bigint> {
  const res = await args.connection.getTokenAccountBalance(new PublicKey(args.tokenAccount));
  return BigInt(res.value.amount);
}

export async function fetchPayments(args: {
  connection: Connection;
  tokenAccount: string;
  limit?: number;
}): Promise<Payment[]> {
  const limit = args.limit ?? 10;
  const account = new PublicKey(args.tokenAccount);
  const signatures = await args.connection.getSignaturesForAddress(account, { limit }, "confirmed");
  const payments: Payment[] = [];
  for (const sig of signatures) {
    const tx = await args.connection.getParsedTransaction(sig.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx === null) continue;
    const amount = receivedForAccount(tx, args.tokenAccount);
    if (amount === 0n) continue;
    payments.push({
      signature: sig.signature,
      blockTime: tx.blockTime === null || tx.blockTime === undefined
        ? null
        : new Date(tx.blockTime * 1000).toISOString(),
      amount,
    });
  }
  return payments;
}
