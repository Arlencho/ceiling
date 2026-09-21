#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import anchorPkg, { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
// BN is not exposed as a named export on the CommonJS build of anchor, so a
// named import of it is a SyntaxError on Node 22, which is the floor the
// READMEs document and the version CI runs. Node 26 accepts it, which is why
// this survived: every seat and every local run was on 26. Take BN off the
// default export, where it is present on both.
const { BN } = anchorPkg;
import type { Idl } from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { required } from "./config.js";
import { TOKEN_PROGRAM_ID } from "./constants.js";
import { createFailoverConnection, parseRpcList } from "./rpc.js";
import { ledgerPda, mandatePda } from "./ring.js";

type Addresses = {
  rpc: string;
  rpcs: string[];
  programId: string;
  mint: string;
  owner: string;
  ownerTokenAccount: string;
  merchant: string;
  merchantTokenAccount: string;
  agent: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEXER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadAddresses(keysDir: string, rpcOverride?: string): Addresses {
  const envPath = resolve(keysDir, "devnet-addresses.env");
  const map = new Map<string, string>();
  if (existsSync(envPath)) {
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }
  const need = (key: string) => {
    const value = map.get(key);
    if (!value) throw new Error(`missing ${key} in ${envPath}`);
    return value;
  };
  const files = new Map<string, string>();
  for (const [k, v] of map) {
    files.set(k.startsWith("VETO_") ? k : k === "RPC" ? "VETO_RPC" : k === "PROGRAM_ID" ? "VETO_PROGRAM_ID" : k, v);
  }
  const env: NodeJS.ProcessEnv = rpcOverride
    ? { ...process.env, VETO_RPC: rpcOverride }
    : process.env;
  const rpcs = parseRpcList(required(env, files, "VETO_RPC"));
  if (rpcs.length === 0) throw new Error("no rpc endpoints configured");
  return {
    rpc: rpcs[0]!,
    rpcs,
    programId: required(env, files, "VETO_PROGRAM_ID"),
    mint: need("MINT"),
    owner: need("OWNER"),
    ownerTokenAccount: need("OWNER_TOKEN_ACCOUNT"),
    merchant: need("MERCHANT"),
    merchantTokenAccount: need("MERCHANT_TOKEN_ACCOUNT"),
    agent: need("AGENT"),
  };
}

function loadIdl(): Idl {
  const path = resolve(INDEXER_DIR, "idl", "veto.json");
  return JSON.parse(readFileSync(path, "utf8")) as Idl;
}

function programFor(connection: Connection, payer: Keypair, idl: Idl): Program {
  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: false,
  });
  return new Program(idl, provider);
}

async function main(): Promise<void> {
  const keysDir = resolve(process.env.VETO_KEYS_DIR ?? resolve(ROOT, "keys"));
  const addrs = loadAddresses(keysDir);
  const owner = loadKeypair(resolve(keysDir, "owner.json"));
  const agent = loadKeypair(resolve(keysDir, "agent.json"));
  if (owner.publicKey.toBase58() !== addrs.owner) {
    throw new Error("keys/owner.json does not match OWNER in addresses env");
  }
  if (agent.publicKey.toBase58() !== addrs.agent) {
    throw new Error("keys/agent.json does not match AGENT in addresses env");
  }

  const connection = createFailoverConnection(addrs.rpcs);
  const programId = new PublicKey(addrs.programId);
  const idl = loadIdl();
  if (idl.address && idl.address !== addrs.programId) {
    idl.address = addrs.programId;
  }

  const mandateId = BigInt(process.env.VETO_MANDATE_ID ?? Date.now());
  const mandate = mandatePda(programId, owner.publicKey, mandateId);
  const ledger = ledgerPda(programId, mandate);
  const existing = await connection.getAccountInfo(mandate, "confirmed");
  if (existing) {
    throw new Error(`mandate ${mandate.toBase58()} already exists; set VETO_MANDATE_ID to a fresh u64`);
  }

  const cap = 100_000_000n;
  const perTxMax = 1_000_000n;
  const paidAmount = 500_000n;
  const refusedAmount = 5_000_000n;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30);

  const ownerProgram = programFor(connection, owner, idl);
  const openIx = await ownerProgram.methods
    .openMandate({
      mandateId: new BN(mandateId.toString()),
      agent: agent.publicKey,
      merchant: new PublicKey(addrs.merchant),
      cap: new BN(cap.toString()),
      perTxMax: new BN(perTxMax.toString()),
      expiresAt: new BN(expiresAt.toString()),
      purpose: "indexer seed",
    })
    .accountsPartial({
      owner: owner.publicKey,
      mandate,
      ledger,
      source: new PublicKey(addrs.ownerTokenAccount),
      mint: new PublicKey(addrs.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const openSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(openIx),
    [owner],
    { commitment: "confirmed" },
  );

  const agentProgram = programFor(connection, agent, idl);
  const charge = async (amount: bigint, nonce: bigint) => {
    const ix = await agentProgram.methods
      .charge(new BN(amount.toString()), new BN(nonce.toString()))
      .accountsPartial({
        agent: agent.publicKey,
        mandate,
        ledger,
        source: new PublicKey(addrs.ownerTokenAccount),
        destination: new PublicKey(addrs.merchantTokenAccount),
        mint: new PublicKey(addrs.mint),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return sendAndConfirmTransaction(connection, new Transaction().add(ix), [agent], {
      commitment: "confirmed",
    });
  };

  const paidSig = await charge(paidAmount, 1n);
  const refusedSig = await charge(refusedAmount, 2n);
  // Extra refused charges so a small --page-size must walk more than one page.
  const extra: string[] = [];
  extra.push(await charge(refusedAmount, 3n));
  extra.push(await charge(refusedAmount, 4n));

  const report = {
    rpc: addrs.rpcs.join(","),
    program: addrs.programId,
    mandate_id: mandateId.toString(),
    mandate: mandate.toBase58(),
    ledger: ledger.toBase58(),
    open_signature: openSig,
    paid: { amount: paidAmount.toString(), nonce: "1", signature: paidSig },
    refused: { amount: refusedAmount.toString(), nonce: "2", signature: refusedSig },
    extra_refused_signatures: extra,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
