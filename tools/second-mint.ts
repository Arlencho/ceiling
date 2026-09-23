import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import anchorPkg, { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  IDL_PATH,
  connection,
  fetchLedger,
  fetchMandate,
  flagString,
  keysDir,
  kindName,
  ledgerPda,
  mandatePda,
  parseArgs,
  reasonText,
  redactRpcUrl,
  resolveProgramId,
  resolveRpcList,
  type Cli,
} from "./lib.js";

const { BN } = anchorPkg;

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Solana Mobile's SKR mint. Published for mainnet. Not a name for any other mint. */
export const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";

export const PROTECTED_FIRST_MINT = "2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU";
export const PROTECTED_FIRST_SOURCE = "FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE";
export const PROTECTED_FIRST_DELEGATE = "GVwLhzvRNqa5PnKcLakdocC3czQfYrBXGpbHb7HLPEjG";

export const SECOND_PURPOSE = "second devnet asset";
export const SECOND_DECIMALS = 6;
const CAP = 500_000_000n;
const PER_TX_MAX = 50_000_000n;
const PAID_AMOUNT = 10_000_000n;
const REFUSED_AMOUNT = 80_000_000n;
const MINT_AMOUNT = 1_000_000_000n;
const AGENT_LAMPORTS = 50_000_000n;

export type SecondMintGuardInput = {
  rpcUrls: readonly string[];
  genesis: string;
  firstMint: string;
  secondMint: string;
  firstSource: string;
  secondSource: string;
  skrMint: string;
};

export function assertSecondMintAllowed(input: SecondMintGuardInput): void {
  for (const rpc of input.rpcUrls) {
    if (rpc.toLowerCase().includes("mainnet")) {
      throw new Error(`second-mint: refusing mainnet rpc ${redactRpcUrl(rpc)}`);
    }
  }
  if (input.genesis !== DEVNET_GENESIS) {
    throw new Error(`second-mint: genesis ${input.genesis} is not devnet`);
  }
  if (input.secondMint === input.firstMint) {
    throw new Error("second-mint: the second mint must be a different mint from the first");
  }
  if (input.secondMint === input.skrMint) {
    throw new Error("second-mint: the mainnet SKR mint is not present as a devnet mint to use");
  }
  if (input.secondSource === input.firstSource) {
    throw new Error("second-mint: refusing to approve a delegate on the first mandate source");
  }
}

export type TokenDelegate = {
  delegate: string | null;
  delegatedAmount: bigint;
  amount: bigint;
};

export function readTokenDelegate(data: Buffer): TokenDelegate {
  if (data.length < 165) {
    throw new Error("second-mint: token account is shorter than the classic layout");
  }
  const amount = data.readBigUInt64LE(64);
  const option = data.readUInt32LE(72);
  const delegate = option === 0 ? null : new PublicKey(data.subarray(76, 108)).toBase58();
  const delegatedAmount = data.readBigUInt64LE(121);
  return { delegate, delegatedAmount, amount };
}

type State = {
  cluster: "devnet";
  genesis: string;
  program_id: string;
  mint: string;
  mint_decimals: number;
  what_this_mint_is: string;
  skr_mainnet_mint: string;
  skr_on_this_cluster: "absent";
  owner: string;
  owner_token_account: string;
  merchant: string;
  merchant_token_account: string;
  agent: string;
  mandate_id: string;
  mandate?: string;
  ledger?: string;
  open_signature?: string;
  paid_signature?: string;
  refused_signature?: string;
};

function usage(): never {
  console.error(`open a second mandate against a second devnet mint

Usage:
  npx tsx second-mint.ts [--rpc url[,url...]] [--keys-dir dir]

The first mandate, its source token account, and its delegate are not inputs.
SKR (${SKR_MINT}) is checked on the configured cluster. If that mint account
exists, this command stops. It does not label any other mint SKR.
`);
  process.exit(2);
}

