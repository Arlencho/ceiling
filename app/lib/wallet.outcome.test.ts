import assert from 'node:assert/strict';
import test from 'node:test';

import { Buffer } from 'buffer';
import { Keypair, Transaction } from '@solana/web3.js';

import {
  SESSION_STORE_KEY,
  connect,
  disconnect,
  loadSession,
  signAndSendTransactions,
  type MwaWallet,
  type TransactFn,
  type WalletStore,
} from './wallet';

process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER = 'devnet';

const CANCELLED = 'You cancelled the wallet request.';
const REJECTED = 'The wallet rejected the request.';
const CLOSED = 'The wallet closed the session without a signature.';
const NOT_ON_CLUSTER =
  'The wallet did not submit the transaction. This app uses devnet. The wallet must be on devnet.';
const SOLANA_MOBILE_BASE = 'https://connect.solanamobile.com';

type Association = { baseUri?: string } | undefined;
type SignOptions = {
  timeoutMs?: number;
  lookup?: (signature: string) => Promise<'confirmed' | 'missing' | 'failed'>;
};
type ConnectOptions = { baseUri?: string; chooser?: boolean };

function memoryStore(): WalletStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
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

function ownerAccount(owner: Keypair): { address: string; publicKey: Uint8Array } {
  return {
    address: Buffer.from(owner.publicKey.toBytes()).toString('base64'),
    publicKey: owner.publicKey.toBytes(),
  };
}

function recordingTransact(wallet: MwaWallet, calls: Association[]): TransactFn {
  const fn = async (callback: (wallet: MwaWallet) => Promise<unknown>, config?: Association) => {
    calls.push(config);
    return callback(wallet);
  };
  return fn as TransactFn;
}

async function sign(
  transact: TransactFn,
  store: WalletStore,
  options?: SignOptions,
): Promise<string[]> {
  const fn = signAndSendTransactions as (
    transact: TransactFn,
    store: WalletStore,
    transactions: Transaction[],
    options?: SignOptions,
  ) => Promise<string[]>;
  return fn(transact, store, [new Transaction()], options);
}

async function connectWith(
  transact: TransactFn,
  store: WalletStore,
  owner: Keypair,
  options?: ConnectOptions,
) {
  const fn = connect as (
    transact: TransactFn,
    store: WalletStore,
    generate?: () => Keypair,
    options?: ConnectOptions,
  ) => ReturnType<typeof connect>;
  return fn(transact, store, () => owner, options);
}

function walletReturning(result: {
  signatures?: string[];
  throwOnAuthorize?: unknown;
  throwOnSign?: unknown;
  walletUriBase?: string;
  owner: Keypair;
}): MwaWallet {
  return {
    async authorize() {
      if (result.throwOnAuthorize) {
        throw result.throwOnAuthorize;
      }
      return {
        accounts: [ownerAccount(result.owner)],
        auth_token: 'auth-1',
        ...(result.walletUriBase ? { wallet_uri_base: result.walletUriBase } : {}),
      };
    },
    async deauthorize() {
      return undefined;
    },
    async signAndSendTransactions() {
      if (result.throwOnSign) {
        throw result.throwOnSign;
      }
      return result.signatures as string[];
    },
  };
}

test('a cancelled sign tells the person they cancelled', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(
    walletReturning({
      owner,
      throwOnSign: new Error('Local association cancelled by user'),
    }),
    [],
  );
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === CANCELLED,
  );
});

test('a rejected sign tells the person the wallet rejected the request', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(
    walletReturning({ owner, throwOnSign: new Error('User rejected the request') }),
    [],
  );
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === REJECTED,
  );
});

test('an authorization failure from the wallet is told as a rejection', async () => {
  const owner = Keypair.generate();
  const failed = new Error('authorization failed');
  (failed as Error & { code: number }).code = -1;
  const transact = recordingTransact(walletReturning({ owner, throwOnAuthorize: failed }), []);
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === REJECTED,
  );
});

