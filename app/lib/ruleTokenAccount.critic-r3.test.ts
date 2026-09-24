// Frontend critic, round 3 on PR 192 (feat/rule-token-account).
// The legacy delegate warning (issues 166 and 200). Before a revoke or a close
// that will send SPL revoke on a shared token account, the screen must name the
// other rule whose delegate that signature clears, and must stay quiet when no
// revoke is sent. The other-kind source is issue 202.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { AccountLayout, AccountState, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';

import type { ChainClient } from './chain';
import {
  MANDATE_DISCRIMINATOR,
  STATUS_ACTIVE,
  STATUS_EXPIRED,
  STATUS_REVOKED,
  writeI64Le,
  writeU32Le,
  writeU64Le,
} from './constants';
import type { MandateAccount } from './mandate';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');

const ROOT = new URL('..', import.meta.url).pathname;
const PROGRAM_ID = Keypair.generate().publicKey;
const TOKEN_PROGRAM = Keypair.generate().publicKey;

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

function tokenAccount(args: { mint: PublicKey; owner: PublicKey; amount: bigint; delegate: PublicKey | null }): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: args.mint,
      owner: args.owner,
      amount: args.amount,
      delegateOption: args.delegate ? 1 : 0,
      delegate: args.delegate ?? PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: args.delegate ? args.amount : 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
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

function mandate(over: Partial<MandateAccount>): MandateAccount {
  return {
    address: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    agent: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    source: Keypair.generate().publicKey.toBase58(),
    merchant: Keypair.generate().publicKey.toBase58(),
    mandateId: 42n,
    cap: 200n,
    spent: 20n,
    perTxMax: 60n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) - 3_600),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'rule account',
    status: STATUS_ACTIVE,
    spendCount: 0,
    refusalCount: 0,
    bump: 1,
    ...over,
  };
}

// Two legacy rules on one mint. `other` holds the delegate; `row` is the one
// whose screen is open. Returns the connection and both rows.
function sharedAccount(args: { source: 'associated' | 'other'; status: number }) {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const shared =
    args.source === 'associated'
      ? getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM)
      : Keypair.generate().publicKey;
  const other = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: shared.toBase58(),
    mandateId: 7n,
    purpose: 'coffee',
    status: STATUS_ACTIVE,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
  });
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: shared.toBase58(),
    mandateId: 8n,
    status: args.status,
  });
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) {
        return { data: mintData(6), owner: TOKEN_PROGRAM, executable: false, lamports: 1 };
      }
      if (address.equals(shared)) {
        return {
          data: tokenAccount({ mint, owner, amount: 900n, delegate: new PublicKey(other.address) }),
          owner: TOKEN_PROGRAM,
          executable: false,
          lamports: 1,
        };
      }
      if (address.equals(new PublicKey(other.address))) {
        return { data: encodeMandate(other), owner: PROGRAM_ID, executable: false, lamports: 1 };
      }
      return null;
    },
  };
  return { connection, mint, row, other };
}

test('critic r3: an expired legacy rule names the other rule before close, because close revokes first', async () => {
  const { readRuleFunds } = await chainModule;
  const { connection, mint, row, other } = sharedAccount({ source: 'associated', status: STATUS_EXPIRED });
  const funds = await readRuleFunds(client(connection, mint), row);
  assert.equal(funds.kind, 'associated');
  assert.equal(funds.balance, 900n);
  assert.equal(funds.decimals, 6);
  assert.ok(funds.otherRule, 'the screen has a rule to name');
  assert.match(funds.otherRule, /coffee/);
  assert.match(funds.otherRule, new RegExp(other.address));
});

test('critic r3: a revoked legacy rule names nobody, because its close sends no revoke', async () => {
  const { readRuleFunds } = await chainModule;
  const { connection, mint, row } = sharedAccount({ source: 'associated', status: STATUS_REVOKED });
  const funds = await readRuleFunds(client(connection, mint), row);
  assert.equal(funds.kind, 'associated');
  assert.equal(funds.otherRule, null);
});

test('critic r3: the screen re-reads the delegate before each signature, ahead of revoke and close', () => {
  const src = readFileSync(`${ROOT}/app/rule/[address].tsx`, 'utf8');
  const closeAt = src.indexOf('const onClose = async');
  const revokeAt = src.indexOf('const onRevoke = async');
  const onClose = src.slice(closeAt, revokeAt);
  const onRevoke = src.slice(revokeAt, src.indexOf('return (', revokeAt));
  for (const [name, body, call] of [
    ['close', onClose, 'chain.close('],
    ['revoke', onRevoke, 'chain.revoke('],
  ] as const) {
    const gateAt = body.indexOf('await gateSignature()');
    const callAt = body.indexOf(call);
    assert.ok(gateAt !== -1, `${name} gates the signature`);
    assert.ok(callAt !== -1, `${name} sends the transaction`);
    assert.ok(gateAt < callAt, `${name} gates before it sends`);
    assert.match(body, /if \(!gate\.sign\) \{\s*return;/, `${name} stops when the gate says no`);
  }
});

test(
  'critic r3: a rule on an other-kind source names the other rule too (issue 202)',
  async () => {
    const { readRuleFunds } = await chainModule;
    const { connection, mint, row, other } = sharedAccount({ source: 'other', status: STATUS_EXPIRED });
    const funds = await readRuleFunds(client(connection, mint), row);
    assert.equal(funds.kind, 'other');
    assert.ok(funds.otherRule, 'the screen has a rule to name');
    assert.match(funds.otherRule, new RegExp(other.address));
  },
);
