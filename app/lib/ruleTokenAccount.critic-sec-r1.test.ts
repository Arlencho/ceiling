// Security critic round 1 fixtures for the rule token account (PR 192).
//
// Locks: the open transaction makes the owner the authority of the rule token
// account and the base of its seed, and close by a key that is not the live
// owner stops before the wallet prompt. A legacy rule already revoked on chain
// is closed without a second revoke, which the program would refuse.
//
// Red on the PR head: closing a legacy rule whose on-chain status is EXPIRED
// (set by a refused charge, never revoked) sends no revoke, so the associated
// token account keeps its delegation to the mandate PDA after the mandate is
// gone, and the app has no later path to drop it.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, SystemInstruction, SystemProgram, type Connection, type Transaction } from '@solana/web3.js';

import {
  CLOSE_MANDATE_DISC,
  LEDGER_ACCOUNT_SIZE,
  MANDATE_DISCRIMINATOR,
  REVOKE_MANDATE_DISC,
  STATUS_EXPIRED,
  STATUS_REVOKED,
  writeI64Le,
  writeU32Le,
  writeU64Le,
} from './constants';
import type { ChainClient, SignAndSend } from './chain';
import type { MandateAccount } from './mandate';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');
const ruleAccountModule = import('./ruleAccount');

const PROGRAM_ID = Keypair.generate().publicKey;
const TOKEN_RENT = 2_039_280;
const MANDATE_RENT = 3_474_240;
const LEDGER_RENT = 11_349_200;
const PAYER_FLOOR = 890_880;
const SOL_NEEDED = TOKEN_RENT + MANDATE_RENT + LEDGER_RENT + 5_000;
const SPL_INITIALIZE_ACCOUNT3 = 18;
const SYSTEM_CREATE_ACCOUNT_WITH_SEED = 3;

function client(connection: Record<string, unknown>, mint: PublicKey): ChainClient {
  return {
    config: {
      rpcUrl: 'https://api.devnet.solana.com',
      programId: PROGRAM_ID.toBase58(),
      mint: mint.toBase58(),
      explorerCluster: 'devnet',
      mintDecimals: 6,
    },
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
  };
}

function mintData(decimals: number): Buffer {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  return data;
}

function tokenData(amount: bigint): Buffer {
  const data = Buffer.alloc(165);
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

function row(over: Partial<MandateAccount>): MandateAccount {
  return {
    address: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    agent: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    source: Keypair.generate().publicKey.toBase58(),
    merchant: Keypair.generate().publicKey.toBase58(),
    mandateId: 1n,
    cap: 200n,
    spent: 0n,
    perTxMax: 60n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) - 60),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'critic sec r1',
    status: STATUS_REVOKED,
    spendCount: 0,
    refusalCount: 1,
    bump: 1,
    ...over,
  };
}

type Ledger = Map<string, { data: Buffer; owner: PublicKey }>;

function connectionFor(ledger: Ledger) {
  return {
    getAccountInfo: async (address: PublicKey) => {
      const hit = ledger.get(address.toBase58());
      return hit ? { data: hit.data, owner: hit.owner, executable: false, lamports: 1 } : null;
    },
    getBalance: async () => SOL_NEEDED + PAYER_FLOOR,
    getMinimumBalanceForRentExemption: async (size: number) => {
      if (size === 0) return PAYER_FLOOR;
      if (size === 165) return TOKEN_RENT;
      if (size === 310) return MANDATE_RENT;
      if (size === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
      throw new Error(`unexpected rent size ${size}`);
    },
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 }),
    confirmTransaction: async () => {
      throw new Error('confirm must not be reached');
    },
  };
}

async function captureClose(
  ledger: Ledger,
  mint: PublicKey,
  signer: PublicKey,
  m: MandateAccount,
): Promise<{ prompts: number; txs: Transaction[]; error: Error | null }> {
  const { closeMandate } = await chainModule;
  const txs: Transaction[] = [];
  let prompts = 0;
  const stop = new Error('stop before send');
  const signAndSend: SignAndSend = async (batch) => {
    prompts += 1;
    txs.push(...batch);
    throw stop;
  };
  let error: Error | null = null;
  try {
    await closeMandate(client(connectionFor(ledger), mint), signAndSend, signer, m);
  } catch (err) {
    if (err !== stop) {
      error = err as Error;
    }
  }
  return { prompts, txs, error };
}

function legacyRule(status: number) {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const m = row({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: ata.toBase58(),
    mandateId: 4242n,
    cap: 300n,
    spent: 0n,
    status,
  });
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [ata.toBase58(), { data: tokenData(1_000n), owner: tokenProgram }],
    [m.address, { data: encodeMandate(m), owner: PROGRAM_ID }],
  ]);
  return { owner, mint, tokenProgram, ata, m, ledger };
}

