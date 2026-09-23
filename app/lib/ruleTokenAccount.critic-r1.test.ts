// Critic round 1 fixtures for the rule token account (PR 192).
//
// Locks: two rules on one mint keep separate accounts and delegates, revoke
// touches only its own account, the open has one required signer, close
// returns tokens to the associated token account and rent to the owner,
// preflight refuses before the prompt, a legacy rule still revokes and closes.
//
// Red on the PR head: the preflight passes a wallet that the chain then
// refuses for its own rent floor, the token shortfall is written in base
// units, the closed note claims a budget came back for a legacy rule, and
// the close note does not say the decision history leaves the chain.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, type Connection, type Transaction } from '@solana/web3.js';

import {
  LEDGER_ACCOUNT_SIZE,
  MANDATE_DISCRIMINATOR,
  OPEN_MANDATE_DISC,
  REVOKE_MANDATE_DISC,
  STATUS_ACTIVE,
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

const ROOT = new URL('..', import.meta.url).pathname;
const PROGRAM_ID = Keypair.generate().publicKey;
const TOKEN_RENT = 2_039_280;
const MANDATE_RENT = 3_474_240;
const LEDGER_RENT = 11_349_200;
const FEE = 5_000;
// getMinimumBalanceForRentExemption(0) on devnet, 2026-09-24. A system account
// left above zero and below this after the open fails with InsufficientFundsForRent.
const PAYER_FLOOR = 650_240;
const SOL_NEEDED = TOKEN_RENT + MANDATE_RENT + LEDGER_RENT + FEE;
const CLOSE_MANDATE_DISC = Buffer.from([117, 87, 189, 5, 254, 125, 248, 180]);
const SPL_TRANSFER_CHECKED = 12;
const SPL_CLOSE_ACCOUNT = 9;
const SPL_APPROVE_CHECKED = 13;

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
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'critic r1',
    status: STATUS_REVOKED,
    spendCount: 0,
    refusalCount: 0,
    bump: 1,
    ...over,
  };
}

type Ledger = Map<string, { data: Buffer; owner: PublicKey }>;

function connectionFor(ledger: Ledger, over: Record<string, unknown> = {}) {
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
    ...over,
  };
}

async function captureOpen(
  ledger: Ledger,
  mint: PublicKey,
  input: { owner: PublicKey; agent: PublicKey; merchant: PublicKey; cap: bigint },
  over: Record<string, unknown> = {},
): Promise<{ prompts: number; txs: Transaction[]; error: Error | null }> {
  const { openMandate } = await chainModule;
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
    await openMandate(client(connectionFor(ledger, over), mint), signAndSend, {
      ...input,
      perTxMax: 60n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
      purpose: 'critic r1',
    });
  } catch (err) {
    if (err !== stop) {
      error = err as Error;
    }
  }
  return { prompts, txs, error };
}

function openIx(tx: Transaction) {
  const ix = tx.instructions.find((item) => item.programId.equals(PROGRAM_ID));
  assert.ok(ix, 'the transaction carries one program instruction');
  assert.ok(Buffer.from(ix.data.subarray(0, 8)).equals(OPEN_MANDATE_DISC));
  return ix;
}

test('critic r1: two rules on one mint open against two different accounts, neither the associated token account', async () => {
  const owner = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [ata.toBase58(), { data: tokenData(1_000n), owner: tokenProgram }],
  ]);

  const first = await captureOpen(ledger, mint, { owner, agent: Keypair.generate().publicKey, merchant, cap: 200n });
  assert.equal(first.error, null);
  const firstSource = openIx(first.txs[0]!).keys[3]!.pubkey;
  // The first rule now exists on chain: its mandate PDA and its token account.
  const { deriveRuleTokenAccount } = await ruleAccountModule;
  const firstId = Buffer.from(openIx(first.txs[0]!).data).readBigUInt64LE(8);
  assert.ok(firstSource.equals(await deriveRuleTokenAccount(owner, firstId, tokenProgram)));
  ledger.set(firstSource.toBase58(), { data: tokenData(200n), owner: tokenProgram });
  const firstMandate = openIx(first.txs[0]!).keys[1]!.pubkey;
  ledger.set(firstMandate.toBase58(), { data: Buffer.alloc(310), owner: PROGRAM_ID });

  const second = await captureOpen(ledger, mint, { owner, agent: Keypair.generate().publicKey, merchant, cap: 300n });
  assert.equal(second.error, null);
  const secondSource = openIx(second.txs[0]!).keys[3]!.pubkey;

  assert.notEqual(firstSource.toBase58(), secondSource.toBase58(), 'each rule has its own account');
  assert.notEqual(firstSource.toBase58(), ata.toBase58());
  assert.notEqual(secondSource.toBase58(), ata.toBase58());
  for (const ix of second.txs[0]!.instructions) {
    assert.ok(
      ix.keys.every((key) => !key.pubkey.equals(firstSource)),
      'the second open never names the first rule account',
    );
    assert.notEqual(ix.data[0], SPL_APPROVE_CHECKED, 'the app itself approves nothing; the program does');
  }
});

