// Security critic round 1 localnet probes for the rule token account (PR 192).
//
// Skipped unless VETO_RPC is set: needs a validator with the program loaded
// at the committed id, and drives the app's own openMandate and closeMandate
// against it with a keypair signer. In CI every case reports as skipped.
//
//   ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys
//   solana-test-validator --reset --rpc-port 18899 --faucet-port 19900 \
//     --bpf-program 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV target/deploy/veto.so -q
//   cd app && VETO_RPC=http://127.0.0.1:18899 \
//     npx tsx --experimental-test-module-mocks --test --test-reporter=tap \
//     lib/ruleTokenAccount.critic-sec-r1.localnet.test.ts
//
// Attacks: a stranger tries to create or assign the derived address (hijack),
// a stranger funds the derived address between the app's free check and the
// send (front-run), the agent and a stranger try to move the rule's budget
// outside charge, a stranger and the owner try close_mandate on an active
// rule, and the owner closes a legacy rule the chain marked expired.
import assert from 'node:assert/strict';
import test, { before, mock } from 'node:test';
import { Buffer } from 'buffer';
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotent,
  createMint,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  getAccount,
  mintTo,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';

import { CHARGE_IX_DISC, STATUS_ACTIVE, STATUS_EXPIRED, readU64Le, writeU64Le } from './constants';
import type { ChainClient, SignAndSend } from './chain';
import type { MandateAccount } from './mandate';
import { ledgerPda, mandatePda } from './ring';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');
const instructionsModule = import('./instructions');
const ruleAccountModule = import('./ruleAccount');

const LIVE = process.env.VETO_RPC !== undefined;
const RPC = process.env.VETO_RPC ?? 'http://127.0.0.1:18899';
const live = LIVE ? test : test.skip;
const PROGRAM_ID = new PublicKey('3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV');
const DECIMALS = 6;
const FUNDED = 1_000_000n;
const CAP = 300_000n;
const PER_TX = 100_000n;

const connection = new Connection(RPC, 'confirmed');
const payer = Keypair.generate();
const owner = Keypair.generate();
const attacker = Keypair.generate();
const agent = Keypair.generate();
const merchant = Keypair.generate();
let mint: PublicKey;
let ownerAta: PublicKey;
let agentAta: PublicKey;
let merchantAta: PublicKey;
let client: ChainClient;

function signWith(kp: Keypair): SignAndSend {
  return async (txs) => {
    const sigs: string[] = [];
    for (const tx of txs) {
      tx.sign(kp);
      sigs.push(await connection.sendRawTransaction(tx.serialize()));
    }
    return sigs;
  };
}

async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0]!.publicKey;
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
}

function errorText(err: unknown): string {
  const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
  return [e.message ?? String(err), ...(e.transactionLogs ?? []), ...(e.logs ?? [])].join('\n');
}

async function rejectsWith(run: () => Promise<unknown>, needle: RegExp, why: string): Promise<void> {
  let text: string | null = null;
  try {
    await run();
  } catch (err) {
    text = errorText(err);
  }
  assert.ok(text !== null, `${why}: the transaction was accepted`);
  assert.match(text, needle, `${why}: refused for another reason:\n${text}`);
}

async function airdrop(to: PublicKey, sol: number): Promise<void> {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
}

async function chainNow(): Promise<number> {
  const slot = await connection.getSlot('confirmed');
  const t = await connection.getBlockTime(slot);
  assert.ok(t !== null);
  return t;
}

async function waitUntilChainTime(target: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await chainNow()) >= target) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('chain clock did not reach the target');
}

