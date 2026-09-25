import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import { tradeLedgerPda, tradeRulePda } from './tradeRule';
import { encodeSwapPool, parseSwapPool, poolSides } from './tradePool';
import { buildOpenTradeInstructions } from './tradeTx';
import { SPL_TOKEN_SWAP_PROGRAM_ID } from './pools';

const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

function bumpFor(pool: PublicKey): number {
  for (let nonce = 255; nonce >= 0; nonce -= 1) {
    try {
      PublicKey.createProgramAddressSync([pool.toBuffer(), Buffer.from([nonce])], SPL_TOKEN_SWAP_PROGRAM_ID);
      return nonce;
    } catch {
      continue;
    }
  }
  throw new Error('no bump');
}

function signersOf(instructions: { keys: { pubkey: PublicKey; isSigner: boolean }[] }[]): string[] {
  const set = new Set<string>();
  for (const ix of instructions) {
    for (const key of ix.keys) {
      if (key.isSigner) {
        set.add(key.pubkey.toBase58());
      }
    }
  }
  return [...set];
}

test('opening wrapped SOL uses the pool state, syncs native SOL, and pins the owner output account', async () => {
  const owner = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const programId = Keypair.generate().publicKey;
  const poolKey = Keypair.generate().publicKey;
  const vaultA = Keypair.generate().publicKey;
  const vaultB = Keypair.generate().publicKey;
  const poolMint = Keypair.generate().publicKey;
  const fee = Keypair.generate().publicKey;
  const nonce = bumpFor(poolKey);
  const raw = encodeSwapPool({
    nonce,
    vaultA,
    vaultB,
    poolMint,
    mintA: NATIVE_MINT,
    mintB: USDC,
    feeAccount: fee,
  });
  const sides = poolSides(parseSwapPool(poolKey, raw), NATIVE_MINT);
  const ruleId = 7n;
  const rule = tradeRulePda(programId, owner, ruleId);
  const ledger = tradeLedgerPda(programId, rule);
  const cap = 2_000_000n;
  const rent = 2_039_280;
  const built = await buildOpenTradeInstructions({
    programId,
    owner,
    agent,
    rule,
    ledger,
    ruleId,
    poolAccount: poolKey,
    pool: sides,
    cap,
    perTradeMax: 1_000_000n,
    dailyLimit: 2_000_000n,
    floorNum: 9n,
    floorDen: 5n,
    expiresAt: 2_000_000_000n,
    purpose: 'trading bot',
    tokenRent: rent,
    destinationExists: false,
    decimals: 9,
  });
  const openIx = built.instructions[built.instructions.length - 1];
  assert.ok(openIx);
  assert.equal(openIx.keys[8]?.pubkey.toBase58(), poolKey.toBase58());
  assert.equal(openIx.keys[9]?.pubkey.toBase58(), sides.authority.toBase58());
  assert.equal(openIx.keys[10]?.pubkey.toBase58(), sides.inputVault.toBase58());
  assert.equal(openIx.keys[11]?.pubkey.toBase58(), sides.outputVault.toBase58());
  assert.equal(openIx.keys[12]?.pubkey.toBase58(), sides.poolMint.toBase58());
  assert.equal(openIx.keys[13]?.pubkey.toBase58(), sides.feeAccount.toBase58());
  assert.equal(openIx.keys[13]?.pubkey.toBase58(), fee.toBase58());
  const destination = getAssociatedTokenAddressSync(USDC, owner, false, TOKEN_PROGRAM_ID);
  assert.ok(built.destination.equals(destination));
  assert.ok(openIx.keys[4]?.pubkey.equals(destination));
  const sync = createSyncNativeInstruction(built.source, TOKEN_PROGRAM_ID);
  assert.ok(
    built.instructions.some(
      (ix) =>
        ix.programId.equals(sync.programId) &&
        Buffer.from(ix.data).equals(Buffer.from(sync.data)) &&
        ix.keys[0]?.pubkey.equals(built.source),
    ),
  );
  const expectedCreate = SystemProgram.createAccountWithSeed({
    fromPubkey: owner,
    basePubkey: owner,
    seed: 'veto-trade-7',
    newAccountPubkey: built.source,
    lamports: rent + Number(cap),
    space: 165,
    programId: TOKEN_PROGRAM_ID,
  });
  assert.deepEqual(Buffer.from(built.instructions[0]!.data), Buffer.from(expectedCreate.data));
  assert.deepEqual(signersOf(built.instructions), [owner.toBase58()]);
});

test('opening another mint moves the cap from the owner account and does not sync native SOL', async () => {
  const owner = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const programId = Keypair.generate().publicKey;
  const poolKey = Keypair.generate().publicKey;
  const inputMint = Keypair.generate().publicKey;
  const vaultA = Keypair.generate().publicKey;
  const vaultB = Keypair.generate().publicKey;
  const poolMint = Keypair.generate().publicKey;
  const fee = Keypair.generate().publicKey;
  const nonce = bumpFor(poolKey);
  const raw = encodeSwapPool({
    nonce,
    vaultA,
    vaultB,
    poolMint,
    mintA: inputMint,
    mintB: USDC,
    feeAccount: fee,
  });
  const sides = poolSides(parseSwapPool(poolKey, raw), inputMint);
  const ruleId = 8n;
  const rule = tradeRulePda(programId, owner, ruleId);
  const ledger = tradeLedgerPda(programId, rule);
  const ownerAta = getAssociatedTokenAddressSync(inputMint, owner, false, TOKEN_PROGRAM_ID);
  const built = await buildOpenTradeInstructions({
    programId,
    owner,
    agent,
    rule,
    ledger,
    ruleId,
    poolAccount: poolKey,
    pool: sides,
    cap: 20n,
    perTradeMax: 5n,
    dailyLimit: 10n,
    floorNum: 1n,
    floorDen: 1n,
    expiresAt: 2_000_000_000n,
    purpose: 'trading bot',
    tokenRent: 100,
    destinationExists: true,
    decimals: 6,
    ownerInputAta: ownerAta,
  });
  const sync = createSyncNativeInstruction(built.source, TOKEN_PROGRAM_ID);
  assert.equal(
    built.instructions.some((ix) => Buffer.from(ix.data).equals(Buffer.from(sync.data))),
    false,
  );
  const transfer = createTransferCheckedInstruction(
    ownerAta,
    inputMint,
    built.source,
    owner,
    20n,
    6,
    [],
    TOKEN_PROGRAM_ID,
  );
  assert.ok(
    built.instructions.some(
      (ix) =>
        ix.programId.equals(transfer.programId) && Buffer.from(ix.data).equals(Buffer.from(transfer.data)),
    ),
  );
  const destination = getAssociatedTokenAddressSync(USDC, owner, false, TOKEN_PROGRAM_ID);
  assert.ok(built.destination.equals(destination));
  const openIx = built.instructions[built.instructions.length - 1];
  assert.equal(openIx?.keys[13]?.pubkey.toBase58(), fee.toBase58());
});