test('critic sec r1: RED closing a legacy rule the chain marked expired drops its delegation before the mandate is gone', async () => {
  // A refused charge past expiry sets status EXPIRED on chain. Nothing has
  // called revoke, so the associated token account still names the mandate
  // PDA as delegate for cap minus spent. close_mandate does not touch the
  // token account, and once the mandate is closed revoke_mandate has no
  // account to act on. The close transaction is the last chance to revoke.
  const { owner, mint, ata, m, ledger } = legacyRule(STATUS_EXPIRED);
  const { prompts, txs, error } = await captureClose(ledger, mint, owner, m);
  assert.equal(error, null);
  assert.equal(prompts, 1);
  const tx = txs[0]!;
  const closeIx = tx.instructions.find(
    (ix) => ix.programId.equals(PROGRAM_ID) && Buffer.from(ix.data).equals(CLOSE_MANDATE_DISC),
  );
  assert.ok(closeIx, 'close_mandate is sent');
  const revokeIx = tx.instructions.find(
    (ix) => ix.programId.equals(PROGRAM_ID) && Buffer.from(ix.data).equals(REVOKE_MANDATE_DISC),
  );
  assert.ok(
    revokeIx,
    `an expired legacy rule is revoked in the close transaction so ${ata.toBase58()} does not keep a delegation to a mandate that no longer exists`,
  );
  assert.ok(revokeIx.keys[3]!.pubkey.equals(ata), 'the revoke names the associated token account');
  assert.ok(tx.instructions.indexOf(revokeIx) < tx.instructions.indexOf(closeIx), 'revoke before close');
});

test('critic sec r1: closing a legacy rule already revoked on chain does not revoke it again', async () => {
  // revoke_mandate refuses a second revoke, so the fix must key on the status
  // the chain reports, not revoke unconditionally.
  const { mint, owner, m, ledger } = legacyRule(STATUS_REVOKED);
  const { prompts, txs, error } = await captureClose(ledger, mint, owner, m);
  assert.equal(error, null);
  assert.equal(prompts, 1);
  const tx = txs[0]!;
  const revokeIx = tx.instructions.find(
    (ix) => ix.programId.equals(PROGRAM_ID) && Buffer.from(ix.data).equals(REVOKE_MANDATE_DISC),
  );
  assert.equal(revokeIx, undefined, 'no second revoke');
  assert.equal(tx.instructions.length, 1, 'close_mandate alone');
});

test('critic sec r1: close by a key that is not the live owner stops before the wallet prompt', async () => {
  const { mint, m, ledger } = legacyRule(STATUS_REVOKED);
  const stranger = Keypair.generate().publicKey;
  const { prompts, txs, error } = await captureClose(ledger, mint, stranger, m);
  assert.equal(prompts, 0);
  assert.equal(txs.length, 0);
  assert.match(error?.message ?? '', /only the owner/i);
});

test('critic sec r1: the open transaction makes the owner the authority of the rule token account and the base of its seed', async () => {
  const { openMandate } = await chainModule;
  const { deriveRuleTokenAccount } = await ruleAccountModule;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [ata.toBase58(), { data: tokenData(1_000n), owner: tokenProgram }],
  ]);
  const txs: Transaction[] = [];
  const stop = new Error('stop before send');
  await assert.rejects(
    () =>
      openMandate(
        client(connectionFor(ledger), mint),
        async (batch) => {
          txs.push(...batch);
          throw stop;
        },
        {
          owner,
          agent: Keypair.generate().publicKey,
          merchant: Keypair.generate().publicKey,
          cap: 200n,
          perTxMax: 60n,
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
          purpose: 'critic sec r1',
        },
      ),
    (err: unknown) => err === stop,
  );
  const tx = txs[0]!;
  const create = tx.instructions[0]!;
  assert.ok(create.programId.equals(SystemProgram.programId));
  assert.equal(Buffer.from(create.data).readUInt32LE(0), SYSTEM_CREATE_ACCOUNT_WITH_SEED);
  const decoded = SystemInstruction.decodeCreateWithSeed(create);
  assert.ok(decoded.basePubkey.equals(owner), 'the seed base is the owner');
  assert.ok(decoded.fromPubkey.equals(owner), 'and the owner pays');
  assert.equal(create.keys.length, 2, 'web3 folds base into from when they are one key, so the owner is the only signer here');
  assert.equal(create.keys[0]!.isSigner, true, 'the owner signs for the base, so nobody else can create or assign this address');
  assert.ok(decoded.programId.equals(tokenProgram), 'the account is assigned to the token program of the mint');
  const ruleAccount = decoded.newAccountPubkey;
  const mandateId = Buffer.from(tx.instructions[3]!.data).readBigUInt64LE(8);
  assert.ok(ruleAccount.equals(await deriveRuleTokenAccount(owner, mandateId, tokenProgram)));
  const init = tx.instructions[1]!;
  assert.ok(init.programId.equals(tokenProgram));
  assert.equal(init.data[0], SPL_INITIALIZE_ACCOUNT3);
  const authority = new PublicKey(Buffer.from(init.data).subarray(1, 33));
  assert.ok(authority.equals(owner), 'the token account authority is the owner, not the mandate and not the agent');
  assert.ok(init.keys[0]!.pubkey.equals(ruleAccount));
  assert.equal(
    tx.instructions.filter((ix) => ix.programId.equals(tokenProgram) && ix.data[0] === SPL_INITIALIZE_ACCOUNT3).length,
    1,
    'exactly one account is initialised',
  );
});
