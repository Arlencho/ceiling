#!/usr/bin/env -S node --experimental-strip-types
// Create one constant-product pool on devnet against the SPL token-swap
// program SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8, between the demo mint
// and a new classic mint, then swap once with an SPL delegate.
//
// Run from the repo root, with keys/deployer.json (demo mint authority) and
// keys/owner.json present, same layout as scripts/devnet-setup.sh:
//   node --experimental-strip-types scripts/devnet-token-swap-pool.ts
//
// VETO_RPC is used when set. The public devnet endpoint is used otherwise.
// The URL is never printed. A URL that mentions mainnet is refused.
//
// This program's initialize data is tag, bump, eight fee u64s, curve type,
// 32 parameter bytes. The requested schedule is trade 25/10000, owner 0,
// host 0. The deployed program rejects that schedule. On rejection the
// script exits non-zero and does not write a pool address.

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const { TOKEN_PROGRAM_ID, createMint, getMint, createAccount, mintTo, approve } = spl;

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

const TOKEN_SWAP_PROGRAM_ID = new PublicKey("SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8");
const DEMO_MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const FEE_OWNER = new PublicKey("HfoTxFR1Tm6kGmWgYWD6J7YHVy1UwqSULUGVLXkJqaKN");
const SWAP_ACCOUNT_LEN = 324;
const DECIMALS = 6;
const ONE = 1_000_000n;
const LIQUIDITY = 1_000_000n * ONE;
const AMOUNT_IN = 10n * ONE;
const PUBLIC_DEVNET = "https://api.devnet.solana.com";

function die(message: string): never {
  console.error(`error: ${redact(message)}`);
  process.exit(1);
}

