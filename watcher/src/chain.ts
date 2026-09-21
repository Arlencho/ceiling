import { readFileSync } from "node:fs";
import anchorPkg, { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
// BN is not exposed as a named export on the CommonJS build of anchor, so a
// named import of it is a SyntaxError on Node 22, which is the floor the
// READMEs document and the version CI runs. Node 26 accepts it, which is why
// this survived: every seat and every local run was on 26. Take BN off the
// default export, where it is present on both.
const { BN } = anchorPkg;
import type { Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { WatcherConfig } from "./config.js";
import type { Veto } from "./idl.js";
import { parseChargeLogs, type ChargeOutcome } from "./parse.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function u64Le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function mandatePda(programId: PublicKey, owner: PublicKey, mandateId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), owner.toBuffer(), u64Le(mandateId)],
    programId,
  );
  return pda;
}

export function ledgerPda(programId: PublicKey, mandate: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ledger"), mandate.toBuffer()],
    programId,
  );
  return pda;
}

export function loadIdl(path: string): Veto {
  return JSON.parse(readFileSync(path, "utf8")) as Veto;
}

export function connect(cfg: WatcherConfig, payer: Keypair): {
  connection: Connection;
  program: Program<Veto>;
  programId: PublicKey;
} {
  const connection = new Connection(cfg.rpc, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: false,
  });
  const idl = loadIdl(cfg.idlPath) as unknown as Idl;
  if (idl.address && idl.address !== cfg.programId) {
    idl.address = cfg.programId;
  }
  const program = new Program<Veto>(idl as unknown as Veto & Idl, provider);
  return { connection, program, programId: new PublicKey(cfg.programId) };
}

export type ChargeReceipt = ChargeOutcome & { signature: string };

export async function submitCharge(args: {
  cfg: WatcherConfig;
  agent: Keypair;
  amount: bigint;
  nonce: bigint;
}): Promise<ChargeReceipt> {
  const { connection, program, programId } = connect(args.cfg, args.agent);
  const owner = new PublicKey(args.cfg.owner);
  const mandate = mandatePda(programId, owner, args.cfg.mandateId);
  const ledger = ledgerPda(programId, mandate);

  const ix = await program.methods
    .charge(new BN(args.amount.toString()), new BN(args.nonce.toString()))
    .accountsPartial({
      agent: args.agent.publicKey,
      mandate,
      ledger,
      source: new PublicKey(args.cfg.ownerTokenAccount),
      destination: new PublicKey(args.cfg.merchantTokenAccount),
      mint: new PublicKey(args.cfg.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [args.agent], {
    commitment: "confirmed",
  });
  const parsed = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = parsed?.meta?.logMessages ?? [];
  const outcome = parseChargeLogs(logs);
  return { ...outcome, signature };
}

export async function openMandate(args: {
  cfg: WatcherConfig;
  owner: Keypair;
  expiresAtUnix: bigint;
}): Promise<{ signature: string; mandate: string; ledger: string }> {
  const { connection, program, programId } = connect(args.cfg, args.owner);
  const ownerPk = args.owner.publicKey;
  const mandate = mandatePda(programId, ownerPk, args.cfg.mandateId);
  const ledger = ledgerPda(programId, mandate);

  const existing = await connection.getAccountInfo(mandate, "confirmed");
  if (existing !== null) {
    return { signature: "", mandate: mandate.toBase58(), ledger: ledger.toBase58() };
  }

  const ix = await program.methods
    .openMandate({
      mandateId: new BN(args.cfg.mandateId.toString()),
      agent: new PublicKey(args.cfg.agent),
      merchant: new PublicKey(args.cfg.merchant),
      cap: new BN(args.cfg.cap.toString()),
      perTxMax: new BN(args.cfg.perTxMax.toString()),
      expiresAt: new BN(args.expiresAtUnix.toString()),
      purpose: args.cfg.purpose,
    })
    .accountsPartial({
      owner: ownerPk,
      mandate,
      ledger,
      source: new PublicKey(args.cfg.ownerTokenAccount),
      mint: new PublicKey(args.cfg.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [args.owner], {
    commitment: "confirmed",
  });
  return { signature, mandate: mandate.toBase58(), ledger: ledger.toBase58() };
}