test('critic r1: revoking one rule names only its own account and moves no tokens', async () => {
  const { revokeMandate } = await chainModule;
  const { deriveRuleTokenAccount } = await ruleAccountModule;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const sourceA = await deriveRuleTokenAccount(owner, 11n, tokenProgram);
  const sourceB = await deriveRuleTokenAccount(owner, 12n, tokenProgram);
  const a = row({ owner: owner.toBase58(), mint: mint.toBase58(), source: sourceA.toBase58(), mandateId: 11n, status: STATUS_ACTIVE });
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [sourceA.toBase58(), { data: tokenData(200n), owner: tokenProgram }],
    [sourceB.toBase58(), { data: tokenData(300n), owner: tokenProgram }],
  ]);
  const txs: Transaction[] = [];
  const stop = new Error('stop before send');
  await assert.rejects(
    () =>
      revokeMandate(
        client(connectionFor(ledger), mint),
        async (batch) => {
          txs.push(...batch);
          throw stop;
        },
        owner,
        a,
      ),
    (err: unknown) => err === stop,
  );
  assert.equal(txs.length, 1);
  const tx = txs[0]!;
  assert.equal(tx.instructions.length, 1, 'revoke is one program instruction');
  const ix = tx.instructions[0]!;
  assert.ok(Buffer.from(ix.data).equals(REVOKE_MANDATE_DISC));
  assert.ok(ix.keys[3]!.pubkey.equals(sourceA), 'the source is this rule account');
  assert.ok(ix.keys.every((key) => !key.pubkey.equals(sourceB)), 'the other rule account is never named');
  assert.ok(tx.instructions.every((item) => !item.programId.equals(tokenProgram)), 'no token instruction, so no balance moves');
});

test('critic r1: the open message requires exactly one signature, the owner', async () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [ata.toBase58(), { data: tokenData(1_000n), owner: tokenProgram }],
  ]);
  const { prompts, txs, error } = await captureOpen(ledger, mint, {
    owner,
    agent: Keypair.generate().publicKey,
    merchant: Keypair.generate().publicKey,
    cap: 200n,
  });
  assert.equal(error, null);
  assert.equal(prompts, 1);
  const message = txs[0]!.compileMessage();
  assert.equal(message.header.numRequiredSignatures, 1, 'one required signer');
  assert.ok(message.accountKeys[0]!.equals(owner), 'and it is the owner');
  const create = txs[0]!.instructions[0]!;
  assert.ok(create.programId.equals(SystemProgram.programId));
  assert.ok(
    create.keys.filter((key) => key.isSigner).every((key) => key.pubkey.equals(owner)),
    'createAccountWithSeed signs as the owner for both from and base',
  );
});

