import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, SystemProgram, type Connection } from '@solana/web3.js';

import type { ChainClient } from './chain';
import { STATUS_ACTIVE } from './constants';
import type { MandateAccount } from './mandate';

// Reproductions for issue 158. They fail until the product changes.

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });

const chainModule = import('./chain');

const MINT = new PublicKey(Buffer.alloc(32, 5));
const OWNER = new PublicKey(Buffer.alloc(32, 3));
const AGENT = new PublicKey(Buffer.alloc(32, 4));
const MERCHANT = new PublicKey(Buffer.alloc(32, 7));
const PROGRAM_ID = new PublicKey(Buffer.alloc(32, 1));
const PRIOR_DELEGATE = new PublicKey(Buffer.alloc(32, 9));

function sourceAta(): PublicKey {
  return getAssociatedTokenAddressSync(MINT, OWNER, false, TOKEN_PROGRAM_ID);
}

function tokenAccount(delegate?: PublicKey): Buffer {
  const data = Buffer.alloc(165);
  MINT.toBuffer().copy(data, 0);
  OWNER.toBuffer().copy(data, 32);
  if (delegate) {
    data.writeUInt32LE(1, 72);
    delegate.toBuffer().copy(data, 76);
  }
  data[108] = 1;
  return data;
}

function account(data: Buffer, lamports: number) {
  return {
    data,
    executable: false,
    lamports,
    owner: TOKEN_PROGRAM_ID,
  };
}

function clientFor(source: Buffer | null, ownerLamports: number): {
  client: ChainClient;
  signAndSend: (transactions: unknown[]) => Promise<string[]>;
  signed: () => number;
} {
  let signatures = 0;
  const ata = sourceAta();
  const connection = {
    getBalance: async (pubkey: PublicKey) => (pubkey.equals(OWNER) ? ownerLamports : 0),
    getAccountInfo: async (pubkey: PublicKey) => {
      if (pubkey.equals(MINT)) {
        return account(Buffer.alloc(0), 1_000_000);
      }
      if (pubkey.equals(OWNER)) {
        return {
          data: Buffer.alloc(0),
          executable: false,
          lamports: ownerLamports,
          owner: SystemProgram.programId,
        };
      }
      if (pubkey.equals(ata)) {
        return source ? account(source, 1_000_000) : null;
      }
      return null;
    },
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100,
    }),
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  const signAndSend = async () => {
    signatures += 1;
    return ['sig'];
  };
  return {
    signed: () => signatures,
    signAndSend,
    client: {
      config: {
        rpcUrl: 'https://api.devnet.solana.com',
        programId: PROGRAM_ID.toBase58(),
        mint: MINT.toBase58(),
        explorerCluster: 'devnet',
        mintDecimals: 6,
      },
      connection: connection as unknown as Connection,
      programId: PROGRAM_ID,
    },
  };
}

const openInput = {
  owner: OWNER,
  agent: AGENT,
  merchant: MERCHANT,
  cap: 1_000_000n,
  perTxMax: 100_000n,
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
  purpose: 'charge the car',
  mint: MINT,
};

const FUNDED = 50_000_000;

test('opening a rule when the owner has no SOL for rent does not ask for a signature', async () => {
  const { openMandate } = await chainModule;
  const { client, signAndSend, signed } = clientFor(tokenAccount(), 0);
  let error: unknown = null;
  try {
    await openMandate(client, signAndSend, openInput);
  } catch (err) {
    error = err;
  }
  assert.equal(signed(), 0);
  assert.match(error instanceof Error ? error.message : String(error), /rent/i);
});

test('a missing token account error names the mint the rule would spend', async () => {
  const { openMandate } = await chainModule;
  const { client, signAndSend, signed } = clientFor(null, FUNDED);
  let error: unknown = null;
  try {
    await openMandate(client, signAndSend, openInput);
  } catch (err) {
    error = err;
  }
  const message = error instanceof Error ? error.message : String(error);
  assert.match(message, new RegExp(MINT.toBase58()));
  assert.match(message, /will not create/i);
  assert.equal(signed(), 0);
});

