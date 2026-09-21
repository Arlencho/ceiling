import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'buffer';
import { Keypair } from '@solana/web3.js';

import {
  AGENT_SECRET_STORE_KEY,
  AGENTS_STORE_KEY,
  APP_IDENTITY,
  MWA_CHAIN,
  SESSION_STORE_KEY,
  authorize,
  connect,
  createAgentKeypair,
  disconnect,
  loadAgentKeypair,
  loadOrCreateAgentPublicKey,
  loadSession,
  persistSession,
  publicKeyFromAccount,
  publicKeyFromMwaAddress,
  restore,
  truncateAddress,
  type AuthorizeParams,
  type MwaWallet,
  type TransactFn,
  type WalletStore,
} from './wallet';

function memoryStore(init: Record<string, string> = {}): WalletStore & {
  data: Record<string, string>;
} {
  const data = { ...init };
  return {
    data,
    async getItem(key) {
      return data[key] ?? null;
    },
    async setItem(key, value) {
      data[key] = value;
    },
    async deleteItem(key) {
      delete data[key];
    },
  };
}

function base64AddressFromKeypair(keypair: Keypair): string {
  return Buffer.from(keypair.publicKey.toBytes()).toString('base64');
}

function fakeWallet(opts: {
  owner: Keypair;
  authToken?: string;
  accounts?: { address: string; publicKey?: Uint8Array }[];
  deauthorizeError?: Error;
  authCalls?: AuthorizeParams[];
  deauthCalls?: string[];
}): MwaWallet {
  const authToken = opts.authToken ?? 'auth-token-1';
  return {
    async authorize(params) {
      opts.authCalls?.push(params);
      const accounts = opts.accounts ?? [{ address: base64AddressFromKeypair(opts.owner) }];
      return { accounts, auth_token: authToken };
    },
    async deauthorize(params) {
      opts.deauthCalls?.push(params.auth_token);
      if (opts.deauthorizeError) {
        throw opts.deauthorizeError;
      }
    },
  };
}

function transactWith(wallet: MwaWallet): TransactFn {
  return async (callback) => callback(wallet);
}

test('truncateAddress keeps short strings and shortens a pubkey', () => {
  assert.equal(truncateAddress('abcd'), 'abcd');
  assert.equal(
    truncateAddress('EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc'),
    'EGQd...F2yc',
  );
});

test('publicKeyFromMwaAddress decodes a 32-byte base64 address', () => {
  const owner = Keypair.generate();
  const encoded = base64AddressFromKeypair(owner);
  assert.equal(publicKeyFromMwaAddress(encoded).toBase58(), owner.publicKey.toBase58());
});

test('publicKeyFromMwaAddress accepts a base58 address', () => {
  const owner = Keypair.generate();
  const base58 = owner.publicKey.toBase58();
  assert.equal(publicKeyFromMwaAddress(base58).toBase58(), base58);
});

test('publicKeyFromAccount prefers 32-byte publicKey bytes', () => {
  const owner = Keypair.generate();
  const other = Keypair.generate();
  const parsed = publicKeyFromAccount({
    address: base64AddressFromKeypair(other),
    publicKey: owner.publicKey.toBytes(),
  });
  assert.equal(parsed.toBase58(), owner.publicKey.toBase58());
});

test('authorize returns the owner public key and does not require a stored token', async () => {
  const owner = Keypair.generate();
  const authCalls: AuthorizeParams[] = [];
  const wallet = fakeWallet({ owner, authCalls, authToken: 'fresh-token' });
  const session = await authorize(wallet);
  assert.equal(session.authToken, 'fresh-token');
  assert.equal(session.ownerPublicKey, owner.publicKey.toBase58());
  assert.equal(authCalls[0]?.auth_token, undefined);
  assert.equal(authCalls[0]?.chain, MWA_CHAIN);
  assert.equal(authCalls[0]?.identity.name, APP_IDENTITY.name);
});

test('authorize passes a stored auth token so the wallet can skip the prompt', async () => {
  const owner = Keypair.generate();
  const authCalls: AuthorizeParams[] = [];
  const wallet = fakeWallet({ owner, authCalls });
  await authorize(wallet, 'cached-token');
  assert.equal(authCalls[0]?.auth_token, 'cached-token');
});

test('authorize throws when the wallet returns no accounts', async () => {
  const owner = Keypair.generate();
  const wallet = fakeWallet({ owner, accounts: [] });
  await assert.rejects(() => authorize(wallet), /no accounts/);
});

