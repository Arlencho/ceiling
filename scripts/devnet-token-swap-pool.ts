#!/usr/bin/env -S node --experimental-strip-types
// Create one constant-product pool on devnet against the SPL token-swap
// program SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8, between wrapped SOL
// and Circle devnet USDC, then swap 0.001 SOL for USDC with an SPL delegate.
//
// Run from the repo root. The deployer key is keys/deployer.json, or
// $VETO_KEYS_DIR/deployer.json when VETO_KEYS_DIR is set:
//   node --experimental-strip-types scripts/devnet-token-swap-pool.ts
//
// VETO_RPC is used when set. The public devnet endpoint is used otherwise.
// The URL is never printed. A URL that mentions mainnet is refused.
//
// Initialize data is tag 0, the authority bump, the ENFORCED_FEES words,
// curve type 0, and 32 zero bytes. The swap instruction has 10 accounts
// and no host fee account.

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AIRDROP_MAX_TRIES,
  FEE_OWNER_ADDRESS,
  SWAP_IN_BASE,
  TOKEN_SWAP_PROGRAM_ADDRESS,
  USDC_DECIMALS,
  USDC_MINT_ADDRESS,
  USDC_SEED_BASE,
  WSOL_DECIMALS,
  WSOL_MINT_ADDRESS,
  WSOL_SEED_LAMPORTS,
  WSOL_SEED_SOL,
  SOL_PRICE_SOURCE,
  SOL_PRICE_USD,
  airdropLamports,
  airdropWaitMs,
  appendAbsentKeys,
  assertSeedCoversSwap,
  endpoint,
  initializeData,
  poolEnvUpdates,
  redact,
  swapAccounts,
  swapData,
  usdcShortfallMessage,
} from "./devnet-token-swap-pool-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(join(root, "tools/package.json"));
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = web3;

const {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createMint,
  getMint,
  createAccount,
  getAccount,
  approve,
  getAssociatedTokenAddressSync,
  createSyncNativeInstruction,
  createTransferInstruction,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} = spl;

const TOKEN_SWAP_PROGRAM_ID = new PublicKey(TOKEN_SWAP_PROGRAM_ADDRESS);
const WSOL_MINT = new PublicKey(WSOL_MINT_ADDRESS);
const USDC_MINT = new PublicKey(USDC_MINT_ADDRESS);
const FEE_OWNER = new PublicKey(FEE_OWNER_ADDRESS);
const SWAP_ACCOUNT_LEN = 324;
const TOKEN_ACCOUNT_LEN = 165;
const MINT_LEN = 82;
const POOL_DECIMALS = 6;
const FEE_BUFFER = 20_000_000;

function fail(message: string): never {
  throw new Error(redact(message));
}