test('critic r1: close returns the remaining tokens to the associated token account and every rent to the owner', async () => {
  const { closeMandate } = await chainModule;
  const { deriveRuleTokenAccount } = await ruleAccountModule;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const source = await deriveRuleTokenAccount(owner, 21n, tokenProgram);
  const m = row({ owner: owner.toBase58(), mint: mint.toBase58(), source: source.toBase58(), mandateId: 21n, status: STATUS_REVOKED });
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [source.toBase58(), { data: tokenData(123n), owner: tokenProgram }],
    [ata.toBase58(), { data: tokenData(0n), owner: tokenProgram }],
    [m.address, { data: encodeMandate(m), owner: PROGRAM_ID }],
  ]);
  const txs: Transaction[] = [];
  const stop = new Error('stop before send');
  await assert.rejects(
    () =>
      closeMandate(
        client(connectionFor(ledger), mint),
        async (batch) => {
          txs.push(...batch);
          throw stop;
        },
        owner,
        m,
      ),
    (err: unknown) => err === stop,
  );
  const tx = txs[0]!;
  assert.equal(tx.compileMessage().header.numRequiredSignatures, 1);
  const transfer = tx.instructions.find((ix) => ix.programId.equals(tokenProgram) && ix.data[0] === SPL_TRANSFER_CHECKED);
  assert.ok(transfer, 'a transferChecked moves the remainder');
  assert.equal(Buffer.from(transfer.data).readBigUInt64LE(1), 123n, 'the whole remaining balance');
  assert.ok(transfer.keys[0]!.pubkey.equals(source));
  assert.ok(transfer.keys[2]!.pubkey.equals(ata), 'to the associated token account');
  const close = tx.instructions.find((ix) => ix.programId.equals(tokenProgram) && ix.data[0] === SPL_CLOSE_ACCOUNT);
  assert.ok(close, 'the rule account is closed');
  assert.ok(close.keys[1]!.pubkey.equals(owner), 'its rent goes to the owner');
  const closeMandateIx = tx.instructions.find((ix) => ix.programId.equals(PROGRAM_ID));
  assert.ok(closeMandateIx && Buffer.from(closeMandateIx.data).equals(CLOSE_MANDATE_DISC));
  assert.ok(closeMandateIx.keys[0]!.pubkey.equals(owner) && closeMandateIx.keys[0]!.isWritable, 'mandate and ledger rent land on the owner');
  assert.ok(tx.instructions.indexOf(transfer) < tx.instructions.indexOf(close), 'transfer before close');
  assert.ok(tx.instructions.indexOf(close) < tx.instructions.indexOf(closeMandateIx), 'token close before mandate close');
});

test('critic r1: a token shortfall is refused before the wallet prompt', async () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [ata.toBase58(), { data: tokenData(199n), owner: tokenProgram }],
  ]);
  const { prompts, error } = await captureOpen(ledger, mint, { owner, agent: Keypair.generate().publicKey, merchant: Keypair.generate().publicKey, cap: 200n });
  assert.equal(prompts, 0, 'no wallet prompt');
  assert.ok(error, 'the app refuses');
});

test('critic r1: a lamport shortfall is refused before the wallet prompt', async () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [ata.toBase58(), { data: tokenData(1_000n), owner: tokenProgram }],
  ]);
  const { prompts, error } = await captureOpen(
    ledger,
    mint,
    { owner, agent: Keypair.generate().publicKey, merchant: Keypair.generate().publicKey, cap: 200n },
    { getBalance: async () => SOL_NEEDED - 1 },
  );
  assert.equal(prompts, 0, 'no wallet prompt');
  assert.ok(error && /rent/i.test(error.message), 'the refusal names rent');
});

test('critic r1: RED a wallet the chain would leave above zero and under its own rent floor is refused before the prompt', async () => {
  // Owner holds rent + fee + 1 lamport. Every account is funded, then the
  // payer is left with 1 lamport: not zero, not rent exempt. The runtime
  // rejects that transition with InsufficientFundsForRent, after the prompt.
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [ata.toBase58(), { data: tokenData(1_000n), owner: tokenProgram }],
  ]);
  const { prompts, error } = await captureOpen(
    ledger,
    mint,
    { owner, agent: Keypair.generate().publicKey, merchant: Keypair.generate().publicKey, cap: 200n },
    { getBalance: async () => SOL_NEEDED + 1 },
  );
  assert.equal(prompts, 0, 'the app refuses before the prompt instead of letting the chain refuse after it');
  assert.ok(error, 'and says why');
});

test('critic r1: RED the token shortfall is written in the mint units the rest of the screen uses, not base units', async () => {
  const { openFundsRefusal } = await ruleAccountModule;
  const ata = Keypair.generate().publicKey;
  const message = openFundsRefusal({
    ata,
    ataFound: true,
    balance: 1_000_000n,
    cap: 5_000_000n,
    solBalance: 1_000_000_000n,
    tokenRent: BigInt(TOKEN_RENT),
    mandateRent: BigInt(MANDATE_RENT),
    ledgerRent: BigInt(LEDGER_RENT),
    feeLamports: BigInt(FEE),
    decimals: 6,
  } as never);
  assert.ok(message, 'a shortfall is refused');
  assert.doesNotMatch(message, /base units/, 'the screen never says base units anywhere else');
  assert.match(message, /\b5\b/, 'the cap reads as 5, the way Total cap does on the rule screen');
  assert.match(message, /\b4\b/, 'and the shortfall as 4');
});