test('opening a rule when the token account already has a delegate does not ask for a signature', async () => {
  const { openMandate } = await chainModule;
  const { client, signAndSend, signed } = clientFor(tokenAccount(PRIOR_DELEGATE), FUNDED);
  let error: unknown = null;
  try {
    await openMandate(client, signAndSend, openInput);
  } catch (err) {
    error = err;
  }
  assert.equal(signed(), 0);
  const message = error instanceof Error ? error.message : String(error);
  assert.match(message, /delegate/i);
  assert.match(message, new RegExp(PRIOR_DELEGATE.toBase58()));
});

function screen(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function expectCopy(relativePath: string, pattern: RegExp): void {
  const src = screen(relativePath);
  assert.equal(pattern.test(src), true, `${relativePath} has no copy matching ${pattern}`);
}

test('the open screen says a second rule replaces the mint\'s only delegate before the signature', () => {
  expectCopy('../app/rule/new.tsx', /only delegate|replaces the delegate|one delegate/i);
});

test('the open form accepts an agent address that runs off this phone', () => {
  expectCopy('../app/rule/new.tsx', /label="Agent"/);
  expectCopy('../app/rule/new.tsx', /agent:/);
});

function mandateOwnedBy(delegateOnSource: PublicKey): MandateAccount {
  return {
    address: delegateOnSource.toBase58(),
    owner: OWNER.toBase58(),
    agent: AGENT.toBase58(),
    mint: MINT.toBase58(),
    source: sourceAta().toBase58(),
    merchant: MERCHANT.toBase58(),
    mandateId: 1n,
    cap: 1_000_000n,
    spent: 0n,
    perTxMax: 100_000n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'charge the car',
    status: STATUS_ACTIVE,
    spendCount: 0,
    refusalCount: 0,
    bump: 255,
  };
}

test('revoking a rule whose delegate is a different rule does not ask for a signature', async () => {
  const { revokeMandate } = await chainModule;
  const { client, signAndSend, signed } = clientFor(tokenAccount(PRIOR_DELEGATE), FUNDED);
  const older = mandateOwnedBy(new PublicKey(Buffer.alloc(32, 8)));
  let error: unknown = null;
  try {
    await revokeMandate(client, signAndSend, OWNER, older);
  } catch (err) {
    error = err;
  }
  assert.equal(signed(), 0);
  const message = error instanceof Error ? error.message : String(error);
  assert.match(message, /delegate/i);
  assert.match(message, new RegExp(PRIOR_DELEGATE.toBase58()));
});

test('the revoke screen says this signature clears the mint\'s one delegate before the signature', () => {
  expectCopy('../app/rule/[address].tsx', /only delegate|one delegate|clears the delegate/i);
});

test('a finished rule can be closed and the screen says the rent comes back to the owner', () => {
  expectCopy('../app/rule/[address].tsx', /Close this rule/);
  expectCopy('../app/rule/[address].tsx', /rent/i);
});

test('the rule screen explains Android notification permission and that checks can wait 15 minutes', () => {
  const src = [
    screen('../app/rule/[address].tsx'),
    screen('../app/help/index.tsx'),
    screen('../app/(tabs)/index.tsx'),
  ].join('\n');
  assert.equal(/notification/i.test(src), true, 'no screen mentions notification permission');
  assert.equal(/15 minutes/.test(src), true, 'no screen says the background check can wait 15 minutes');
});

test('the release config can produce a dApp Store APK whose versionCode is not stuck at the Expo default', () => {
  const app = JSON.parse(screen('../app.json')) as {
    expo?: { android?: { versionCode?: unknown } };
  };
  const eas = JSON.parse(screen('../eas.json')) as {
    cli?: { appVersionSource?: unknown };
    build?: { production?: { autoIncrement?: unknown } };
  };
  const explicit = typeof app.expo?.android?.versionCode === 'number';
  const remote =
    eas.cli?.appVersionSource === 'remote' && eas.build?.production?.autoIncrement === true;
  assert.ok(explicit || remote);
});

test('the release config does not ship the dev client permission to draw over other apps', () => {
  const app = JSON.parse(screen('../app.json')) as { expo?: { plugins?: unknown[] } };
  const names = (app.expo?.plugins ?? []).map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  assert.equal(names.includes('expo-dev-client'), false);
});