function redact(text: string): string {
  return text.replace(/https?:\/\/[^\s'")]+/g, "[rpc]");
}

function endpoint(): string {
  const chosen = process.env.VETO_RPC && process.env.VETO_RPC.length > 0
    ? process.env.VETO_RPC
    : PUBLIC_DEVNET;
  let parsed: URL;
  try {
    parsed = new URL(chosen);
  } catch {
    die("VETO_RPC is not a URL");
  }
  if (/mainnet/i.test(parsed.hostname) || /mainnet/i.test(parsed.pathname)) {
    die("refusing to run against mainnet");
  }
  return chosen;
}

function loadKeypair(path: string): InstanceType<typeof Keypair> {
  if (!existsSync(path)) {
    die(`missing keypair ${path}`);
  }
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(secret);
}

function pushU64(bytes: number[], value: bigint) {
  const word = Buffer.alloc(8);
  word.writeBigUInt64LE(value);
  for (const b of word) bytes.push(b);
}

function initializeData(nonce: number): Buffer {
  const bytes: number[] = [0, nonce];
  for (const word of [25n, 10_000n, 0n, 0n, 0n, 0n, 0n, 0n]) {
    pushU64(bytes, word);
  }
  bytes.push(0);
  for (let i = 0; i < 32; i += 1) bytes.push(0);
  if (bytes.length !== 99) {
    die(`initialize data length ${bytes.length}, expected 99`);
  }
  return Buffer.from(bytes);
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

async function main() {
  const rpc = endpoint();
  const host = new URL(rpc).host;
  console.log(`rpc host: ${host}`);

  const keysDir = process.env.VETO_KEYS_DIR
    ? resolve(process.env.VETO_KEYS_DIR)
    : join(root, "keys");
  if (!existsSync(keysDir)) {
    die(`missing keys directory ${keysDir}`);
  }
  const deployer = loadKeypair(join(keysDir, "deployer.json"));
  const owner = loadKeypair(join(keysDir, "owner.json"));
  const connection = new Connection(rpc, "confirmed");

  const demo = await getMint(connection, DEMO_MINT, "confirmed", TOKEN_PROGRAM_ID);
  if (demo.decimals !== DECIMALS) {
    die(`demo mint decimals are ${demo.decimals}, expected ${DECIMALS}`);
  }
  if (!demo.mintAuthority || !demo.mintAuthority.equals(deployer.publicKey)) {
    die("deployer.json is not the demo mint authority");
  }

  const balance = await connection.getBalance(deployer.publicKey, "confirmed");
  if (balance < 500_000_000) {
    die(`deployer has ${balance} lamports, need at least 500000000`);
  }

  const mintB = await createMint(
    connection,
    deployer,
    deployer.publicKey,
    null,
    DECIMALS,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  mkdirSync(keysDir, { recursive: true });
  console.log(`second mint (6 decimals): ${mintB.toBase58()}`);

  const swap = Keypair.generate();
  const [authority, bump] = PublicKey.findProgramAddressSync(
    [swap.publicKey.toBuffer()],
    TOKEN_SWAP_PROGRAM_ID,
  );
  const vaultA = await createTokenAccount(connection, deployer, DEMO_MINT, authority);
  const vaultB = await createTokenAccount(connection, deployer, mintB, authority);
  const poolMint = await createMint(
    connection,
    deployer,
    authority,
    null,
    DECIMALS,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  const feeAccount = await createTokenAccount(connection, deployer, poolMint, FEE_OWNER);
  const lpDest = await createTokenAccount(connection, deployer, poolMint, deployer.publicKey);
  await mintTo(
    connection,
    deployer,
    DEMO_MINT,
    vaultA,
    deployer,
    LIQUIDITY,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  await mintTo(
    connection,
    deployer,
    mintB,
    vaultB,
    deployer,
    LIQUIDITY,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );

  const rent = await connection.getMinimumBalanceForRentExemption(SWAP_ACCOUNT_LEN);
  const initIx = new TransactionInstruction({
    programId: TOKEN_SWAP_PROGRAM_ID,
    keys: [
      { pubkey: swap.publicKey, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: vaultA, isSigner: false, isWritable: false },
      { pubkey: vaultB, isSigner: false, isWritable: false },
      { pubkey: poolMint, isSigner: false, isWritable: true },
      { pubkey: feeAccount, isSigner: false, isWritable: false },
      { pubkey: lpDest, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initializeData(bump),
  });
  const initTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: deployer.publicKey,
      newAccountPubkey: swap.publicKey,
      lamports: rent,
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
    die(
      [
        "initialize rejected for fees trade 25/10000, owner 0, host 0",
        `second mint (6 decimals): ${mintB.toBase58()}`,
        "no pool was created, so there is no pool address and no swap signature",
        detail,
      ].join("\n"),
    );
  }

  console.log(`pool: ${swap.publicKey.toBase58()}`);
  console.log(`initialize signature: ${initSignature}`);

  const delegate = Keypair.generate();
  const userSource = await createTokenAccount(connection, deployer, DEMO_MINT, owner.publicKey);
  const userDest = await createTokenAccount(connection, deployer, mintB, owner.publicKey);
  await mintTo(
    connection,
    deployer,
    DEMO_MINT,
    userSource,
    deployer,
    AMOUNT_IN,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  await approve(
    connection,
    deployer,
    userSource,
    delegate.publicKey,
    owner,
    AMOUNT_IN,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );

  const swapData = Buffer.alloc(17);
  swapData.writeUInt8(1, 0);
  swapData.writeBigUInt64LE(AMOUNT_IN, 1);
  swapData.writeBigUInt64LE(1n, 9);
  const swapIx = new TransactionInstruction({
    programId: TOKEN_SWAP_PROGRAM_ID,
    keys: [
      { pubkey: swap.publicKey, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: delegate.publicKey, isSigner: true, isWritable: false },
      { pubkey: userSource, isSigner: false, isWritable: true },
      { pubkey: vaultA, isSigner: false, isWritable: true },
      { pubkey: vaultB, isSigner: false, isWritable: true },
      { pubkey: userDest, isSigner: false, isWritable: true },
      { pubkey: poolMint, isSigner: false, isWritable: true },
      { pubkey: feeAccount, isSigner: false, isWritable: true },
      { pubkey: DEMO_MINT, isSigner: false, isWritable: false },
      { pubkey: mintB, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: swapData,
  });
  if (swapIx.keys.length !== 14) {
    die(`swap account count ${swapIx.keys.length}, expected 14`);
  }

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
    die(
      [
        `pool was created at ${swap.publicKey.toBase58()} but the 14-account swap was rejected`,
        `initialize signature: ${initSignature}`,
        "no swap signature",
        detail,
      ].join("\n"),
    );
  }

  const envPath = join(keysDir, "devnet-addresses.env");
  const updates: Record<string, string> = {
    TOKEN_SWAP_PROGRAM: TOKEN_SWAP_PROGRAM_ID.toBase58(),
    TOKEN_SWAP_POOL: swap.publicKey.toBase58(),
    TOKEN_SWAP_AUTHORITY: authority.toBase58(),
    TOKEN_SWAP_MINT_A: DEMO_MINT.toBase58(),
    TOKEN_SWAP_MINT_B: mintB.toBase58(),
    TOKEN_SWAP_VAULT_A: vaultA.toBase58(),
    TOKEN_SWAP_VAULT_B: vaultB.toBase58(),
    TOKEN_SWAP_POOL_MINT: poolMint.toBase58(),
    TOKEN_SWAP_FEE_ACCOUNT: feeAccount.toBase58(),
    TOKEN_SWAP_SIGNATURE: swapSignature,
  };
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, line);
    else {
      if (text.length > 0 && !text.endsWith("\n")) text += "\n";
      text += `${line}\n`;
    }
  }
  writeFileSync(envPath, text, { mode: 0o600 });
  console.log(`pool: ${swap.publicKey.toBase58()}`);
  console.log(`swap signature: ${swapSignature}`);
}

main().catch((err) => {
  die(err instanceof Error ? err.stack ?? err.message : String(err));
});