function chargeIx(mandate: PublicKey, source: PublicKey, destination: PublicKey, amount: bigint, nonce: bigint) {
  const data = Buffer.alloc(24);
  CHARGE_IX_DISC.copy(data, 0);
  writeU64Le(data, 8, amount);
  writeU64Le(data, 16, nonce);
  return {
    programId: PROGRAM_ID,
    data,
    keys: [
      { pubkey: agent.publicKey, isSigner: true, isWritable: false },
      { pubkey: mandate, isSigner: false, isWritable: true },
      { pubkey: ledgerPda(PROGRAM_ID, mandate), isSigner: false, isWritable: true },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  } as TransactionInstruction;
}

async function openViaApp(expiresAt: bigint): Promise<MandateAccount> {
  const { openMandate } = await chainModule;
  const result = await openMandate(client, signWith(owner), {
    owner: owner.publicKey,
    agent: agent.publicKey,
    merchant: merchant.publicKey,
    cap: CAP,
    perTxMax: PER_TX,
    expiresAt,
    purpose: 'critic sec r1',
  });
  return result.mandate;
}

if (LIVE) before(async () => {
  await Promise.all([airdrop(payer.publicKey, 10), airdrop(owner.publicKey, 10), airdrop(attacker.publicKey, 10), airdrop(agent.publicKey, 10)]);
  mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
  ownerAta = await createAssociatedTokenAccountIdempotent(connection, payer, mint, owner.publicKey);
  agentAta = await createAssociatedTokenAccountIdempotent(connection, payer, mint, agent.publicKey);
  merchantAta = await createAssociatedTokenAccountIdempotent(connection, payer, mint, merchant.publicKey);
  await mintTo(connection, payer, mint, ownerAta, payer, Number(FUNDED));
  client = {
    config: {
      rpcUrl: RPC,
      programId: PROGRAM_ID.toBase58(),
      mint: mint.toBase58(),
      explorerCluster: 'devnet',
      mintDecimals: DECIMALS,
    },
    connection,
    programId: PROGRAM_ID,
  };
});

live('sec r1: a stranger cannot create or assign the derived rule address, the owner is the seed base', async () => {
  const { deriveRuleTokenAccount, ruleTokenSeed } = await ruleAccountModule;
  const seed = ruleTokenSeed(999n);
  const derived = await deriveRuleTokenAccount(owner.publicKey, 999n, TOKEN_PROGRAM_ID);
  const rent = await connection.getMinimumBalanceForRentExemption(165);
  for (const ix of [
    SystemProgram.createAccountWithSeed({
      fromPubkey: attacker.publicKey,
      basePubkey: owner.publicKey,
      seed,
      newAccountPubkey: derived,
      lamports: rent,
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    }),
    SystemProgram.allocate({ accountPubkey: derived, basePubkey: owner.publicKey, seed, space: 165, programId: TOKEN_PROGRAM_ID }),
    SystemProgram.assign({ accountPubkey: derived, basePubkey: owner.publicKey, seed, programId: TOKEN_PROGRAM_ID }),
  ]) {
    const tx = new Transaction().add(ix);
    tx.feePayer = attacker.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(attacker);
    await rejectsWith(
      () => connection.sendRawTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
      /signature/i,
      'a stranger signing for the owner base',
    );
  }
  assert.equal(await connection.getAccountInfo(derived, 'confirmed'), null, 'the address is untouched');
});

live('sec r1: a stranger funding the derived address between the free check and the send fails the open whole, and the owner reclaims the lamports', async () => {
  const { openMandate } = await chainModule;
  const floor = await connection.getMinimumBalanceForRentExemption(0);
  const before = (await getAccount(connection, ownerAta)).amount;
  let ruleAccount: PublicKey | null = null;
  let mandateKey: PublicKey | null = null;
  let mandateId = 0n;
  const frontRun: SignAndSend = async (txs) => {
    const tx = txs[0]!;
    ruleAccount = tx.instructions[0]!.keys[1]!.pubkey;
    mandateKey = tx.instructions[3]!.keys[1]!.pubkey;
    mandateId = readU64Le(tx.instructions[3]!.data, 8);
    await send([SystemProgram.transfer({ fromPubkey: attacker.publicKey, toPubkey: ruleAccount, lamports: floor })], [attacker]);
    tx.sign(owner);
    return [await connection.sendRawTransaction(tx.serialize())];
  };
  const expiresAt = BigInt((await chainNow()) + 3_600);
  await rejectsWith(
    () =>
      openMandate(client, frontRun, {
        owner: owner.publicKey,
        agent: agent.publicKey,
        merchant: merchant.publicKey,
        cap: CAP,
        perTxMax: PER_TX,
        expiresAt,
        purpose: 'critic sec r1',
      }),
    /already in use/i,
    'the open against a pre-funded address',
  );
  assert.ok(ruleAccount && mandateKey, 'the app reached the send');
  const ruleKey: PublicKey = ruleAccount!;
  const mandatePk: PublicKey = mandateKey!;
  assert.equal((await getAccount(connection, ownerAta)).amount, before, 'no tokens moved');
  assert.equal(await connection.getAccountInfo(mandatePk, 'confirmed'), null, 'no mandate was opened');
  const held = await connection.getAccountInfo(ruleKey, 'confirmed');
  assert.ok(held && held.owner.equals(SystemProgram.programId) && held.lamports === floor, 'the stranger left a system account there');
  const { ruleTokenSeed } = await ruleAccountModule;
  await send(
    [
      SystemProgram.transfer({
        fromPubkey: ruleKey,
        basePubkey: owner.publicKey,
        toPubkey: owner.publicKey,
        lamports: floor,
        seed: ruleTokenSeed(mandateId),
        programId: TOKEN_PROGRAM_ID,
      }),
    ],
    [owner],
  );
  assert.equal(await connection.getAccountInfo(ruleKey, 'confirmed'), null, 'the owner pulled the lamports back with the seed');
});

live('sec r1: the open lands as the preview says: cap moves into an account only the owner controls, delegated to the mandate for the cap', async () => {
  const { deriveRuleTokenAccount } = await ruleAccountModule;
  const before = (await getAccount(connection, ownerAta)).amount;
  const m = await openViaApp(BigInt((await chainNow()) + 3_600));
  const rule = await deriveRuleTokenAccount(owner.publicKey, m.mandateId, TOKEN_PROGRAM_ID);
  assert.equal(m.source, rule.toBase58());
  assert.equal(m.status, STATUS_ACTIVE);
  const acct = await getAccount(connection, rule);
  assert.ok(acct.owner.equals(owner.publicKey), 'authority is the owner');
  assert.equal(acct.amount, CAP, 'holds exactly the cap');
  assert.ok(acct.delegate?.equals(new PublicKey(m.address)), 'delegate is the mandate');
  assert.equal(acct.delegatedAmount, CAP);
  assert.equal(acct.closeAuthority, null);
  assert.equal((await getAccount(connection, ownerAta)).amount, before - CAP, 'the associated token account lost exactly the cap');
  assert.equal((await getAccount(connection, ownerAta)).delegate, null, 'and carries no delegation');
});

live('sec r1: neither the agent nor a stranger can move the rule budget outside charge, and charge stays inside the mandate', async () => {
  const { fetchMandate } = await chainModule;
  const rows = await connection.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters: [{ dataSize: 310 }] });
  const live = (await Promise.all(rows.map((r) => fetchMandate(client, r.pubkey)))).find((x) => x.status === STATUS_ACTIVE);
  assert.ok(live);
  const rule = new PublicKey(live.source);
  const mandate = new PublicKey(live.address);
  await rejectsWith(
    () => send([createTransferCheckedInstruction(rule, mint, agentAta, agent.publicKey, 1n, DECIMALS)], [agent]),
    /owner does not match|0x4/i,
    'agent transferring from the rule account as authority',
  );
  await rejectsWith(
    () => send([createTransferCheckedInstruction(rule, mint, agentAta, mandate, 1n, DECIMALS, [agent])], [agent]),
    /signature/i,
    'agent signing as the mandate delegate',
  );
  // closeAccount checks the zero balance before the authority, so the
  // authority probes go through setAuthority and approve instead.
  await rejectsWith(
    () => send([createSetAuthorityInstruction(rule, attacker.publicKey, AuthorityType.AccountOwner, attacker.publicKey)], [attacker]),
    /owner does not match|0x4/i,
    'a stranger taking the rule account authority',
  );
  await rejectsWith(
    () => send([createApproveInstruction(rule, attacker.publicKey, attacker.publicKey, 1n)], [attacker]),
    /owner does not match|0x4/i,
    'a stranger delegating the rule account to themselves',
  );
  await rejectsWith(
    () => send([createSetAuthorityInstruction(rule, agent.publicKey, AuthorityType.AccountOwner, agent.publicKey)], [agent]),
    /owner does not match|0x4/i,
    'the agent taking the rule account authority',
  );
  await send([chargeIx(mandate, rule, agentAta, PER_TX, 1n)], [agent]);
  await send([chargeIx(mandate, rule, merchantAta, PER_TX + 1n, 2n)], [agent]);
  assert.equal((await getAccount(connection, rule)).amount, CAP, 'a charge to the wrong payee and one over the per-payment maximum moved nothing');
  assert.equal((await getAccount(connection, agentAta)).amount, 0n);
  assert.equal((await getAccount(connection, merchantAta)).amount, 0n);
  await send([chargeIx(mandate, rule, merchantAta, PER_TX, 3n)], [agent]);
  assert.equal((await getAccount(connection, merchantAta)).amount, PER_TX, 'a charge inside the mandate is paid');
});

