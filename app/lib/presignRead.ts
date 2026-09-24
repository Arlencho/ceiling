import { ACCOUNT_SIZE, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';

import { rentExemptLamports } from './chain';
import { LEDGER_ACCOUNT_SIZE, MANDATE_ACCOUNT_SIZE, OPEN_FEE_MARGIN_LAMPORTS } from './constants';
import type { PresignObservation } from './presign';
import { readMintDecimals } from './ruleAccount';

async function quoteRent(connection: Connection, space: number): Promise<number> {
  if (typeof connection.getMinimumBalanceForRentExemption === 'function') {
    try {
      return await connection.getMinimumBalanceForRentExemption(space);
    } catch {
      return rentExemptLamports(space);
    }
  }
  return rentExemptLamports(space);
}

export async function observePresign(args: {
  connection: Connection;
  owner: PublicKey;
  payee: PublicKey | null;
  mint: PublicKey;
  cluster: string;
}): Promise<PresignObservation> {
  const [tokenRent, mandateRent, ledgerRent, floor] = await Promise.all([
    quoteRent(args.connection, ACCOUNT_SIZE),
    quoteRent(args.connection, MANDATE_ACCOUNT_SIZE),
    quoteRent(args.connection, LEDGER_ACCOUNT_SIZE),
    quoteRent(args.connection, 0),
  ]);
  const observation: PresignObservation = {
    configuredCluster: args.cluster,
    genesisHash: null,
    ownerTokenBalance: null,
    cap: 0n,
    decimals: 0,
    mintReadable: false,
    solLamports: null,
    rentAndFeesLamports: tokenRent + mandateRent + ledgerRent + OPEN_FEE_MARGIN_LAMPORTS,
    walletFloorLamports: floor,
    payeeHasTokenAccount: args.payee ? null : false,
  };

  try {
    observation.genesisHash = await args.connection.getGenesisHash();
  } catch {
    observation.genesisHash = null;
  }
  try {
    observation.solLamports = await args.connection.getBalance(args.owner, 'confirmed');
  } catch {
    observation.solLamports = null;
  }

  let tokenProgram: PublicKey | null = null;
  try {
    const mintInfo = await args.connection.getAccountInfo(args.mint, 'confirmed');
    if (mintInfo) {
      observation.decimals = readMintDecimals(mintInfo.data);
      observation.mintReadable = true;
      tokenProgram = mintInfo.owner;
    }
  } catch {
    observation.mintReadable = false;
  }
  if (!tokenProgram) {
    return observation;
  }

  try {
    const ata = getAssociatedTokenAddressSync(args.mint, args.owner, false, tokenProgram);
    const account = await getAccount(args.connection, ata, 'confirmed', tokenProgram);
    observation.ownerTokenBalance = account.amount;
  } catch {
    observation.ownerTokenBalance = null;
  }

  if (!args.payee) {
    observation.payeeHasTokenAccount = false;
    return observation;
  }
  try {
    const payeeAta = getAssociatedTokenAddressSync(args.mint, args.payee, true, tokenProgram);
    try {
      await getAccount(args.connection, payeeAta, 'confirmed', tokenProgram);
      observation.payeeHasTokenAccount = true;
    } catch {
      const found = await args.connection.getTokenAccountsByOwner(
        args.payee,
        { mint: args.mint },
        'confirmed',
      );
      observation.payeeHasTokenAccount = found.value.length > 0;
    }
  } catch {
    observation.payeeHasTokenAccount = null;
  }
  return observation;
}