function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) {
    throw new Error(`second-mint: missing keypair ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function ensureKeypair(path: string): Keypair {
  if (existsSync(path)) return loadKeypair(path);
  const kp = Keypair.generate();
  writeFileSync(path, `${JSON.stringify(Array.from(kp.secretKey))}\n`, { mode: 0o600 });
  return kp;
}

function statePath(dir: string): string {
  return join(dir, "second-mint-state.json");
}

function readState(dir: string): State | null {
  const path = statePath(dir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as State;
}

function writeState(dir: string, state: State): void {
  writeFileSync(statePath(dir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function accountData(conn: Connection, address: PublicKey): Promise<Buffer> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`second-mint: account ${address.toBase58()} was not found`);
  return Buffer.from(info.data);
}

function explain(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const withLogs = err as Error & { logs?: string[]; getLogs?: () => string[] };
  const logs = withLogs.logs ?? withLogs.getLogs?.();
  return logs && logs.length > 0 ? `${err.message}\n${logs.join("\n")}` : err.message;
}

async function mainFromCli(cli: Cli): Promise<void> {
  if (cli.flags.help || cli.flags.h) usage();

  const rpcs = resolveRpcList(cli);
  const dir = flagString(cli, "keys-dir") ?? keysDir();
  mkdirSync(dir, { recursive: true });
  const conn = connection(rpcs);
  const genesis = await conn.getGenesisHash();
  const programId = resolveProgramId();

  const skrInfo = await conn.getAccountInfo(new PublicKey(SKR_MINT), "confirmed");
  if (skrInfo) {
    throw new Error(
      `second-mint: SKR mint ${SKR_MINT} exists on this cluster (owner ${skrInfo.owner.toBase58()}). Use that mint. Do not open a stand-in.`,
    );
  }

  const owner = loadKeypair(join(dir, "owner.json"));
  const deployer = loadKeypair(join(dir, "deployer.json"));
  const merchant = loadKeypair(join(dir, "merchant.json"));
  const mintKp = ensureKeypair(join(dir, "second-mint.json"));
  const agent = ensureKeypair(join(dir, "second-agent.json"));

  const firstSource = new PublicKey(PROTECTED_FIRST_SOURCE);
  const firstDelegate = new PublicKey(PROTECTED_FIRST_DELEGATE);
  const ownerAta = getAssociatedTokenAddressSync(
    mintKp.publicKey,
    owner.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const merchantAta = getAssociatedTokenAddressSync(
    mintKp.publicKey,
    merchant.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  assertSecondMintAllowed({
    rpcUrls: rpcs,
    genesis,
    firstMint: PROTECTED_FIRST_MINT,
    secondMint: mintKp.publicKey.toBase58(),
    firstSource: firstSource.toBase58(),
    secondSource: ownerAta.toBase58(),
    skrMint: SKR_MINT,
  });
  if (merchantAta.equals(new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F"))) {
    throw new Error("second-mint: refusing to reuse the first merchant token account");
  }

  const protectedMandate = await accountData(conn, firstDelegate);
  const protectedSource = await accountData(conn, firstSource);
  const delegateBefore = readTokenDelegate(protectedSource);
  if (delegateBefore.delegate !== PROTECTED_FIRST_DELEGATE) {
    throw new Error(
      `second-mint: first source delegate is ${delegateBefore.delegate ?? "unset"}, expected ${PROTECTED_FIRST_DELEGATE}`,
    );
  }

  const prior = readState(dir);
  const mandateId = BigInt(prior?.mandate_id ?? Date.now().toString());
  const mandate = mandatePda(programId, owner.publicKey, mandateId);
  const ledger = ledgerPda(programId, mandate);
  if (mandate.equals(firstDelegate)) {
    throw new Error("second-mint: refusing to reuse the existing delegate");
  }

  let state: State = {
    cluster: "devnet",
    genesis,
    program_id: programId.toBase58(),
    mint: mintKp.publicKey.toBase58(),
    mint_decimals: SECOND_DECIMALS,
    what_this_mint_is:
      "A classic SPL mint created on devnet for a second mandate. It is not SKR and it is not the first demo mint.",
    skr_mainnet_mint: SKR_MINT,
    skr_on_this_cluster: "absent",
    owner: owner.publicKey.toBase58(),
    owner_token_account: ownerAta.toBase58(),
    merchant: merchant.publicKey.toBase58(),
    merchant_token_account: merchantAta.toBase58(),
    agent: agent.publicKey.toBase58(),
    mandate_id: mandateId.toString(),
    mandate: mandate.toBase58(),
    ledger: ledger.toBase58(),
    open_signature: prior?.open_signature,
    paid_signature: prior?.paid_signature,
    refused_signature: prior?.refused_signature,
  };
  writeState(dir, state);

  const mintInfo = await conn.getAccountInfo(mintKp.publicKey, "confirmed");
  if (!mintInfo) {
    await createMint(
      conn,
      deployer,
      deployer.publicKey,
      null,
      SECOND_DECIMALS,
      mintKp,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
    );
    console.error(`created mint ${mintKp.publicKey.toBase58()}`);
  } else if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(
      `second-mint: ${mintKp.publicKey.toBase58()} exists and is not a classic SPL mint`,
    );
  } else {
    const decoded = await getMint(conn, mintKp.publicKey, "confirmed", TOKEN_PROGRAM_ID);
    if (decoded.decimals !== SECOND_DECIMALS) {
      throw new Error(`second-mint: existing mint decimals are ${decoded.decimals}, expected ${SECOND_DECIMALS}`);
    }
  }

  const ownerAccount = await getOrCreateAssociatedTokenAccount(
    conn,
    deployer,
    mintKp.publicKey,
    owner.publicKey,
    false,
    "confirmed",
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  const merchantAccount = await getOrCreateAssociatedTokenAccount(
    conn,
    deployer,
    mintKp.publicKey,
    merchant.publicKey,
    false,
    "confirmed",
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  if (!ownerAccount.address.equals(ownerAta) || !merchantAccount.address.equals(merchantAta)) {
    throw new Error("second-mint: associated token account address did not match the one that was checked");
  }
  if (ownerAccount.amount < PAID_AMOUNT) {
    const topUp = MINT_AMOUNT - ownerAccount.amount;
    const sig = await mintTo(
      conn,
      deployer,
      mintKp.publicKey,
      ownerAta,
      deployer,
      topUp,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
    );
    console.error(`minted supply tx=${sig}`);
  }

  const agentBalance = await conn.getBalance(agent.publicKey, "confirmed");
  if (agentBalance < 20_000_000) {
    const fund = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: agent.publicKey,
        lamports: AGENT_LAMPORTS,
      }),
    );
    const sig = await sendAndConfirmTransaction(conn, fund, [deployer], { commitment: "confirmed" });
    console.error(`funded second agent tx=${sig}`);
  }

  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as Idl;
  const provider = new AnchorProvider(conn, new Wallet(owner), {
    commitment: "confirmed",
    skipPreflight: false,
  });
  const program = new Program(idl, provider);
  const existingMandate = await conn.getAccountInfo(mandate, "confirmed");
  if (!existingMandate) {
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
    const openIx = await program.methods
      .openMandate({
        mandateId: new BN(mandateId.toString()),
        agent: agent.publicKey,
        merchant: merchant.publicKey,
        cap: new BN(CAP.toString()),
        perTxMax: new BN(PER_TX_MAX.toString()),
        expiresAt: new BN(expiresAt.toString()),
        purpose: SECOND_PURPOSE,
      })
      .accountsPartial({
        owner: owner.publicKey,
        mandate,
        ledger,
        source: ownerAta,
        mint: mintKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const openSig = await sendAndConfirmTransaction(conn, new Transaction().add(openIx), [owner], {
      commitment: "confirmed",
    });
    state = { ...state, open_signature: openSig };
    writeState(dir, state);
    console.error(`opened mandate ${mandate.toBase58()} tx=${openSig}`);
  }

  const charge = async (amount: bigint, nonce: bigint): Promise<string> => {
    const ix = await program.methods
      .charge(new BN(amount.toString()), new BN(nonce.toString()))
      .accountsPartial({
        agent: agent.publicKey,
        mandate,
        ledger,
        source: ownerAta,
        destination: merchantAta,
        mint: mintKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return sendAndConfirmTransaction(conn, new Transaction().add(ix), [agent], {
      commitment: "confirmed",
    });
  };

  const opened = await fetchMandate(conn, mandate);
  if (opened.mint.toBase58() !== mintKp.publicKey.toBase58()) {
    throw new Error("second-mint: opened mandate names a different mint");
  }
  if (opened.source.toBase58() === PROTECTED_FIRST_SOURCE) {
    throw new Error("second-mint: opened mandate points at the first source");
  }
  if (opened.spendCount === 0 && !state.paid_signature) {
    const paidSig = await charge(PAID_AMOUNT, 1n);
    state = { ...state, paid_signature: paidSig };
    writeState(dir, state);
    console.error(`paid amount=${PAID_AMOUNT.toString()} nonce=1 tx=${paidSig}`);
  }
  const afterPaid = await fetchMandate(conn, mandate);
  if (afterPaid.refusalCount === 0 && !state.refused_signature) {
    const refusedSig = await charge(REFUSED_AMOUNT, 2n);
    state = { ...state, refused_signature: refusedSig };
    writeState(dir, state);
    console.error(`refused amount=${REFUSED_AMOUNT.toString()} nonce=2 tx=${refusedSig}`);
  }

  const mandateAfter = await accountData(conn, firstDelegate);
  const sourceAfter = await accountData(conn, firstSource);
  if (!mandateAfter.equals(protectedMandate) || !sourceAfter.equals(protectedSource)) {
    throw new Error("second-mint: the first mandate or its source token account changed");
  }

  const decoded = await fetchMandate(conn, mandate);
  const ring = await fetchLedger(conn, ledger);
  const delegateAfter = readTokenDelegate(await accountData(conn, ownerAta));
  if (delegateAfter.delegate !== mandate.toBase58()) {
    throw new Error(
      `second-mint: second source delegate is ${delegateAfter.delegate ?? "unset"}, expected ${mandate.toBase58()}`,
    );
  }

  const lines = [
    `cluster                 devnet`,
    `genesis                 ${genesis}`,
    `skr_mint_on_cluster     absent ${SKR_MINT}`,
    `second_mint             ${mintKp.publicKey.toBase58()}`,
    `second_mint_is          classic SPL mint created on devnet, 6 decimals, not SKR`,
    `owner_token_account    ${ownerAta.toBase58()}`,
    `merchant_token_account ${merchantAta.toBase58()}`,
    `agent                   ${agent.publicKey.toBase58()}`,
    `delegate                ${delegateAfter.delegate}`,
    `delegated_amount       ${delegateAfter.delegatedAmount.toString()}`,
    `mandate                 ${mandate.toBase58()}`,
    `ledger                  ${ledger.toBase58()}`,
    `mandate_id              ${decoded.mandateId.toString()}`,
    `mint_field              ${decoded.mint.toBase58()}`,
    `source_field            ${decoded.source.toBase58()}`,
    `merchant_field          ${decoded.merchant.toBase58()}`,
    `cap                     ${decoded.cap.toString()}`,
    `spent                   ${decoded.spent.toString()}`,
    `per_tx_max              ${decoded.perTxMax.toString()}`,
    `expires_at              ${decoded.expiresAt.toString()}`,
    `last_nonce              ${decoded.lastNonce.toString()}`,
    `purpose                 ${decoded.purpose}`,
    `status                  ${decoded.status}`,
    `spend_count             ${decoded.spendCount}`,
    `refusal_count           ${decoded.refusalCount}`,
    `bump                    ${decoded.bump}`,
    `open_signature         ${state.open_signature ?? ""}`,
    `paid_signature         ${state.paid_signature ?? ""}`,
    `refused_signature      ${state.refused_signature ?? ""}`,
    `first_delegate_unchanged ${PROTECTED_FIRST_DELEGATE}`,
  ];
  for (const indexed of ring.entries.slice(0, ring.total)) {
    const name = kindName(indexed.kind) ?? `kind ${indexed.kind}`;
    lines.push(
      `ledger_entry            ${name} amount=${indexed.amount.toString()} nonce=${indexed.nonce.toString()} reason=${reasonText(indexed.reason)}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  mainFromCli(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
    console.error(`second-mint failed: ${explain(err)}`);
    process.exit(1);
  });
}
