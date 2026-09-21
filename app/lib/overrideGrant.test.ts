import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey, type Connection } from '@solana/web3.js';

import type { ChainClient } from './chain';
import {
  KIND_REFUSED,
  MANDATE_DISCRIMINATOR,
  REASON_OVER_PER_TX_MAX,
  STATUS_ACTIVE,
  STATUS_EXHAUSTED,
  writeI64Le,
  writeU32Le,
  writeU64Le,
} from './constants';
import type { MandateAccount } from './mandate';
import type { LedgerRow } from './ring';

// lib/config.ts imports expo-constants, which loads react-native. Mock that
// one module so chain.ts runs under node with its real signing path intact.
mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');

// Critic round 2. Drives the live override path in chain.ts end to end with a
// stubbed RPC, so the assertion is on what the app does before it asks the
// wallet for a signature, not on a pure helper.

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

// Mirror of decodeMandateAccount in lib/mandate.ts.
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

function clientFor(live: MandateAccount): ChainClient {
  const bytes = encodeMandate(live);
  const connection = {
    getAccountInfo: async (address: PublicKey) =>
      address.equals(MANDATE_KEY)
        ? { data: bytes, owner: PROGRAM_ID, executable: false, lamports: 1 }
        : { data: Buffer.alloc(0), owner: TOKEN_PROGRAM, executable: false, lamports: 1 },
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }),
  };
  return {
    config: {} as ChainClient['config'],
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
  };
}

function signer() {
  let calls = 0;
  return {
    calls: () => calls,
    fn: async () => {
      calls += 1;
      throw new Error('signer reached');
    },
  };
}

test('CRITIC F2: a rule expired by the clock with a waiver pending is blocked and the wallet is never asked', async () => {
  const { grantOverride, probeOverride } = await chainModule;
  // programs/veto/src/lib.rs evaluate: now >= expires_at refuses REASON_EXPIRED
  // before it reads the override. grant_override does not check the clock, so
  // only the app can refuse to take a signature for a waiver that cannot clear.
  const live = mandate({ status: STATUS_ACTIVE, expiresAt: nowSec() - 60n, overrideNonce: 7n, overrideAmount: 180n });
  const client = clientFor(live);
  const probe = await probeOverride(client, MANDATE_KEY, row(), 0);
  assert.equal(probe.status, 'blocked', `expected blocked, got ${probe.status}`);
  if (probe.status !== 'ready') {
    assert.match(probe.why, /expired/i);
    assert.doesNotMatch(probe.why, /can retry/);
  }
  const wallet = signer();
  await assert.rejects(grantOverride(client, wallet.fn, OWNER, live, row(), 0), /expired/i);
  assert.equal(wallet.calls(), 0, 'no signature may be requested for a waiver that can never clear');
});

test('CRITIC F1: a rule exhausted by a later paid charge with a waiver still pending is blocked and says why', async () => {
  const { grantOverride, probeOverride } = await chainModule;
  // programs/veto/src/lib.rs charge: a paid charge on another nonce can set
  // STATUS_EXHAUSTED while override_nonce still points at this nonce.
  const live = mandate({ status: STATUS_EXHAUSTED, spent: 200n, overrideNonce: 7n, overrideAmount: 180n });
  const client = clientFor(live);
  const probe = await probeOverride(client, MANDATE_KEY, row(), 0);
  assert.equal(probe.status, 'blocked', `expected blocked, got ${probe.status}`);
  if (probe.status !== 'ready') {
    assert.match(probe.why, /exhausted/i);
    assert.doesNotMatch(probe.why, /can retry/);
  }
  const wallet = signer();
  await assert.rejects(grantOverride(client, wallet.fn, OWNER, live, row(), 0), /exhausted/i);
  assert.equal(wallet.calls(), 0);
});

test('regression: a live rule still reaches the signer, and a live pending waiver on the same nonce is still "already"', async () => {
  const { grantOverride, probeOverride } = await chainModule;
  const live = mandate();
  const wallet = signer();
  await assert.rejects(grantOverride(clientFor(live), wallet.fn, OWNER, live, row(), 0), /signer reached/);
  assert.equal(wallet.calls(), 1, 'the stub client must not be what blocks the grant');

  const pending = mandate({ overrideNonce: 7n, overrideAmount: 180n });
  const probe = await probeOverride(clientFor(pending), MANDATE_KEY, row(), 0);
  assert.equal(probe.status, 'already');
});
