import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

import { walletChainForCluster } from './appConfig';

export const AGENT_CONNECT_LINE =
  'The agent signs charges with its own key and pays its own small SOL fees; it can never move funds outside this rule.';

export const AGENT_CHARGE_CONFIG_KEYS = [
  'mandate',
  'programId',
  'mint',
  'mintDecimals',
  'sourceTokenAccount',
  'payeeTokenAccount',
  'agent',
  'cluster',
  'rpcUrl',
] as const;

export type AgentChargeConfig = {
  mandate: string;
  programId: string;
  mint: string;
  mintDecimals: number;
  sourceTokenAccount: string;
  payeeTokenAccount: string;
  agent: string;
  cluster: string;
  rpcUrl: string;
};

export type AccountBytes = {
  data: Uint8Array;
  owner: PublicKey;
};

export type TokenAccountRow = {
  pubkey: PublicKey;
  data: Uint8Array;
};

export type PayeeLookup = {
  getAccountInfo(address: PublicKey): Promise<AccountBytes | null>;
  getTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey } | { programId: PublicKey },
  ): Promise<TokenAccountRow[]>;
};

type AccountConnection = {
  getAccountInfo(
    address: PublicKey,
    commitment?: 'confirmed',
  ): Promise<{ data: Uint8Array; owner: PublicKey } | null>;
  getTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey } | { programId: PublicKey },
    commitment?: 'confirmed',
  ): Promise<{ value: readonly { pubkey: PublicKey; account: { data: Uint8Array } }[] }>;
};

function canonicalAddress(value: string, field: string): string {
  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    throw new Error(`${field} must be a base58 public key`);
  }
  if (key.toBase58() !== value) {
    throw new Error(`${field} must be a base58 public key`);
  }
  return value;
}

function decimalsOf(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 18) {
    throw new Error('mint decimals must be an integer from 0 to 18');
  }
  return value;
}

export function agentChargeConfig(input: AgentChargeConfig): AgentChargeConfig {
  const rpcUrl = input.rpcUrl;
  if (typeof rpcUrl !== 'string' || rpcUrl.length === 0) {
    throw new Error('rpc url is missing');
  }
  walletChainForCluster(input.cluster);
  return {
    mandate: canonicalAddress(input.mandate, 'mandate'),
    programId: canonicalAddress(input.programId, 'program id'),
    mint: canonicalAddress(input.mint, 'mint'),
    mintDecimals: decimalsOf(input.mintDecimals),
    sourceTokenAccount: canonicalAddress(input.sourceTokenAccount, 'source token account'),
    payeeTokenAccount: canonicalAddress(input.payeeTokenAccount, 'payee token account'),
    agent: canonicalAddress(input.agent, 'agent'),
    cluster: input.cluster,
    rpcUrl,
  };
}

export function agentChargeConfigJson(input: AgentChargeConfig): string {
  return JSON.stringify(agentChargeConfig(input));
}

export function parseAgentChargeConfig(raw: unknown): AgentChargeConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('agent config must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  const missing = AGENT_CHARGE_CONFIG_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  const extra = keys.filter(
    (key) => !AGENT_CHARGE_CONFIG_KEYS.includes(key as (typeof AGENT_CHARGE_CONFIG_KEYS)[number]),
  );
  if (missing.length > 0 || extra.length > 0) {
    throw new Error('agent config keys do not match the documented shape');
  }
  if (typeof record.mintDecimals !== 'number') {
    throw new Error('mint decimals must be an integer from 0 to 18');
  }
  const strings = [
    'mandate',
    'programId',
    'mint',
    'sourceTokenAccount',
    'payeeTokenAccount',
    'agent',
    'cluster',
    'rpcUrl',
  ] as const;
  for (const key of strings) {
    if (typeof record[key] !== 'string') {
      throw new Error(`${key} must be a string`);
    }
  }
  return agentChargeConfig({
    mandate: record.mandate as string,
    programId: record.programId as string,
    mint: record.mint as string,
    mintDecimals: record.mintDecimals,
    sourceTokenAccount: record.sourceTokenAccount as string,
    payeeTokenAccount: record.payeeTokenAccount as string,
    agent: record.agent as string,
    cluster: record.cluster as string,
    rpcUrl: record.rpcUrl as string,
  });
}

export function agentChargeRows(config: AgentChargeConfig): { label: string; value: string }[] {
  return [
    { label: 'Mandate', value: config.mandate },
    { label: 'Program', value: config.programId },
    { label: 'Mint', value: config.mint },
    { label: 'Decimals', value: String(config.mintDecimals) },
    { label: 'Source token account', value: config.sourceTokenAccount },
    { label: 'Payee token account', value: config.payeeTokenAccount },
    { label: 'Agent', value: config.agent },
    { label: 'Cluster', value: config.cluster },
    { label: 'RPC', value: config.rpcUrl },
  ];
}

export function payeeLookup(connection: AccountConnection): PayeeLookup {
  return {
    async getAccountInfo(address) {
      const info = await connection.getAccountInfo(address, 'confirmed');
      if (!info) {
        return null;
      }
      return { data: info.data, owner: info.owner };
    },
    async getTokenAccountsByOwner(owner, filter) {
      const listed = await connection.getTokenAccountsByOwner(owner, filter, 'confirmed');
      return listed.value.map((item) => ({ pubkey: item.pubkey, data: item.account.data }));
    },
  };
}

/**
 * The token account charge pays. Same choice as the agent client: the payee's
 * associated account for this mint when it exists, otherwise the payee's only
 * token account for the mint.
 */
export async function readPayeeTokenAccount(
  lookup: PayeeLookup,
  merchant: PublicKey,
  mint: PublicKey,
): Promise<PublicKey> {
  const mintInfo = await lookup.getAccountInfo(mint);
  if (!mintInfo) {
    throw new Error(`Mint ${mint.toBase58()} was not found on chain, so the payee token account is not known.`);
  }
  const tokenProgram = mintInfo.owner;
  const ata = getAssociatedTokenAddressSync(mint, merchant, true, tokenProgram);
  const ataInfo = await lookup.getAccountInfo(ata);
  if (ataInfo) {
    return ata;
  }
  const filter = tokenProgram.equals(TOKEN_PROGRAM_ID) ? { mint } : { programId: tokenProgram };
  const listed = await lookup.getTokenAccountsByOwner(merchant, filter);
  const matches: PublicKey[] = [];
  for (const item of listed) {
    if (item.data.length < 32) {
      throw new Error('A token account for this payee could not be read.');
    }
    const accountMint = new PublicKey(item.data.subarray(0, 32));
    if (!accountMint.equals(mint)) {
      continue;
    }
    matches.push(item.pubkey);
  }
  if (matches.some((key) => key.equals(ata))) {
    return ata;
  }
  if (matches.length === 0) {
    throw new Error('No token account for this payee and mint is on chain, so the config is not ready.');
  }
  if (matches.length > 1) {
    const list = matches.map((key) => key.toBase58()).join(', ');
    throw new Error(
      `This payee has ${matches.length} token accounts for this mint (${list}), so the config does not pick one.`,
    );
  }
  const only = matches[0];
  if (!only) {
    throw new Error('No token account for this payee and mint is on chain, so the config is not ready.');
  }
  return only;
}
