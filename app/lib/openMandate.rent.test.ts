import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';

import type { ChainClient } from './chain';
import { LEDGER_ACCOUNT_SIZE, MANDATE_ACCOUNT_SIZE, OPEN_FEE_MARGIN_LAMPORTS } from './constants';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');

const PROGRAM_ID = new PublicKey(Buffer.alloc(32, 1));
const TOKEN_PROGRAM = new PublicKey(Buffer.alloc(32, 2));
const MINT = new PublicKey(Buffer.alloc(32, 5));

const MANDATE_RENT = 2_225_040;
const LEDGER_RENT = 12_598_400;

function client(connection: Record<string, unknown>): ChainClient {
  return {
    config: {
      rpcUrl: 'https://api.devnet.solana.com',
      programId: PROGRAM_ID.toBase58(),
      mint: MINT.toBase58(),
      explorerCluster: 'devnet',
      mintDecimals: 6,
    },
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
  };
}

function openInput(owner: PublicKey, merchant: PublicKey, agent: PublicKey) {
  return {
    owner,
    agent,
    merchant,
    cap: 200n,
    perTxMax: 60n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
    purpose: 'rent check',
  };
}

function connectionFor(args: {
  owner: PublicKey;
  balance: number;
  rent?: (space: number) => number;
}): Record<string, unknown> {
  const source = getAssociatedTokenAddressSync(MINT, args.owner, false, TOKEN_PROGRAM);
  return {
    getBalance: async (address: PublicKey) => (address.equals(args.owner) ? args.balance : 0),
    getMinimumBalanceForRentExemption:
      args.rent == null
        ? undefined
        : async (space: number) => args.rent!(space),
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(MINT)) {
        const data = Buffer.alloc(82);
        data[44] = 6;
        return { data, owner: TOKEN_PROGRAM, executable: false, lamports: 1 };
      }
      if (address.equals(source)) {
        const data = Buffer.alloc(165);
        data.writeBigUInt64LE(1_000n, 64);
        return { data, owner: TOKEN_PROGRAM, executable: false, lamports: 1 };
      }
      return null;
    },
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }),
  };
}

function quoteRent(rentExempt: (space: number) => number): (space: number) => number {
  return (space) => {
    if (space === ACCOUNT_SIZE) return rentExempt(ACCOUNT_SIZE);
    if (space === 0) return rentExempt(0);
    if (space === MANDATE_ACCOUNT_SIZE) return MANDATE_RENT;
    if (space === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
    throw new Error(`unexpected account size ${space}`);
  };
}

function fullRent(rentExempt: (space: number) => number): number {
  return rentExempt(ACCOUNT_SIZE) + MANDATE_RENT + LEDGER_RENT + OPEN_FEE_MARGIN_LAMPORTS;
}

test('opening a rule with no SOL names the rent and the fee margin and does not ask for a signature', async () => {
  const { openMandate, rentExemptLamports } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  let prompts = 0;
  const needed = fullRent(rentExemptLamports);
  const connection = connectionFor({
    owner,
    balance: 0,
    rent: quoteRent(rentExemptLamports),
  });

  await assert.rejects(
    () =>
      openMandate(client(connection), async () => {
        prompts += 1;
        return ['sig'];
      }, openInput(owner, merchant, agent)),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /rent/i);
      assert.match(message, new RegExp(String(needed)));
      assert.match(message, /fee margin/i);
      return true;
    },
  );
  assert.equal(prompts, 0);
});

test('a balance one lamport under rent plus the fee margin is refused before the signature', async () => {
  const { openMandate, rentExemptLamports } = await chainModule;
  const owner = Keypair.generate().publicKey;
  let prompts = 0;
  const needed = fullRent(rentExemptLamports);
  const connection = connectionFor({
    owner,
    balance: needed - 1,
    rent: quoteRent(rentExemptLamports),
  });

  await assert.rejects(
    () =>
      openMandate(
        client(connection),
        async () => {
          prompts += 1;
          return ['sig'];
        },
        openInput(owner, Keypair.generate().publicKey, Keypair.generate().publicKey),
      ),
    /rent/i,
  );
  assert.equal(prompts, 0);
});

test('a balance that covers rent and the fee margin reaches the signature', async () => {
  const { openMandate, rentExemptLamports } = await chainModule;
  const owner = Keypair.generate().publicKey;
  let prompts = 0;
  const needed = fullRent(rentExemptLamports);
  const stop = new Error('stop before send');
  const connection = connectionFor({
    owner,
    balance: needed,
    rent: quoteRent(rentExemptLamports),
  });

  await assert.rejects(
    () =>
      openMandate(
        client(connection),
        async () => {
          prompts += 1;
          throw stop;
        },
        openInput(owner, Keypair.generate().publicKey, Keypair.generate().publicKey),
      ),
    (err: unknown) => err === stop,
  );
  assert.equal(prompts, 1);
});

test('with no rent RPC the refusal still names mandate plus ledger rent and the fee margin', async () => {
  const { openMandate, rentExemptLamports } = await chainModule;
  const owner = Keypair.generate().publicKey;
  let prompts = 0;
  const needed = fullRent(rentExemptLamports);
  const connection = connectionFor({ owner, balance: 0 });

  await assert.rejects(
    () =>
      openMandate(
        client(connection),
        async () => {
          prompts += 1;
          return ['sig'];
        },
        openInput(owner, Keypair.generate().publicKey, Keypair.generate().publicKey),
      ),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /rent/i);
      assert.match(message, new RegExp(String(needed)));
      assert.match(message, /fee margin/i);
      return true;
    },
  );
  assert.equal(prompts, 0);
  assert.equal(rentExemptLamports(MANDATE_ACCOUNT_SIZE), MANDATE_RENT);
  assert.equal(rentExemptLamports(LEDGER_ACCOUNT_SIZE), LEDGER_RENT);
  assert.equal(rentExemptLamports(ACCOUNT_SIZE) + MANDATE_RENT + LEDGER_RENT + OPEN_FEE_MARGIN_LAMPORTS, needed);
});
