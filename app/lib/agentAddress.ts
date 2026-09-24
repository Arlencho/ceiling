import { PublicKey } from '@solana/web3.js';

export const AGENT_ADDRESS_HINT =
  'The public address of the key your agent signs with, from wherever it runs. Leave it empty only for testing: opening then creates a key on this phone and stores it.';

const NOT_A_PUBLIC_KEY = 'agent address must be a base58 public key';

function publicKeyFromBase58(text: string): PublicKey {
  let key: PublicKey;
  try {
    key = new PublicKey(text);
  } catch {
    throw new Error(NOT_A_PUBLIC_KEY);
  }
  if (key.toBase58() !== text) {
    throw new Error(NOT_A_PUBLIC_KEY);
  }
  return key;
}

export function parseOptionalAgentAddress(args: {
  text: string;
  owner: string | null;
  payee: PublicKey;
}): PublicKey | undefined {
  const text = args.text.trim();
  if (text.length === 0) {
    return undefined;
  }
  const agent = publicKeyFromBase58(text);
  if (!args.owner) {
    throw new Error('Connect with Seed Vault first');
  }
  let owner: PublicKey;
  try {
    owner = new PublicKey(args.owner);
  } catch {
    throw new Error('Connect with Seed Vault first');
  }
  if (agent.equals(owner)) {
    throw new Error('agent address must not be the connected owner');
  }
  if (agent.equals(args.payee)) {
    throw new Error('agent address must not be the payee');
  }
  return agent;
}

export async function agentKeyForOpen(
  requested: PublicKey | undefined,
  createOnPhone: () => Promise<{ publicKey: PublicKey }>,
): Promise<PublicKey> {
  if (requested !== undefined) {
    return requested;
  }
  const created = await createOnPhone();
  return created.publicKey;
}

export async function copyAgentAddress(
  address: string,
  write: (value: string) => Promise<void>,
): Promise<void> {
  const key = publicKeyFromBase58(address);
  await write(key.toBase58());
}
