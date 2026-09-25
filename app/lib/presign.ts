import { formatTokenAmount } from './tokens';

export const NO_TOKEN_MESSAGE = 'You do not hold this token yet';

export const GENESIS_BY_CLUSTER: Record<string, string> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSWxBspnEYnS3G7sC9e',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export type PresignCheckId = 'tokens' | 'sol' | 'network' | 'payee';

export type PresignCheck = {
  id: PresignCheckId;
  ok: boolean;
  message: string;
  fix: string;
};

export type PresignObservation = {
  configuredCluster: string;
  genesisHash: string | null;
  ownerTokenBalance: bigint | null;
  cap: bigint;
  decimals: number;
  mint?: string | null;
  mintReadable: boolean;
  solLamports: number | null;
  rentAndFeesLamports: number;
  walletFloorLamports: number;
  payeeHasTokenAccount: boolean | null;
};

export function evaluatePresign(observation: PresignObservation): PresignCheck[] {
  return [
    tokenCheck(observation),
    solCheck(observation),
    networkCheck(observation.configuredCluster, observation.genesisHash),
    payeeCheck(observation.payeeHasTokenAccount),
  ];
}

function tokenCheck(observation: PresignObservation): PresignCheck {
  if (!observation.mintReadable) {
    return {
      id: 'tokens',
      ok: false,
      message: 'This mint is not on this network.',
      fix: 'Open this on the network where the token exists.',
    };
  }
  if (observation.ownerTokenBalance == null || observation.ownerTokenBalance <= 0n) {
    return {
      id: 'tokens',
      ok: false,
      message: NO_TOKEN_MESSAGE,
      fix: 'Receive this token in your wallet, then come back.',
    };
  }
  if (observation.ownerTokenBalance < observation.cap) {
    const held = formatTokenAmount(observation.ownerTokenBalance, observation.decimals, observation.mint);
    const cap = formatTokenAmount(observation.cap, observation.decimals, observation.mint);
    return {
      id: 'tokens',
      ok: false,
      message: `You hold ${held}. This cap needs ${cap}.`,
      fix: 'Lower the cap, or receive more of this token in your wallet.',
    };
  }
  return { id: 'tokens', ok: true, message: '', fix: '' };
}

function solCheck(observation: PresignObservation): PresignCheck {
  const needed = observation.rentAndFeesLamports;
  const balance = observation.solLamports;
  const floor = observation.walletFloorLamports;
  const amount = `${formatLamports(needed)} (${needed} lamports)`;
  const returns = 'That rent returns to your wallet when you close the rule.';
  const enough = balance != null && balance >= needed && balance - needed >= floor;
  if (enough) {
    return { id: 'sol', ok: true, message: '', fix: '' };
  }
  const held =
    balance == null
      ? 'The wallet balance could not be read.'
      : `The wallet holds ${balance} lamports.`;
  return {
    id: 'sol',
    ok: false,
    message: `Not enough SOL for rent and fees. This needs ${amount}. ${held} ${returns}`,
    fix: 'Add SOL for the rent and fees. The rent returns when the rule is closed.',
  };
}

function networkCheck(cluster: string, genesisHash: string | null): PresignCheck {
  const expected = GENESIS_BY_CLUSTER[cluster];
  if (genesisHash && expected && genesisHash === expected) {
    return { id: 'network', ok: true, message: '', fix: '' };
  }
  if (!genesisHash) {
    return {
      id: 'network',
      ok: false,
      message: 'The network could not be read.',
      fix: 'Check the connection, then try again.',
    };
  }
  return {
    id: 'network',
    ok: false,
    message: 'Wrong network.',
    fix: `Switch the wallet and the app to ${cluster}, then try again.`,
  };
}

function payeeCheck(hasTokenAccount: boolean | null): PresignCheck {
  if (hasTokenAccount == null) {
    return {
      id: 'payee',
      ok: false,
      message: 'The payee token account could not be read.',
      fix: 'Check the connection, then try again.',
    };
  }
  if (!hasTokenAccount) {
    return {
      id: 'payee',
      ok: false,
      message: 'This payee has no token account for this mint.',
      fix: 'The payee opens a token account for this mint, then you can approve.',
    };
  }
  return { id: 'payee', ok: true, message: '', fix: '' };
}

function formatLamports(lamports: number): string {
  const negative = lamports < 0;
  const abs = Math.abs(lamports);
  const whole = Math.trunc(abs / 1_000_000_000);
  const frac = abs % 1_000_000_000;
  const sign = negative ? '-' : '';
  if (frac === 0) {
    return `${sign}${whole} SOL`;
  }
  const fracText = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${sign}${whole}.${fracText} SOL`;
}