test('critic r1: RED the closed note tells a legacy rule the truth: only the rent came back', async () => {
  const src = readFileSync(`${ROOT}/app/rule/[address].tsx`, 'utf8');
  assert.doesNotMatch(
    src,
    /setClosedNote\(\s*'Closed on chain\. The remaining budget and the rent are back with the owner\.'\s*\)/,
    'the same sentence for every kind claims a budget came back from an associated token account that was never emptied',
  );
  const mod = (await ruleAccountModule) as Record<string, unknown>;
  assert.equal(typeof mod.closedLine, 'function', 'ruleAccount exports closedLine(kind), next to budgetLine and closeNote');
  const closedLine = mod.closedLine as (kind: string) => string;
  assert.match(closedLine('dedicated'), /budget/);
  assert.doesNotMatch(closedLine('associated'), /budget/);
  assert.match(closedLine('associated'), /rent/);
});

test('critic r1: RED the close note says the decision history leaves the chain', async () => {
  // close_mandate closes the ledger to the owner (programs/veto/src/lib.rs, CloseMandate.ledger: close = owner).
  // The screen keeps "The decisions stay readable." under the Close button. The
  // close note has to say the history goes with the accounts, for every kind.
  const { closeNote } = await ruleAccountModule;
  for (const kind of ['dedicated', 'associated', 'other'] as const) {
    for (const stillActive of [true, false]) {
      assert.match(
        closeNote(kind, stillActive),
        /decision|history/i,
        `closeNote(${kind}, ${stillActive}) must say the decisions leave the chain`,
      );
    }
  }
});

test('critic r1: a legacy rule on the associated token account still revokes and closes, and that account stays', async () => {
  const { closeMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const m = row({ owner: owner.toBase58(), mint: mint.toBase58(), source: ata.toBase58(), mandateId: 31n, status: STATUS_ACTIVE });
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [ata.toBase58(), { data: tokenData(777n), owner: tokenProgram }],
    [m.address, { data: encodeMandate(m), owner: PROGRAM_ID }],
  ]);
  const txs: Transaction[] = [];
  const stop = new Error('stop before send');
  await assert.rejects(
    () =>
      closeMandate(
        client(connectionFor(ledger), mint),
        async (batch) => {
          txs.push(...batch);
          throw stop;
        },
        owner,
        m,
      ),
    (err: unknown) => err === stop,
  );
  const tx = txs[0]!;
  assert.equal(tx.compileMessage().header.numRequiredSignatures, 1);
  assert.deepEqual(
    tx.instructions.map((ix) => (ix.programId.equals(PROGRAM_ID) ? Buffer.from(ix.data.subarray(0, 8)).toString('hex') : 'other')),
    [REVOKE_MANDATE_DISC.toString('hex'), CLOSE_MANDATE_DISC.toString('hex')],
    'revoke then close, nothing else',
  );
  assert.ok(tx.instructions[0]!.keys[3]!.pubkey.equals(ata), 'revoke names the associated token account');
  assert.ok(tx.instructions.every((ix) => !ix.programId.equals(tokenProgram)), 'no token instruction: the associated token account is neither emptied nor closed');
});

test('critic r1: the rule screen balance is the amount the chain holds in the source account', async () => {
  const { readRuleFunds } = await chainModule;
  const { deriveRuleTokenAccount } = await ruleAccountModule;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const source = await deriveRuleTokenAccount(owner, 41n, tokenProgram);
  const m = row({ owner: owner.toBase58(), mint: mint.toBase58(), source: source.toBase58(), mandateId: 41n });
  const ledger: Ledger = new Map([
    [mint.toBase58(), { data: mintData(6), owner: tokenProgram }],
    [source.toBase58(), { data: tokenData(4_560_000n), owner: tokenProgram }],
  ]);
  const funds = await readRuleFunds(client(connectionFor(ledger), mint), m);
  assert.equal(funds.balance, 4_560_000n);
  assert.equal(funds.kind, 'dedicated');
  assert.equal(funds.source, source.toBase58());
  const src = readFileSync(`${ROOT}/app/rule/[address].tsx`, 'utf8');
  assert.match(src, /formatBaseUnits\(funds\.balance, chain\.decimals\)/, 'the screen formats that number, not the cap');
});
