import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  type Connection,
  type Transaction,
} from '@solana/web3.js';

import type { ChainClient } from './chain';
import {
  LEDGER_ACCOUNT_SIZE,
  MANDATE_ACCOUNT_SIZE,
  MANDATE_DISCRIMINATOR,
  STATUS_ACTIVE,
  writeI64Le,
  writeU32Le,
  writeU64Le,
} from './constants';
import type { MandateAccount } from './mandate';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');

const TOKEN_RENT = 2_039_280;
const MANDATE_RENT = 3_474_240;
const LEDGER_RENT = 11_349_200;
const SOL = 50_000_000;
const SIG = 'landed-sig';

function mintData(decimals: number): Buffer {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  return data;
}

function tokenData(amount: bigint): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

function encodeMandate(m: MandateAccount): Buffer {
  const purpose = Buffer.from(m.purpose, 'utf8');
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const k of [m.owner, m.agent, m.mint, m.source, m.merchant]) {
    Buffer.from(new PublicKey(k).toBytes()).copy(buf, o);
    o += 32;
  }
  for (const v of [m.mandateId, m.cap, m.spent, m.perTxMax]) {
    writeU64Le(buf, o, v);
    o += 8;
  }
  writeI64Le(buf, o, m.expiresAt);
  o += 8;
  for (const v of [m.overrideAmount, m.overrideNonce, m.lastNonce]) {
    writeU64Le(buf, o, v);
    o += 8;
  }
  writeU32Le(buf, o, purpose.length);
  o += 4;
  purpose.copy(buf, o);
  o += purpose.length;
  buf[o] = m.status;
  o += 1;
  writeU32Le(buf, o, m.spendCount);
  o += 4;
  writeU32Le(buf, o, m.refusalCount);
  o += 4;
  buf[o] = m.bump;
  return buf;
}

function mandateFromOpen(tx: Transaction, programId: PublicKey): MandateAccount {
  const ix = tx.instructions.find((item) => item.programId.equals(programId));
  assert.ok(ix, 'the open transaction has no program instruction');
  const data = Buffer.from(ix.data);
  const purposeLen = data.readUInt32LE(104);
  return {
    address: ix.keys[1]!.pubkey.toBase58(),
    owner: ix.keys[0]!.pubkey.toBase58(),
    agent: new PublicKey(data.subarray(16, 48)).toBase58(),
    mint: ix.keys[4]!.pubkey.toBase58(),
    source: ix.keys[3]!.pubkey.toBase58(),
    merchant: new PublicKey(data.subarray(48, 80)).toBase58(),
    mandateId: data.readBigUInt64LE(8),
    cap: data.readBigUInt64LE(80),
    spent: 7n,
    perTxMax: data.readBigUInt64LE(88),
    expiresAt: data.readBigInt64LE(96),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: data.subarray(108, 108 + purposeLen).toString('utf8'),
    status: STATUS_ACTIVE,
    spendCount: 0,
    refusalCount: 0,
    bump: 1,
  };
}

type StatusBranch = 'clean' | 'failed' | 'missing';

function openConnection(args: {
  programId: PublicKey;
  mint: PublicKey;
  owner: PublicKey;
  giveUp: 'blockheight' | 'timeout';
  branch: StatusBranch;
}): { connection: Connection; lookedUp: { signature: string; history: boolean }[] } {
  const ata = getAssociatedTokenAddressSync(args.mint, args.owner, false, TOKEN_PROGRAM_ID);
  let landed: MandateAccount | null = null;
  const lookedUp: { signature: string; history: boolean }[] = [];
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(args.mint)) {
        return { data: mintData(6), owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
      }
      if (address.equals(ata)) {
        return { data: tokenData(1_000n), owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
      }
      if (landed && address.equals(new PublicKey(landed.address))) {
        return { data: encodeMandate(landed), owner: args.programId, executable: false, lamports: 1 };
      }
      return null;
    },
    getBalance: async () => SOL,
    getMinimumBalanceForRentExemption: async (size: number) => {
      if (size === ACCOUNT_SIZE) return TOKEN_RENT;
      if (size === MANDATE_ACCOUNT_SIZE) return MANDATE_RENT;
      if (size === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
      if (size === 0) return 890_880;
      throw new Error(`unexpected rent size ${size}`);
    },
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 9,
    }),
    confirmTransaction: async () => {
      if (args.giveUp === 'timeout') {
        throw new TransactionExpiredTimeoutError(SIG, 30);
      }
      throw new TransactionExpiredBlockheightExceededError(SIG);
    },
    getSignatureStatuses: async (
      signatures: string[],
      config?: { searchTransactionHistory: boolean },
    ) => {
      lookedUp.push({
        signature: signatures[0] ?? '',
        history: config?.searchTransactionHistory === true,
      });
      if (config?.searchTransactionHistory !== true || signatures.length !== 1 || signatures[0] !== SIG) {
        throw new Error('status lookup must be getSignatureStatuses([signature], { searchTransactionHistory: true })');
      }
      if (args.branch === 'missing') {
        return { value: [null] };
      }
      if (args.branch === 'failed') {
        return { value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] };
      }
      return { value: [{ err: null, confirmationStatus: 'finalized' }] };
    },
  };
  return {
    connection: Object.assign(connection, {
      publish(tx: Transaction) {
        landed = mandateFromOpen(tx, args.programId);
      },
    }) as unknown as Connection & { publish: (tx: Transaction) => void },
    lookedUp,
  };
}

function client(connection: Connection, programId: PublicKey, mint: PublicKey): ChainClient {
  return {
    config: {
      rpcUrl: 'http://127.0.0.1:8899',
      programId: programId.toBase58(),
      mint: mint.toBase58(),
      explorerCluster: 'devnet',
      mintDecimals: 6,
    },
    connection,
    programId,
  };
}

async function open(branch: StatusBranch, giveUp: 'blockheight' | 'timeout') {
  const { openMandate } = await chainModule;
  const programId = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const built = openConnection({ programId, mint, owner, giveUp, branch });
  const raw = built.connection as unknown as { publish: (tx: Transaction) => void };
  const run = openMandate(
    client(built.connection, programId, mint),
    async (txs) => {
      raw.publish(txs[0]!);
      return [SIG];
    },
    {
      owner,
      agent: Keypair.generate().publicKey,
      merchant: Keypair.generate().publicKey,
      cap: 200n,
      perTxMax: 60n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
      purpose: 'night charging',
    },
  );
  return { run, lookedUp: built.lookedUp };
}

test('a block-height expiry still returns the mandate read from the account when the signature landed clean', async () => {
  const { run, lookedUp } = await open('clean', 'blockheight');
  const result = await run;
  assert.equal(result.signature, SIG);
  assert.equal(result.mandate.purpose, 'night charging');
  assert.equal(result.mandate.cap, 200n);
  assert.equal(result.mandate.spent, 7n);
  assert.equal(lookedUp.length, 1);
  assert.equal(lookedUp[0]?.history, true);
});

test('a confirmation timeout reports the landed error when the signature is on chain with an error', async () => {
  const { run } = await open('failed', 'timeout');
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, `transaction ${SIG} landed with an error`);
    return true;
  });
});

test('a block-height expiry says the transaction did not land and nothing moved when the signature is absent', async () => {
  const { run } = await open('missing', 'blockheight');
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, `transaction ${SIG} did not land and nothing moved`);
    return true;
  });
});
