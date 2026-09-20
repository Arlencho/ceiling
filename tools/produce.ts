import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createMintToInstruction,
  getMinimumBalanceForRentExemptAccount,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  IDL_PATH,
  TOOLS_DIR,
  addressesFile,
  connection,
  flagString,
  keysDir,
  ledgerPda,
  mandatePda,
  parseArgs,
  resolveClusterName,
  resolveProgramId,
  resolveRpc,
} from "./lib.js";

function usage(): never {
  console.error(`open a mandate and submit one paying charge and one refused charge

Usage:
  npx tsx produce.ts [--rpc url] [--keys-dir dir]

Needs gitignored keypairs under keys/ (owner, agent, deployer, plus
devnet-addresses.env). Creates a dedicated source token account so the
watcher's SPL delegate on the demo owner ATA is left alone.
`);
  process.exit(2);
}

function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) {
    throw new Error(`missing keypair ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function needAddr(map: Map<string, string>, key: string): string {
  const v = map.get(key);
  if (!v) throw new Error(`keys/devnet-addresses.env is missing ${key}`);
  return v;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.flags.help || cli.flags.h) usage();

  const rpc = resolveRpc(cli);
  const programId = resolveProgramId();
  const cluster = resolveClusterName();
  const dir = flagString(cli, "keys-dir") ?? keysDir();
  const addrs = addressesFile();

  const owner = loadKeypair(join(dir, "owner.json"));
  const agent = loadKeypair(join(dir, "agent.json"));
  const deployer = loadKeypair(join(dir, "deployer.json"));
  const mint = new PublicKey(needAddr(addrs, "MINT"));
  const merchant = new PublicKey(needAddr(addrs, "MERCHANT"));
  const merchantToken = new PublicKey(needAddr(addrs, "MERCHANT_TOKEN_ACCOUNT"));

  if (owner.publicKey.equals(agent.publicKey)) {
    throw new Error("owner and agent keypairs must differ");
  }

  const conn = connection(rpc);
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as Idl;
  const provider = new AnchorProvider(conn, new Wallet(owner), {
    commitment: "confirmed",
    skipPreflight: false,
  });
  const program = new Program(idl, provider);

  const cap = 500_000_000n;
  const perTxMax = 60_000_000n;
  const paidAmount = 50_000_000n;
  const refusedAmount = 180_000_000n;
  const mintAmount = 1_000_000_000n;
  const purpose = "charging";
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = BigInt(now + 30 * 24 * 60 * 60);
  const mandateId = BigInt(Date.now());

  const source = Keypair.generate();
  const rent = await getMinimumBalanceForRentExemptAccount(conn);
  const createSource = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: owner.publicKey,
      newAccountPubkey: source.publicKey,
      lamports: rent,
      space: ACCOUNT_SIZE,
      programId: SPL_TOKEN_PROGRAM_ID,
    }),
    createInitializeAccount3Instruction(source.publicKey, mint, owner.publicKey, SPL_TOKEN_PROGRAM_ID),
  );
  const createSig = await sendAndConfirmTransaction(conn, createSource, [owner, source], {
    commitment: "confirmed",
  });
  console.error(`source token account ${source.publicKey.toBase58()} tx=${createSig}`);

  const mintTx = new Transaction().add(
    createMintToInstruction(mint, source.publicKey, deployer.publicKey, mintAmount, [], SPL_TOKEN_PROGRAM_ID),
  );
  const mintSig = await sendAndConfirmTransaction(conn, mintTx, [deployer], { commitment: "confirmed" });
  console.error(`minted ${mintAmount.toString()} base units tx=${mintSig}`);

  const mandate = mandatePda(programId, owner.publicKey, mandateId);
  const ledger = ledgerPda(programId, mandate);

  const openIx = await program.methods
    .openMandate({
      mandateId: new BN(mandateId.toString()),
      agent: agent.publicKey,
      merchant,
      cap: new BN(cap.toString()),
      perTxMax: new BN(perTxMax.toString()),
      expiresAt: new BN(expiresAt.toString()),
      purpose,
    })
    .accountsPartial({
      owner: owner.publicKey,
      mandate,
      ledger,
      source: source.publicKey,
      mint,
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const openSig = await sendAndConfirmTransaction(conn, new Transaction().add(openIx), [owner], {
    commitment: "confirmed",
  });
  console.error(`opened mandate ${mandate.toBase58()} tx=${openSig}`);

  const charge = async (amount: bigint, nonce: bigint): Promise<string> => {
    const ix = await program.methods
      .charge(new BN(amount.toString()), new BN(nonce.toString()))
      .accountsPartial({
        agent: agent.publicKey,
        mandate,
        ledger,
        source: source.publicKey,
        destination: merchantToken,
        mint,
        tokenProgram: SPL_TOKEN_PROGRAM_ID,
      })
      .instruction();
    return sendAndConfirmTransaction(conn, new Transaction().add(ix), [agent], {
      commitment: "confirmed",
    });
  };

  const paidSig = await charge(paidAmount, 1n);
  console.error(`paid amount=${paidAmount.toString()} nonce=1 tx=${paidSig}`);
  const refusedSig = await charge(refusedAmount, 2n);
  console.error(`refused amount=${refusedAmount.toString()} nonce=2 tx=${refusedSig}`);

  const summary = {
    cluster,
    rpc,
    program_id: programId.toBase58(),
    mandate: mandate.toBase58(),
    ledger: ledger.toBase58(),
    source: source.publicKey.toBase58(),
    mandate_id: mandateId.toString(),
    cap: cap.toString(),
    per_tx_max: perTxMax.toString(),
    expires_at: expiresAt.toString(),
    purpose,
    paid: { amount: paidAmount.toString(), nonce: "1", signature: paidSig },
    refused: { amount: refusedAmount.toString(), nonce: "2", signature: refusedSig },
  };
  const outDir = join(TOOLS_DIR, ".local");
  mkdirSync(outDir, { recursive: true });
  const summaryPath = join(outDir, "produce.json");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.error(`wrote ${summaryPath}`);

  process.stdout.write(
    [
      `cluster     ${cluster}`,
      `rpc         ${rpc}`,
      `mandate     ${mandate.toBase58()}`,
      `paid        ${paidSig}`,
      `refused     ${refusedSig}`,
      "",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`produce failed: ${message}`);
  process.exit(1);
});