test('connect persists auth token and owner pubkey, never an owner secret', async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const store = memoryStore();
  const wallet = fakeWallet({ owner, authToken: 'persist-me' });
  const connected = await connect(transactWith(wallet), store, () => agent);

  assert.equal(connected.ownerPublicKey, owner.publicKey.toBase58());
  assert.equal(connected.agentPublicKey, agent.publicKey.toBase58());
  assert.notEqual(connected.ownerPublicKey, connected.agentPublicKey);

  const raw = store.data[SESSION_STORE_KEY];
  assert.ok(raw);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['authToken', 'ownerPublicKey']);
  assert.equal(parsed.authToken, 'persist-me');
  assert.equal(parsed.ownerPublicKey, owner.publicKey.toBase58());
  assert.equal(parsed.secretKey, undefined);
  assert.equal(parsed.privateKey, undefined);
  assert.equal(raw.includes(Buffer.from(owner.secretKey).toString('base64')), false);
  assert.equal(raw.includes('secretKey'), false);
});

test('connect reuses a stored auth token on a later authorize', async () => {
  const owner = Keypair.generate();
  const store = memoryStore();
  await persistSession(store, {
    authToken: 'saved-token',
    ownerPublicKey: owner.publicKey.toBase58(),
  });
  const authCalls: AuthorizeParams[] = [];
  const wallet = fakeWallet({ owner, authCalls, authToken: 'saved-token' });
  await connect(transactWith(wallet), store, () => Keypair.generate());
  assert.equal(authCalls[0]?.auth_token, 'saved-token');
});

test('restore returns a stored session without calling the wallet', async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const store = memoryStore();
  await persistSession(store, {
    authToken: 'saved-token',
    ownerPublicKey: owner.publicKey.toBase58(),
  });
  const snapshot = await restore(store, () => agent);
  assert.equal(snapshot.session?.authToken, 'saved-token');
  assert.equal(snapshot.session?.ownerPublicKey, owner.publicKey.toBase58());
  assert.equal(snapshot.agentPublicKey, agent.publicKey.toBase58());
});

test('loadSession returns null for missing, corrupt, or invalid payloads', async () => {
  const store = memoryStore();
  assert.equal(await loadSession(store), null);
  await store.setItem(SESSION_STORE_KEY, '{not json');
  assert.equal(await loadSession(store), null);
  await store.setItem(SESSION_STORE_KEY, JSON.stringify({ authToken: 'x' }));
  assert.equal(await loadSession(store), null);
  await store.setItem(
    SESSION_STORE_KEY,
    JSON.stringify({ authToken: 'x', ownerPublicKey: 'not-a-key' }),
  );
  assert.equal(await loadSession(store), null);
});

test('loadOrCreateAgentPublicKey stores a 64-byte secret and reuses it', async () => {
  const first = Keypair.generate();
  const second = Keypair.generate();
  const store = memoryStore();
  const created = await loadOrCreateAgentPublicKey(store, () => first);
  const reused = await loadOrCreateAgentPublicKey(store, () => second);
  assert.equal(created, first.publicKey.toBase58());
  assert.equal(reused, first.publicKey.toBase58());
  const loaded = await loadAgentKeypair(store);
  assert.ok(loaded);
  assert.equal(loaded.publicKey.toBase58(), first.publicKey.toBase58());
  assert.equal(loaded.secretKey.length, 64);
});

test('disconnect deauthorizes, clears the session, and keeps the agent key', async () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const store = memoryStore();
  const deauthCalls: string[] = [];
  const wallet = fakeWallet({ owner, authToken: 'drop-me', deauthCalls });
  await connect(transactWith(wallet), store, () => agent);
  await disconnect(transactWith(wallet), store);

  assert.deepEqual(deauthCalls, ['drop-me']);
  assert.equal(await loadSession(store), null);
  assert.equal(store.data[SESSION_STORE_KEY], undefined);
  const loaded = await loadAgentKeypair(store);
  assert.ok(loaded);
  assert.equal(loaded.publicKey.toBase58(), agent.publicKey.toBase58());
});

test('createAgentKeypair stores a second agent without dropping the first', async () => {
  const first = Keypair.generate();
  const second = Keypair.generate();
  const store = memoryStore();
  await loadOrCreateAgentPublicKey(store, () => first);
  const created = await createAgentKeypair(store, () => second);
  assert.equal(created.publicKey.toBase58(), second.publicKey.toBase58());
  assert.notEqual(first.publicKey.toBase58(), second.publicKey.toBase58());
  const latest = await loadAgentKeypair(store);
  assert.equal(latest?.publicKey.toBase58(), second.publicKey.toBase58());
  const mapRaw = store.data[AGENTS_STORE_KEY];
  assert.ok(mapRaw);
  const map = JSON.parse(mapRaw) as Record<string, string>;
  assert.ok(map[first.publicKey.toBase58()]);
  assert.ok(map[second.publicKey.toBase58()]);
});

test('disconnect still clears the session if deauthorize throws', async () => {
  const owner = Keypair.generate();
  const store = memoryStore();
  const wallet = fakeWallet({
    owner,
    authToken: 'stale',
    deauthorizeError: new Error('wallet gone'),
  });
  await connect(transactWith(wallet), store, () => Keypair.generate());
  await assert.rejects(
    () => disconnect(transactWith(wallet), store),
    /wallet gone/,
  );
  assert.equal(await loadSession(store), null);
});
