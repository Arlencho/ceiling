import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey, type Connection } from '@solana/web3.js';

import type { ChainClient } from './chain';
import {
  ENTRY_SIZE,
  KIND_OVERRIDE,
  KIND_REFUSED,
  LEDGER_ACCOUNT_SIZE,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  LEDGER_HEADER_SIZE,
  MANDATE_DISCRIMINATOR,
  REASON_OVER_PER_TX_MAX,
  STATUS_ACTIVE,
  writeI64Le,
  writeU32Le,
  writeU64Le,
} from './constants';
import type { MandateAccount } from './mandate';
import { ledgerPda, type LedgerRow } from './ring';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');

function key(seed: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, seed));
}

const PROGRAM_ID = key(1);
const TOKEN_PROGRAM = key(2);
const OWNER = key(3);
const MANDATE_KEY = key(9);

function nowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function mandate(over: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: MANDATE_KEY.toBase58(),
    owner: OWNER.toBase58(),
    agent: key(4).toBase58(),
    mint: key(5).toBase58(),
    source: key(6).toBase58(),
    merchant: key(7).toBase58(),
    mandateId: 1n,
    cap: 200n,
    spent: 20n,
    perTxMax: 60n,
    expiresAt: nowSec() + 3_600n,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 6n,
    purpose: 'SE3 home charging',
    status: STATUS_ACTIVE,
    spendCount: 3,
    refusalCount: 1,
    bump: 255,
    ...over,
  };
}

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: 1_000n,
    amount: 180n,
    counterparty: key(7).toBase58(),
    nonce: 7n,
    suggestedOverride: 180n,
    kind: KIND_REFUSED,
    kindName: 'refused',
    reason: REASON_OVER_PER_TX_MAX,
    reasonText: 'over per-payment maximum',
    signature: null,
    ...over,
  };
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

function entryBytes(args: {
  ts: bigint;
  amount: bigint;
  counterparty: Uint8Array;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  reason: number;
}): Buffer {
  const raw = Buffer.alloc(ENTRY_SIZE);
  raw.writeBigInt64LE(args.ts, 0);
  raw.writeBigUInt64LE(args.amount, 8);
  Buffer.from(args.counterparty).copy(raw, 16);
  raw.writeBigUInt64LE(args.nonce, 48);
  raw.writeBigUInt64LE(args.suggestedOverride, 56);
  raw[64] = args.kind;
  raw[65] = args.reason;
  return raw;
}

function ledgerBytes(args: {
  mandate: Uint8Array;
  total: number;
  head: number;
  bump: number;
  slots: Array<Buffer | null>;
}): Buffer {
  const data = Buffer.alloc(LEDGER_ACCOUNT_SIZE);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  Buffer.from(args.mandate).copy(data, 8);
  data.writeUInt32LE(args.total, 40);
  data.writeUInt16LE(args.head, 44);
  data[46] = args.bump;
  for (let i = 0; i < LEDGER_CAPACITY; i++) {
    const slot = args.slots[i];
    if (!slot) {
      continue;
    }
    slot.copy(data, 8 + LEDGER_HEADER_SIZE + i * ENTRY_SIZE);
  }
  return data;
}

test('a failed signature listing is not treated as an empty list, so override confirmation does not name a row by nonce and amount', async () => {
  const { grantOverride } = await chainModule;
  const live = mandate();
  const mandateBytes = encodeMandate(live);
  const overrideEntry = entryBytes({
    ts: 2_000n,
    amount: 180n,
    counterparty: new PublicKey(live.merchant).toBytes(),
    nonce: 7n,
    suggestedOverride: 180n,
    kind: KIND_OVERRIDE,
    reason: 0,
  });
  const ledgerData = ledgerBytes({
    mandate: MANDATE_KEY.toBytes(),
    total: 1,
    head: 0,
    bump: 255,
    slots: [overrideEntry],
  });
  const ledgerAddress = ledgerPda(PROGRAM_ID, MANDATE_KEY);
  const mint = new PublicKey(live.mint);

  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(MANDATE_KEY)) {
        return { data: mandateBytes, owner: PROGRAM_ID, executable: false, lamports: 1 };
      }
      if (address.equals(mint)) {
        return { data: Buffer.alloc(0), owner: TOKEN_PROGRAM, executable: false, lamports: 1 };
      }
      if (address.equals(ledgerAddress)) {
        return { data: ledgerData, owner: PROGRAM_ID, executable: false, lamports: 1 };
      }
      return null;
    },
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }),
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignaturesForAddress: async () => {
      throw new Error('429 Too many requests');
    },
  };

  const client: ChainClient = {
    config: {} as ChainClient['config'],
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
  };

  await assert.rejects(
    () =>
      grantOverride(client, async () => ['granted-sig'], OWNER, live, row(), 0),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'a failed listing must reject rather than return a row');
      assert.match(err.message, /signature/i);
      assert.doesNotMatch(
        err.message,
        /will not invent/,
        'empty-list copy is only for a listing that actually returned',
      );
      return true;
    },
  );
});

test('owner mandate listing keeps a second mint when config names only the first', async () => {
  const { fetchOwnerMandates } = await chainModule;
  const firstMint = key(5).toBase58();
  const secondMint = key(11).toBase58();
  const first = mandate({
    address: key(9).toBase58(),
    mint: firstMint,
    mandateId: 3n,
    purpose: 'Charging top-ups at the SE3 spot rate',
  });
  const second = mandate({
    address: key(10).toBase58(),
    mint: secondMint,
    source: key(12).toBase58(),
    agent: key(13).toBase58(),
    mandateId: 4n,
    purpose: 'second devnet asset',
  });
  const connection = {
    getProgramAccounts: async () => [
      { pubkey: new PublicKey(first.address), account: { data: encodeMandate(first) } },
      { pubkey: new PublicKey(second.address), account: { data: encodeMandate(second) } },
    ],
  };
  const client: ChainClient = {
    config: {
      rpcUrl: 'https://api.devnet.solana.com',
      programId: PROGRAM_ID.toBase58(),
      mint: firstMint,
      explorerCluster: 'devnet',
      mintDecimals: 6,
    },
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
  };

  const found = await fetchOwnerMandates(client, OWNER);
  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map((row) => row.mint).sort(),
    [firstMint, secondMint].sort(),
  );
  assert.equal(
    found.find((row) => row.mint === secondMint)?.purpose,
    'second devnet asset',
  );
});