live('sec r1: close_mandate on an active rule is refused for a stranger and for the owner, and the app close of an active rule revokes first', async () => {
  const { fetchMandate, closeMandate } = await chainModule;
  const { closeMandateInstruction, revokeMandateInstruction } = await instructionsModule;
  const rows = await connection.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters: [{ dataSize: 310 }] });
  const live = (await Promise.all(rows.map((r) => fetchMandate(client, r.pubkey)))).find((x) => x.status === STATUS_ACTIVE);
  assert.ok(live);
  const mandate = new PublicKey(live.address);
  const rule = new PublicKey(live.source);
  await rejectsWith(
    () => send([closeMandateInstruction({ programId: PROGRAM_ID, owner: attacker.publicKey, mandate })], [attacker]),
    /NotTheOwner|has one|0x1771/i,
    'a stranger closing the mandate',
  );
  await rejectsWith(
    () => send([revokeMandateInstruction({ programId: PROGRAM_ID, owner: attacker.publicKey, mandate, source: rule, tokenProgram: TOKEN_PROGRAM_ID })], [attacker]),
    /NotTheOwner|has one/i,
    'a stranger revoking the mandate',
  );
  await rejectsWith(
    () => send([closeMandateInstruction({ programId: PROGRAM_ID, owner: owner.publicKey, mandate })], [owner]),
    /MandateStillActive/i,
    'the owner closing without a revoke while active',
  );
  const before = (await getAccount(connection, ownerAta)).amount;
  const unspent = (await getAccount(connection, rule)).amount;
  assert.equal(unspent, CAP - PER_TX, 'one paid charge left the rule account');
  await closeMandate(client, signWith(owner), owner.publicKey, live);
  assert.equal(await connection.getAccountInfo(mandate, 'confirmed'), null, 'mandate closed');
  assert.equal(await connection.getAccountInfo(rule, 'confirmed'), null, 'rule account closed');
  assert.equal((await getAccount(connection, ownerAta)).amount, before + unspent, 'the unspent budget is back');
});