test('a wallet that reports the transaction was not submitted names the network', async () => {
  const owner = Keypair.generate();
  const failed = new Error('not submitted');
  (failed as Error & { code: number }).code = -4;
  const transact = recordingTransact(walletReturning({ owner, throwOnSign: failed }), []);
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === NOT_ON_CLUSTER,
  );
});

test('a session that closes before it returns a signature says so', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(
    walletReturning({
      owner,
      throwOnSign: new Error('The wallet session was closed before connection.'),
    }),
    [],
  );
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === CLOSED,
  );
});

test('a sign that returns no signature says the session closed without one', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(walletReturning({ owner, signatures: [] }), []);
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === CLOSED,
  );
});

test('a signature missing from the configured RPC names the network and that the wallet must be on it', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(
    walletReturning({ owner, signatures: ['sig-not-on-devnet'] }),
    [],
  );
  await assert.rejects(
    () =>
      sign(transact, memoryStore(), {
        timeoutMs: 0,
        lookup: async () => 'missing',
      }),
    (err: unknown) => err instanceof Error && err.message === NOT_ON_CLUSTER,
  );
});

test('a signature the configured RPC confirms is returned', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(walletReturning({ owner, signatures: ['sig-ok'] }), []);
  const signatures = await sign(transact, memoryStore(), {
    timeoutMs: 0,
    lookup: async () => 'confirmed',
  });
  assert.deepEqual(signatures, ['sig-ok']);
});

test('connect stores the wallet base URI and later sessions pass it to transact', async () => {
  const owner = Keypair.generate();
  const store = memoryStore();
  const calls: Association[] = [];
  const wallet = walletReturning({
    owner,
    walletUriBase: 'https://wallet.example/mwa',
    signatures: ['sig-ok'],
  });
  const transact = recordingTransact(wallet, calls);
  await connectWith(transact, store, owner);
  const stored = await loadSession(store);
  assert.equal(stored?.walletUriBase, 'https://wallet.example/mwa');

  calls.length = 0;
  await sign(transact, store, { timeoutMs: 0, lookup: async () => 'confirmed' });
  assert.equal(calls[0]?.baseUri, 'https://wallet.example/mwa');
});

test('disconnect sends the stored base URI and then clears it', async () => {
  const owner = Keypair.generate();
  const store = memoryStore();
  const calls: Association[] = [];
  const wallet = walletReturning({ owner, walletUriBase: 'https://wallet.example/mwa' });
  const transact = recordingTransact(wallet, calls);
  await connectWith(transact, store, owner);
  calls.length = 0;
  await disconnect(transact, store);
  assert.equal(calls[0]?.baseUri, 'https://wallet.example/mwa');
  assert.equal(await loadSession(store), null);
  assert.equal(store.data[SESSION_STORE_KEY], undefined);

  calls.length = 0;
  const signed = walletReturning({
    owner,
    signatures: ['sig-ok'],
  });
  await sign(recordingTransact(signed, calls), store, {
    timeoutMs: 0,
    lookup: async () => 'confirmed',
  });
  assert.equal(calls[0]?.baseUri, undefined);
});

test('primary connect targets the Solana Mobile wallet, and the chooser does not', async () => {
  const owner = Keypair.generate();
  const calls: Association[] = [];
  const wallet = walletReturning({ owner, walletUriBase: SOLANA_MOBILE_BASE });
  const transact = recordingTransact(wallet, calls);

  await connectWith(transact, memoryStore(), owner, { baseUri: SOLANA_MOBILE_BASE });
  assert.equal(calls[0]?.baseUri, SOLANA_MOBILE_BASE);

  calls.length = 0;
  await connectWith(transact, memoryStore(), owner, {
    chooser: true,
    baseUri: SOLANA_MOBILE_BASE,
  });
  assert.equal(calls[0]?.baseUri, undefined);
});
