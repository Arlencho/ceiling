// Frontend critic, round 2 on PR 192 (feat/rule-token-account).
// One lamport refusal, one total. On a real RPC every account size quotes a
// different rent, so the open needs the mandate, the ledger and the rule token
// account. The refusal must give the wallet one figure to reach, and must not
// describe the open as creating two accounts when it creates three.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';

import type { ChainClient } from './chain';
import { LEDGER_ACCOUNT_SIZE, MANDATE_ACCOUNT_SIZE, OPEN_FEE_MARGIN_LAMPORTS } from './constants';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');

const PROGRAM_ID = Keypair.generate().publicKey;
const TOKEN_PROGRAM = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;

// devnet quotes, 2026-09-24
const TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_RENT = 2_039_280;
const MANDATE_RENT = 3_474_240;
const LEDGER_RENT = 11_349_200;
const PAYER_FLOOR = 650_240;
const TOTAL = TOKEN_RENT + MANDATE_RENT + LEDGER_RENT + OPEN_FEE_MARGIN_LAMPORTS;

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

function connectionFor(owner: PublicKey, balance: number): Record<string, unknown> {
  const ata = getAssociatedTokenAddressSync(MINT, owner, false, TOKEN_PROGRAM);
  return {
    getBalance: async (address: PublicKey) => (address.equals(owner) ? balance : 0),
    getMinimumBalanceForRentExemption: async (space: number) => {
      if (space === TOKEN_ACCOUNT_SIZE) return TOKEN_RENT;
      if (space === MANDATE_ACCOUNT_SIZE) return MANDATE_RENT;
      if (space === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
      if (space === 0) return PAYER_FLOOR;
      throw new Error(`unexpected account size ${space}`);
    },
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(MINT)) {
        const data = Buffer.alloc(82);
        data[44] = 6;
        return { data, owner: TOKEN_PROGRAM, executable: false, lamports: 1 };
      }
      if (address.equals(ata)) {
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

async function refusal(balance: number): Promise<{ message: string; prompts: number }> {
  const { openMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  let prompts = 0;
  let message = '';
  try {
    await openMandate(
      client(connectionFor(owner, balance)),
      async () => {
        prompts += 1;
        return ['sig'];
      },
      {
        owner,
        agent: Keypair.generate().publicKey,
        merchant: Keypair.generate().publicKey,
        cap: 200n,
        perTxMax: 60n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
        purpose: 'critic r2',
      },
    );
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  return { message, prompts };
}

function neededFigures(message: string): string[] {
  return Array.from(message.matchAll(/needs (\d+) lamports/g), (m) => m[1]!);
}

test('critic r2: RED the lamport refusal on a real RPC gives one total to reach, the one that covers all three accounts', async () => {
  const { message, prompts } = await refusal(0);
  assert.equal(prompts, 0, 'no wallet prompt');
  assert.match(message, /rent/i);
  assert.match(message, /fee margin/i);
  const figures = neededFigures(message);
  assert.deepEqual(
    Array.from(new Set(figures)),
    [String(TOTAL)],
    `one "needs" figure, the full total; got ${JSON.stringify(figures)} in: ${message}`,
  );
  assert.doesNotMatch(message, /two accounts/i, `three accounts are created; got: ${message}`);
});

test('critic r2: RED the floor refusal keeps one total and names the floor', async () => {
  const { message, prompts } = await refusal(TOTAL + 1);
  assert.equal(prompts, 0, 'no wallet prompt');
  assert.match(message, new RegExp(String(PAYER_FLOOR)));
  const figures = neededFigures(message);
  assert.deepEqual(
    Array.from(new Set(figures)),
    [String(TOTAL)],
    `one "needs" figure, the full total; got ${JSON.stringify(figures)} in: ${message}`,
  );
  assert.doesNotMatch(message, /two accounts/i);
});

test('critic r2: lock, exactly the total reaches the signature', async () => {
  const { message, prompts } = await refusal(TOTAL);
  assert.equal(prompts, 1, `one wallet prompt; refusal was: ${message}`);
});