live('sec r1: closing a legacy rule the chain marked expired revokes first, so the associated token account keeps no delegation to a mandate that no longer exists (closed at 63d9bca)', async () => {
  const { fetchMandate, closeMandate } = await chainModule;
  const { openMandateInstruction, revokeMandateInstruction } = await instructionsModule;
  const expiresAt = BigInt((await chainNow()) + 4);
  const built = openMandateInstruction({
    programId: PROGRAM_ID,
    owner: owner.publicKey,
    agent: agent.publicKey,
    merchant: merchant.publicKey,
    mint,
    source: ownerAta,
    tokenProgram: TOKEN_PROGRAM_ID,
    mandateId: 4242n,
    cap: CAP,
    perTxMax: PER_TX,
    expiresAt,
    purpose: 'legacy',
  });
  await send([built.instruction], [owner]);
  await waitUntilChainTime(Number(expiresAt) + 1);
  await send([chargeIx(built.mandate, ownerAta, merchantAta, PER_TX, 1n)], [agent]);
  const expired = await fetchMandate(client, built.mandate);
  assert.equal(expired.status, STATUS_EXPIRED, 'a refused charge past expiry marks the mandate expired on chain');
  const beforeClose = await getAccount(connection, ownerAta);
  assert.ok(beforeClose.delegate?.equals(built.mandate));
  assert.equal(beforeClose.delegatedAmount, CAP);
  await closeMandate(client, signWith(owner), owner.publicKey, expired);
  assert.equal(await connection.getAccountInfo(built.mandate, 'confirmed'), null, 'mandate closed');
  await rejectsWith(
    () => send([revokeMandateInstruction({ programId: PROGRAM_ID, owner: owner.publicKey, mandate: built.mandate, source: ownerAta, tokenProgram: TOKEN_PROGRAM_ID })], [owner]),
    /AccountNotInitialized|0xbc4|0xbbf/i,
    'revoke after close has no mandate to act on',
  );
  const after = await getAccount(connection, ownerAta);
  assert.equal(
    after.delegate,
    null,
    `after close the associated token account still names ${after.delegate?.toBase58()} as delegate for ${after.delegatedAmount} base units`,
  );
});

live('sec r1: closing a dedicated rule the chain marked expired takes the delegation with the account', async () => {
  const { fetchMandate, closeMandate } = await chainModule;
  const expiresAt = BigInt((await chainNow()) + 4);
  const m = await openViaApp(expiresAt);
  const rule = new PublicKey(m.source);
  await waitUntilChainTime(Number(expiresAt) + 1);
  await send([chargeIx(new PublicKey(m.address), rule, merchantAta, PER_TX, 1n)], [agent]);
  const expired = await fetchMandate(client, new PublicKey(m.address));
  assert.equal(expired.status, STATUS_EXPIRED);
  const before = (await getAccount(connection, ownerAta)).amount;
  await closeMandate(client, signWith(owner), owner.publicKey, expired);
  assert.equal(await connection.getAccountInfo(rule, 'confirmed'), null, 'rule account closed, delegation gone with it');
  assert.equal((await getAccount(connection, ownerAta)).amount, before + CAP, 'the whole cap is back');
});
