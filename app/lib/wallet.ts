import { Buffer } from 'buffer';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

export const APP_IDENTITY = {
  name: 'Veto',
  uri: 'https://github.com/Arlencho/veto',
} as const;

export const MWA_CHAIN = 'solana:devnet' as const;

export const SESSION_STORE_KEY = 'veto.wallet.session';
export const AGENT_SECRET_STORE_KEY = 'veto.wallet.agentSecret';
export const AGENTS_STORE_KEY = 'veto.wallet.agents';

export type WalletStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
};

export type MwaAccount = {
  address: string;
  publicKey?: Uint8Array;
};

export type AuthorizeParams = {
  identity: { name: string; uri?: string; icon?: string };
  chain?: string;
  auth_token?: string;
};

export type SignAndSendParams = {
  transactions: Transaction[];
  minContextSlot?: number;
  commitment?: string;
  skipPreflight?: boolean;
  maxRetries?: number;
};

export type MwaWallet = {
  authorize(params: AuthorizeParams): Promise<{
    accounts: readonly MwaAccount[];
    auth_token: string;
  }>;
  deauthorize(params: { auth_token: string }): Promise<unknown>;
  signAndSendTransactions?(params: SignAndSendParams): Promise<string[]>;
};

export type TransactFn = <T>(
  callback: (wallet: MwaWallet) => Promise<T>,
) => Promise<T>;

export type StoredSession = {
  authToken: string;
  ownerPublicKey: string;
};

export type ConnectedWallet = {
  authToken: string;
  ownerPublicKey: string;
  agentPublicKey: string;
};

export type WalletSnapshot = {
  session: StoredSession | null;
  agentPublicKey: string;
};

export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2) {
    return address;
  }
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function publicKeyFromMwaAddress(address: string): PublicKey {
  const bytes = Buffer.from(address, 'base64');
  if (bytes.length === 32) {
    return new PublicKey(bytes);
  }
  return new PublicKey(address);
}

export function publicKeyFromAccount(account: MwaAccount): PublicKey {
  if (account.publicKey && account.publicKey.length === 32) {
    return new PublicKey(account.publicKey);
  }
  return publicKeyFromMwaAddress(account.address);
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.authToken === 'string' &&
    rec.authToken.length > 0 &&
    typeof rec.ownerPublicKey === 'string' &&
    rec.ownerPublicKey.length > 0
  );
}

export async function loadSession(store: WalletStore): Promise<StoredSession | null> {
  const raw = await store.getItem(SESSION_STORE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSession(parsed)) {
      return null;
    }
    new PublicKey(parsed.ownerPublicKey);
    return parsed;
  } catch {
    return null;
  }
}

export async function persistSession(
  store: WalletStore,
  session: StoredSession,
): Promise<void> {
  const payload: StoredSession = {
    authToken: session.authToken,
    ownerPublicKey: session.ownerPublicKey,
  };
  await store.setItem(SESSION_STORE_KEY, JSON.stringify(payload));
}

export async function clearSession(store: WalletStore): Promise<void> {
  await store.deleteItem(SESSION_STORE_KEY);
}

function readFailed(detail: string): Error {
  return new Error(`could not read the stored agent identity: ${detail}`);
}

function parseAgentSecret(raw: string): Keypair {
  try {
    const secret = Buffer.from(raw, 'base64');
    if (secret.length !== 64) {
      throw new Error(`secret is ${secret.length} bytes, expected 64`);
    }
    return Keypair.fromSecretKey(secret);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw readFailed(detail);
  }
}

function parseAgentsMap(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('agent map is not an object');
    }
    return parsed as Record<string, string>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw readFailed(detail);
  }
}

export async function loadAgentKeypair(store: WalletStore): Promise<Keypair | null> {
  const raw = await store.getItem(AGENT_SECRET_STORE_KEY);
  if (!raw) {
    return null;
  }
  return parseAgentSecret(raw);
}

async function rememberAgent(store: WalletStore, keypair: Keypair): Promise<void> {
  const raw = await store.getItem(AGENTS_STORE_KEY);
  const map = raw ? parseAgentsMap(raw) : {};
  const pk = keypair.publicKey.toBase58();
  if (!map[pk]) {
    map[pk] = Buffer.from(keypair.secretKey).toString('base64');
    await store.setItem(AGENTS_STORE_KEY, JSON.stringify(map));
  }
}

async function persistAgent(store: WalletStore, keypair: Keypair): Promise<void> {
  await store.setItem(
    AGENT_SECRET_STORE_KEY,
    Buffer.from(keypair.secretKey).toString('base64'),
  );
  await rememberAgent(store, keypair);
}

export async function loadOrCreateAgentPublicKey(
  store: WalletStore,
  generate: () => Keypair = Keypair.generate,
): Promise<string> {
  const existing = await loadAgentKeypair(store);
  if (existing) {
    await rememberAgent(store, existing);
    return existing.publicKey.toBase58();
  }
  const created = generate();
  await persistAgent(store, created);
  return created.publicKey.toBase58();
}

export async function createAgentKeypair(
  store: WalletStore,
  generate: () => Keypair = Keypair.generate,
): Promise<Keypair> {
  const created = generate();
  await persistAgent(store, created);
  return created;
}

export async function authorize(
  wallet: MwaWallet,
  storedAuthToken?: string,
): Promise<StoredSession> {
  const result = await wallet.authorize({
    identity: APP_IDENTITY,
    chain: MWA_CHAIN,
    ...(storedAuthToken ? { auth_token: storedAuthToken } : {}),
  });
  const account = result.accounts[0];
  if (!account) {
    throw new Error('Wallet authorized no accounts');
  }
  return {
    authToken: result.auth_token,
    ownerPublicKey: publicKeyFromAccount(account).toBase58(),
  };
}

export async function connect(
  transact: TransactFn,
  store: WalletStore,
  generate: () => Keypair = Keypair.generate,
): Promise<ConnectedWallet> {
  const stored = await loadSession(store);
  const session = await transact((wallet) => authorize(wallet, stored?.authToken));
  await persistSession(store, session);
  const agentPublicKey = await loadOrCreateAgentPublicKey(store, generate);
  return {
    authToken: session.authToken,
    ownerPublicKey: session.ownerPublicKey,
    agentPublicKey,
  };
}

export async function disconnect(transact: TransactFn, store: WalletStore): Promise<void> {
  const stored = await loadSession(store);
  try {
    if (stored) {
      await transact((wallet) => wallet.deauthorize({ auth_token: stored.authToken }));
    }
  } finally {
    await clearSession(store);
  }
}

export async function restore(
  store: WalletStore,
  generate: () => Keypair = Keypair.generate,
): Promise<WalletSnapshot> {
  const agentPublicKey = await loadOrCreateAgentPublicKey(store, generate);
  const session = await loadSession(store);
  return { session, agentPublicKey };
}

export async function signAndSendTransactions(
  transact: TransactFn,
  store: WalletStore,
  transactions: Transaction[],
): Promise<string[]> {
  if (transactions.length === 0) {
    throw new Error('no transactions to sign');
  }
  const stored = await loadSession(store);
  return transact(async (wallet) => {
    const session = await authorize(wallet, stored?.authToken);
    await persistSession(store, session);
    if (!wallet.signAndSendTransactions) {
      throw new Error('Wallet cannot sign and send transactions');
    }
    return wallet.signAndSendTransactions({
      transactions,
      commitment: 'confirmed',
    });
  });
}
