import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';

import type { ChainClient } from './chain';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');

const PROGRAM_ID = new PublicKey(Buffer.alloc(32, 1));
const TOKEN_PROGRAM = new PublicKey(Buffer.alloc(32, 2));
const MINT = new PublicKey(Buffer.alloc(32, 5));

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

test('a missing token account names the mint and says the owner holds none of it', async () => {
  const { openMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  let prompts = 0;
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(MINT)) {
        return { data: Buffer.alloc(0), owner: TOKEN_PROGRAM, executable: false, lamports: 1 };
      }
      return null;
    },
  };

  await assert.rejects(
    () =>
      openMandate(
        client(connection),
        async () => {
          prompts += 1;
          return ['sig'];
        },
        {
          owner,
          agent,
          merchant,
          cap: 200n,
          perTxMax: 60n,
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
          purpose: 'missing token account',
        },
      ),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, new RegExp(MINT.toBase58()));
      assert.match(message, /holds none/i);
      assert.match(message, /will not create/i);
      return true;
    },
  );
  assert.equal(prompts, 0);
});