function die(message: string): never {
  console.error(`error: ${redact(message)}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function asNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail(`${label} ${value} is not a safe integer`);
  return number;
}

function loadKeypair(path: string): InstanceType<typeof Keypair> {
  if (!existsSync(path)) fail(`missing keypair ${path}`);
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(secret);
}

async function logsOf(connection: InstanceType<typeof Connection>, err: unknown): Promise<string> {
  const lines: string[] = [];
  if (err instanceof Error) lines.push(err.message);
  const withLogs = err as { getLogs?: (c: unknown) => Promise<string[]> };
  if (typeof withLogs.getLogs === "function") {
    try {
      const fetched = await withLogs.getLogs(connection);
      if (fetched) lines.push(...fetched);
    } catch {
      // The signature may not have landed. The message above is enough.
    }
  }
  return redact(lines.join("\n"));
}

async function createTokenAccount(
  connection: InstanceType<typeof Connection>,
  payer: InstanceType<typeof Keypair>,
  mint: InstanceType<typeof PublicKey>,
  owner: InstanceType<typeof PublicKey>,
): Promise<InstanceType<typeof PublicKey>> {
  return createAccount(
    connection,
    payer,
    mint,
    owner,
    Keypair.generate(),
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
}

function missingTokenAccount(err: unknown): boolean {
  return err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError;
}

async function tokenAmount(
  connection: InstanceType<typeof Connection>,
  address: InstanceType<typeof PublicKey>,
): Promise<bigint> {
  try {
    const account = await getAccount(connection, address, "confirmed", TOKEN_PROGRAM_ID);
    return account.amount;
  } catch (err) {
    if (missingTokenAccount(err)) return 0n;
    throw err;
  }
}

async function requireMintDecimals(
  connection: InstanceType<typeof Connection>,
  mint: InstanceType<typeof PublicKey>,
  expected: number,
  label: string,
): Promise<void> {
  const state = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  if (state.decimals !== expected) {
    fail(`${label} decimals are ${state.decimals}, expected ${expected}`);
  }
}

async function ensureSol(
  connection: InstanceType<typeof Connection>,
  pubkey: InstanceType<typeof PublicKey>,
  minLamports: number,
): Promise<void> {
  for (let attempt = 1; attempt <= AIRDROP_MAX_TRIES; attempt += 1) {
    const balance = await connection.getBalance(pubkey, "confirmed");
    if (balance >= minLamports) {
      console.log(`deployer balance ${balance} lamports`);
      return;
    }
    const ask = airdropLamports(attempt);
    console.log(`airdrop ${ask} lamports (try ${attempt}/${AIRDROP_MAX_TRIES})`);
    try {
      const signature = await connection.requestAirdrop(pubkey, ask);
      const result = await connection.confirmTransaction(signature, "confirmed");
      if (result.value.err) {
        throw new Error(`airdrop failed ${JSON.stringify(result.value.err)}`);
      }
    } catch (err) {
      const detail = redact(err instanceof Error ? err.message : String(err));
      const wait = airdropWaitMs(attempt);
      console.log(`airdrop rate limited or failed, waiting ${wait}ms then retrying`);
      console.log(detail.split("\n")[0]);
      await sleep(wait);
    }
  }
  const balance = await connection.getBalance(pubkey, "confirmed");
  fail(`deployer has ${balance} lamports, need at least ${minLamports}`);
}

async function main() {
  assertSeedCoversSwap(WSOL_SEED_LAMPORTS, SWAP_IN_BASE);
  if (!WSOL_MINT.equals(NATIVE_MINT)) fail("wrapped SOL mint is not the native mint");

  const rpc = endpoint();
  console.log(`rpc host: ${new URL(rpc).host}`);
  const keysDir = process.env.VETO_KEYS_DIR
    ? resolve(process.env.VETO_KEYS_DIR)
    : join(root, "keys");
  if (!existsSync(keysDir)) fail(`missing keys directory ${keysDir}`);
  const deployer = loadKeypair(join(keysDir, "deployer.json"));
  const connection = new Connection(rpc, "confirmed");
  const deployerUsdc = getAssociatedTokenAddressSync(
    USDC_MINT,
    deployer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  const haveUsdc = await tokenAmount(connection, deployerUsdc);
  if (haveUsdc < USDC_SEED_BASE) {
    fail(usdcShortfallMessage(deployer.publicKey.toBase58(), haveUsdc));
  }

  await requireMintDecimals(connection, WSOL_MINT, WSOL_DECIMALS, "wrapped SOL");
  await requireMintDecimals(connection, USDC_MINT, USDC_DECIMALS, "USDC");

  const tokenRent = await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_LEN);
  const swapRent = await connection.getMinimumBalanceForRentExemption(SWAP_ACCOUNT_LEN);
  const needed = tokenRent * 5
    + mintRent
    + swapRent
    + asNumber(WSOL_SEED_LAMPORTS, "wSOL seed")
    + asNumber(SWAP_IN_BASE, "swap input")
    + FEE_BUFFER;
  await ensureSol(connection, deployer.publicKey, needed);

  const swap = Keypair.generate();
  const [authority, bump] = PublicKey.findProgramAddressSync(
    [swap.publicKey.toBuffer()],
    TOKEN_SWAP_PROGRAM_ID,
  );
  const wsolVault = await createTokenAccount(connection, deployer, WSOL_MINT, authority);
  const usdcVault = await createTokenAccount(connection, deployer, USDC_MINT, authority);
  const poolMint = await createMint(
    connection,
    deployer,
    authority,
    null,
    POOL_DECIMALS,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  const feeAccount = await createTokenAccount(connection, deployer, poolMint, FEE_OWNER);
  const lpDest = await createTokenAccount(connection, deployer, poolMint, deployer.publicKey);

  // Funding and initialize share one transaction. A rejected initialize then
  // leaves the USDC with the deployer instead of in a vault only the pool
  // authority can move.
  const initIx = new TransactionInstruction({
    programId: TOKEN_SWAP_PROGRAM_ID,
    keys: [
      { pubkey: swap.publicKey, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: wsolVault, isSigner: false, isWritable: false },
      { pubkey: usdcVault, isSigner: false, isWritable: false },
      { pubkey: poolMint, isSigner: false, isWritable: true },
      { pubkey: feeAccount, isSigner: false, isWritable: false },
      { pubkey: lpDest, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initializeData(bump),
  });
  const initTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: wsolVault,
      lamports: asNumber(WSOL_SEED_LAMPORTS, "wSOL seed"),
    }),
    createSyncNativeInstruction(wsolVault, TOKEN_PROGRAM_ID),
    createTransferInstruction(
      deployerUsdc,
      usdcVault,
      deployer.publicKey,
      USDC_SEED_BASE,
      [],
      TOKEN_PROGRAM_ID,
    ),
    SystemProgram.createAccount({
      fromPubkey: deployer.publicKey,
      newAccountPubkey: swap.publicKey,
      lamports: swapRent,
      space: SWAP_ACCOUNT_LEN,
      programId: TOKEN_SWAP_PROGRAM_ID,
    }),
    initIx,
  );

  let initSignature = "";
  try {
    initSignature = await sendAndConfirmTransaction(connection, initTx, [deployer, swap], {
      commitment: "confirmed",
    });
  } catch (err) {
    const detail = await logsOf(connection, err);
    fail(`initialize rejected\n${detail}`);
  }
  console.log(`pool: ${swap.publicKey.toBase58()}`);
  console.log(`initialize signature: ${initSignature}`);

  const wrapped = await getAccount(connection, wsolVault, "confirmed", TOKEN_PROGRAM_ID);
  if (wrapped.amount !== WSOL_SEED_LAMPORTS) {
    fail(`wSOL vault amount is ${wrapped.amount}, expected ${WSOL_SEED_LAMPORTS}`);
  }
  const seededUsdc = await getAccount(connection, usdcVault, "confirmed", TOKEN_PROGRAM_ID);
  if (seededUsdc.amount !== USDC_SEED_BASE) {
    fail(`USDC vault amount is ${seededUsdc.amount}, expected ${USDC_SEED_BASE}`);
  }

  const sourceOwner = Keypair.generate();
  const delegate = Keypair.generate();
  if (sourceOwner.publicKey.equals(delegate.publicKey)) {
    fail("delegate must not be the source owner");
  }
  const userSource = await createTokenAccount(connection, deployer, WSOL_MINT, sourceOwner.publicKey);
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: userSource,
      lamports: asNumber(SWAP_IN_BASE, "swap input"),
    }),
    createSyncNativeInstruction(userSource, TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, wrapTx, [deployer], { commitment: "confirmed" });
  await approve(
    connection,
    deployer,
    userSource,
    delegate.publicKey,
    sourceOwner,
    SWAP_IN_BASE,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );

  const sourceBefore = await tokenAmount(connection, userSource);
  const destBefore = await tokenAmount(connection, deployerUsdc);
  const roles = swapAccounts();
  const byRole: Record<string, InstanceType<typeof PublicKey>> = {
    swap: swap.publicKey,
    authority,
    delegate: delegate.publicKey,
    userSource,
    vaultIn: wsolVault,
    vaultOut: usdcVault,
    userDestination: deployerUsdc,
    poolMint,
    feeAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const swapKeys = roles.map((role) => {
    const pubkey = byRole[role.role];
    if (!pubkey) fail(`swap account ${role.role} is missing`);
    return { pubkey, isSigner: role.signer, isWritable: role.writable };
  });
  if (swapKeys.length !== 10) fail(`swap account count ${swapKeys.length}, expected 10`);
  const instructionSigners = swapKeys.filter((meta) => meta.isSigner);
  if (instructionSigners.length !== 1 || !instructionSigners[0].pubkey.equals(delegate.publicKey)) {
    fail("swap must be signed by the delegate");
  }
  if (instructionSigners[0].pubkey.equals(sourceOwner.publicKey)) {
    fail("swap signer is the source owner");
  }
  const swapIx = new TransactionInstruction({
    programId: TOKEN_SWAP_PROGRAM_ID,
    keys: swapKeys,
    data: swapData(SWAP_IN_BASE, 1n),
  });

  let swapSignature = "";
  try {
    swapSignature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(swapIx),
      [deployer, delegate],
      { commitment: "confirmed" },
    );
  } catch (err) {
    const detail = await logsOf(connection, err);
    fail(
      [
        `pool was created at ${swap.publicKey.toBase58()} but the 10-account swap was rejected`,
        `initialize signature: ${initSignature}`,
        "no swap signature",
        detail,
      ].join("\n"),
    );
  }

  const sourceAfter = await tokenAmount(connection, userSource);
  const destAfter = await tokenAmount(connection, deployerUsdc);
  if (sourceAfter >= sourceBefore) {
    fail(`source balance did not fall (${sourceBefore} -> ${sourceAfter})`);
  }
  if (destAfter <= destBefore) {
    fail(`destination balance did not rise (${destBefore} -> ${destAfter})`);
  }

  const envPath = join(keysDir, "devnet-addresses.env");
  const updates = poolEnvUpdates({
    pool: swap.publicKey.toBase58(),
    authority: authority.toBase58(),
    wsolVault: wsolVault.toBase58(),
    usdcVault: usdcVault.toBase58(),
    poolMint: poolMint.toBase58(),
    feeAccount: feeAccount.toBase58(),
  });
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(envPath, appendAbsentKeys(existing, updates), { mode: 0o600 });

  console.log(`pool: ${swap.publicKey.toBase58()}`);
  console.log(`authority: ${authority.toBase58()}`);
  console.log(`wsol vault: ${wsolVault.toBase58()}`);
  console.log(`usdc vault: ${usdcVault.toBase58()}`);
  console.log(`pool mint: ${poolMint.toBase58()}`);
  console.log(`fee account: ${feeAccount.toBase58()}`);
  console.log(`swap signature: ${swapSignature}`);
  console.log(`source ${sourceBefore} -> ${sourceAfter}`);
  console.log(`destination ${destBefore} -> ${destAfter}`);
  console.log(`sol seed: ${WSOL_SEED_SOL} SOL at ${SOL_PRICE_USD} USD (${SOL_PRICE_SOURCE})`);
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  main().catch((err) => {
    die(err instanceof Error ? err.message : String(err));
  });
}
