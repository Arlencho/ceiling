import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AgentConfig } from "./config.js";
import {
  advisoryMemoInstruction,
  advisoryMemoText,
  type PurposeCheck,
  type PurposeCheckContext,
} from "./advisory.js";
import { decisionsFromTx, viewFromRpc, type RpcTransaction } from "./events.js";
import { CHARGE_DISCRIMINATOR, PROGRAM_ID } from "./idl.js";
import {
  asU64,
  decodeMandate,
  ledgerPda,
  mandatePda,
  toPublicKey,
  type MandateAccount,
} from "./layout.js";
import { fetchMandate } from "./read.js";

/** Twenty charges at the 5000 lamport base fee. status() warns under this. */
export const BASE_FEE_LAMPORTS = 5_000n;
export const LOW_FEE_LAMPORTS = BASE_FEE_LAMPORTS * 20n;

const U64_MAX = 0xffff_ffff_ffff_ffffn;

export type ChargeArgs = {
  amount: bigint | number;
  nonce: bigint | number;
  /**
   * When true, refuse locally if this nonce is a pending override and the
   * amount is not `overrideAmount`. Any paid charge at that nonce clears the
   * override. Omit it to send the amount and nonce unchanged.
   */
  guardPendingOverride?: boolean;
};

export type ChargeResult = {
  kind: "paid" | "refused";
  reasonCode: number;
  reasonText: string;
  suggestedOverride: bigint;
  signature: string;
  slot: number;
};

/** The agent declined before submit. This is not a program refusal. */
export type AdvisoryDeclined = {
  kind: "advisory_declined";
  reason: string;
  signature: string;
};

export type { PurposeCheck, PurposeCheckContext, PurposeCheckResult } from "./advisory.js";

export type AgentStatus = {
  mandate: string;
  owner: string;
  agent: string;
  mint: string;
  source: string;
  merchant: string;
  mandateId: bigint;
  cap: bigint;
  perTxMax: bigint;
  spent: bigint;
  remaining: bigint;
  expiresAt: bigint;
  purpose: string;
  status: number;
  spendCount: number;
  refusalCount: number;
  lastNonce: bigint;
  overrideAmount: bigint;
  overrideNonce: bigint;
  agentLamports: bigint;
  feeWarning: string | null;
};

export type VetoAgentArgs = {
  connection: Connection;
  agent: Keypair;
  mandate?: PublicKey | string;
  owner?: PublicKey | string;
  mandateId?: bigint | number;
  programId?: PublicKey | string;
  /**
   * Optional check run by chargeWithPurposeCheck. charge() does not call it.
   * Whoever runs the agent can skip the check by calling charge().
   */
  purposeCheck?: PurposeCheck;
};

/** A program id passed in code. The block cannot choose the program. */
export type FromConfigOptions = {
  programId?: PublicKey | string;
  purposeCheck?: PurposeCheck;
};

/** Genesis hash reported by getGenesisHash for each cluster the block may name. */
const CLUSTER_GENESIS: Readonly<Record<string, string>> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

/** SPL mint layout: decimals is the byte after the 36-byte authority and the 8-byte supply. */
const MINT_DECIMALS_OFFSET = 44;

export class VetoAgent {
  readonly connection: Connection;
  readonly agent: Keypair;
  readonly mandate: PublicKey;
  readonly programId: PublicKey;
  private readonly purposeCheck: PurposeCheck | undefined;

  constructor(args: VetoAgentArgs) {
    if (!(args.agent instanceof Keypair)) {
      throw new Error("VetoAgent: agent must be a Keypair");
    }
    this.connection = args.connection;
    this.agent = args.agent;
    this.programId = args.programId ? toPublicKey(args.programId, "VetoAgent programId") : PROGRAM_ID;
    this.mandate = resolveMandate(args, this.programId);
    this.purposeCheck = args.purposeCheck;
  }

  /**
   * Builds an agent from the block the app copies.
   * The program is PROGRAM_ID unless options.programId is set.
   * A block whose programId differs from that id is refused.
   * A connection argument is the endpoint. Otherwise config.rpcUrl is opened.
   * That endpoint must report the genesis hash for config.cluster.
   * The mint account, owned by the source token program, must show config.mintDecimals.
   */
  static async fromConfig(
    config: AgentConfig,
    agentKeypair: Keypair,
    connection?: Connection,
    options?: FromConfigOptions,
  ): Promise<VetoAgent> {
    if (!(agentKeypair instanceof Keypair)) {
      throw new Error("VetoAgent.fromConfig: agent must be a Keypair");
    }
    if (config.agent !== agentKeypair.publicKey.toBase58()) {
      throw new Error(
        `VetoAgent.fromConfig: config agent ${config.agent} does not equal the agent key ${agentKeypair.publicKey.toBase58()}`,
      );
    }
    const programId = pinnedProgramId(options);
    const blockProgram = toPublicKey(config.programId, "VetoAgent.fromConfig config programId");
    if (!blockProgram.equals(programId)) {
      throw new Error(
        `VetoAgent.fromConfig: config program ${blockProgram.toBase58()} does not equal the Veto program ${programId.toBase58()}`,
      );
    }
    const rpc = connection ?? new Connection(config.rpcUrl, "confirmed");
    await assertCluster(rpc, config.cluster);
    const veto = new VetoAgent({
      connection: rpc,
      agent: agentKeypair,
      mandate: config.mandate,
      programId,
      purposeCheck: options?.purposeCheck,
    });
    let mandate: MandateAccount;
    try {
      mandate = await fetchMandate(rpc, veto.mandate, veto.programId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("is not owned by the Veto program")) {
        throw new Error(
          `VetoAgent.fromConfig: mandate ${config.mandate} is not owned by program ${programId.toBase58()}`,
          { cause: err },
        );
      }
      throw new Error(`VetoAgent.fromConfig: ${message}`, { cause: err });
    }
    if (!mandate.agent.equals(agentKeypair.publicKey)) {
      throw new Error(
        `VetoAgent.fromConfig: mandate agent ${mandate.agent.toBase58()} does not equal the agent key ${agentKeypair.publicKey.toBase58()}`,
      );
    }
    if (!mandate.mint.equals(new PublicKey(config.mint))) {
      throw new Error(
        `VetoAgent.fromConfig: mint ${mandate.mint.toBase58()} does not equal the config mint ${config.mint}`,
      );
    }
    if (!mandate.source.equals(new PublicKey(config.sourceTokenAccount))) {
      throw new Error(
        `VetoAgent.fromConfig: source token account ${mandate.source.toBase58()} does not equal the config source ${config.sourceTokenAccount}`,
      );
    }
    const sourceInfo = await rpc.getAccountInfo(mandate.source, "confirmed");
    if (!sourceInfo) {
      throw new Error(`VetoAgent.fromConfig: source token account ${mandate.source.toBase58()} not found`);
    }
    await assertMintDecimals(rpc, mandate.mint, sourceInfo.owner, config.mintDecimals);
    const payee = await merchantTokenAccount(
      rpc,
      mandate.merchant,
      mandate.mint,
      sourceInfo.owner,
      "VetoAgent.fromConfig",
    );
    if (!payee.equals(new PublicKey(config.payeeTokenAccount))) {
      throw new Error(
        `VetoAgent.fromConfig: payee token account ${payee.toBase58()} does not equal the config payee ${config.payeeTokenAccount}`,
      );
    }
    return veto;
  }

  /**
   * Builds an agent from a mandate account.
   * The program id, mint and decimals, source, payee token account, agent, and cluster
   * are read from the chain. The keypair must be the agent named on that mandate.
   * The account must be owned by the Veto program.
   */
  static async fromMandate(
    connection: Connection,
    mandate: PublicKey | string,
    agentKeypair: Keypair,
  ): Promise<VetoAgent> {
    if (!(agentKeypair instanceof Keypair)) {
      throw new Error("VetoAgent.fromMandate: agent must be a Keypair");
    }
    const mandateKey = toPublicKey(mandate, "VetoAgent.fromMandate mandate");
    await assertKnownCluster(connection);
    const info = await connection.getAccountInfo(mandateKey, "confirmed");
    if (!info) {
      throw new Error(`VetoAgent.fromMandate: mandate ${mandateKey.toBase58()} not found`);
    }
    const programId = info.owner;
    if (!programId.equals(PROGRAM_ID)) {
      throw new Error(
        `VetoAgent.fromMandate: mandate ${mandateKey.toBase58()} is not owned by program ${PROGRAM_ID.toBase58()}`,
      );
    }
    let decoded: MandateAccount;
    try {
      const data = info.data;
      if (!(data instanceof Uint8Array)) {
        throw new Error("account data was not bytes");
      }
      decoded = decodeMandate(Buffer.from(data));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`VetoAgent.fromMandate: ${message}`, { cause: err });
    }
    if (!decoded.agent.equals(agentKeypair.publicKey)) {
      throw new Error(
        `VetoAgent.fromMandate: mandate agent ${decoded.agent.toBase58()} does not equal the agent key ${agentKeypair.publicKey.toBase58()}`,
      );
    }
    const sourceInfo = await connection.getAccountInfo(decoded.source, "confirmed");
    if (!sourceInfo) {
      throw new Error(`VetoAgent.fromMandate: source token account ${decoded.source.toBase58()} not found`);
    }
    await readMandateMintDecimals(connection, decoded.mint, sourceInfo.owner);
    await merchantTokenAccount(
      connection,
      decoded.merchant,
      decoded.mint,
      sourceInfo.owner,
      "VetoAgent.fromMandate",
    );
    return new VetoAgent({
      connection,
      agent: agentKeypair,
      mandate: mandateKey,
      programId,
    });
  }

  /** Submits charge and reads the one Veto decision in that transaction. */
  async charge(args: ChargeArgs): Promise<ChargeResult> {
    const amount = asU64(args.amount, "VetoAgent.charge amount");
    const nonce = asU64(args.nonce, "VetoAgent.charge nonce");
    const mandate = await this.loadMandate();
    if (!mandate.agent.equals(this.agent.publicKey)) {
      throw new Error("VetoAgent.charge: signer is not the agent named in the mandate");
    }
    if (
      args.guardPendingOverride === true &&
      mandate.overrideNonce > mandate.lastNonce &&
      nonce === mandate.overrideNonce &&
      amount !== mandate.overrideAmount
    ) {
      throw new Error(
        `VetoAgent.charge: nonce ${nonce.toString()} is a pending override for ${mandate.overrideAmount.toString()} base units, refusing ${amount.toString()} so a paid charge does not clear the override`,
      );
    }
    const sourceInfo = await this.connection.getAccountInfo(mandate.source, "confirmed");
    if (!sourceInfo) {
      throw new Error(`VetoAgent.charge: source token account ${mandate.source.toBase58()} not found`);
    }
    const destination = await merchantTokenAccount(
      this.connection,
      mandate.merchant,
      mandate.mint,
      sourceInfo.owner,
    );
    const ledger = ledgerPda(this.programId, this.mandate);
    const data = Buffer.alloc(24);
    CHARGE_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    data.writeBigUInt64LE(nonce, 16);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.agent.publicKey, isSigner: true, isWritable: false },
        { pubkey: this.mandate, isSigner: false, isWritable: true },
        { pubkey: ledger, isSigner: false, isWritable: true },
        { pubkey: mandate.source, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: mandate.mint, isSigner: false, isWritable: false },
        { pubkey: sourceInfo.owner, isSigner: false, isWritable: false },
      ],
      data,
    });
    const signature = await this.submit(ix);
    const tx = await confirmedTransaction(this.connection, signature);
    if (!tx || typeof tx.slot !== "number") {
      throw new Error(`VetoAgent.charge: transaction ${signature} carries no attributable Veto decision`);
    }
    const view = viewFromRpc(tx, { signature, slot: tx.slot });
    const matches = decisionsFromTx(view, this.programId.toBase58(), this.mandate.toBase58()).filter(
      (decision) => decision.amount === amount && decision.nonce === nonce,
    );
    if (matches.length !== 1) {
      const detail =
        matches.length === 0
          ? "no attributable Veto decision"
          : `${matches.length} Veto decisions for nonce ${nonce.toString()}`;
      throw new Error(`VetoAgent.charge: transaction ${signature} carries ${detail}`);
    }
    const decision = matches[0];
    if (!decision || (decision.kind !== "paid" && decision.kind !== "refused")) {
      throw new Error(`VetoAgent.charge: transaction ${signature} carries no attributable Veto decision`);
    }
    return {
      kind: decision.kind,
      reasonCode: decision.reason,
      reasonText: decision.reasonText,
      suggestedOverride: decision.suggestedOverride,
      signature,
      slot: view.slot,
    };
  }

  /**
   * Runs purposeCheck, then charge() when it allows.
   * A decline does not submit charge. It sends one Memo transaction signed by the agent.
   * The mandate is a read-only non-signer. The memo is veto-advisory:v1 and compact JSON.
   */
  async chargeWithPurposeCheck(args: {
    amount: bigint | number;
    nonce: bigint | number;
    description: string;
  }): Promise<ChargeResult | AdvisoryDeclined> {
    const amount = asU64(args.amount, "VetoAgent.chargeWithPurposeCheck amount");
    const nonce = asU64(args.nonce, "VetoAgent.chargeWithPurposeCheck nonce");
    if (typeof args.description !== "string") {
      throw new Error("VetoAgent.chargeWithPurposeCheck: description must be a string");
    }
    if (!this.purposeCheck) {
      throw new Error("VetoAgent.chargeWithPurposeCheck: purposeCheck is not set");
    }
    const mandate = await this.loadMandate();
    if (!mandate.agent.equals(this.agent.publicKey)) {
      throw new Error("VetoAgent.chargeWithPurposeCheck: signer is not the agent named in the mandate");
    }
    const sourceInfo = await this.connection.getAccountInfo(mandate.source, "confirmed");
    if (!sourceInfo) {
      throw new Error(
        `VetoAgent.chargeWithPurposeCheck: source token account ${mandate.source.toBase58()} not found`,
      );
    }
    const decimals = await readMintDecimals(this.connection, mandate.mint, sourceInfo.owner);
    const ctx: PurposeCheckContext = {
      purpose: mandate.purpose,
      amount,
      decimals,
      payee: mandate.merchant.toBase58(),
      mandate: this.mandate.toBase58(),
      description: args.description,
    };
    let result: { allow?: unknown; reason?: unknown };
    try {
      result = await this.purposeCheck(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`VetoAgent.chargeWithPurposeCheck: ${message}`, { cause: err });
    }
    if (!result || typeof result !== "object" || result.allow !== true) {
      const reason = result && typeof result === "object" && typeof result.reason === "string"
        ? result.reason
        : "purpose check declined";
      return this.recordAdvisoryDecline({ amount, nonce, reason, description: args.description });
    }
    return this.charge({ amount, nonce });
  }

  private async recordAdvisoryDecline(args: {
    amount: bigint;
    nonce: bigint;
    reason: string;
    description: string;
  }): Promise<AdvisoryDeclined> {
    const memo = advisoryMemoText({
      mandate: this.mandate.toBase58(),
      amount: args.amount,
      nonce: args.nonce,
      reason: args.reason,
      description: args.description,
    });
    const ix = advisoryMemoInstruction(this.agent.publicKey, this.mandate, memo.text);
    const signature = await this.submit(ix, "VetoAgent.chargeWithPurposeCheck");
    return { kind: "advisory_declined", reason: memo.reason, signature };
  }

  /**
   * Nonce for the next charge.
   * A pending override is override_nonce above last_nonce, and that is the nonce
   * the retry must use. Otherwise this is last_nonce plus one.
   * A refused charge does not advance last_nonce.
   */
  async nextNonce(): Promise<bigint> {
    const mandate = await this.loadMandate();
    if (mandate.overrideNonce > mandate.lastNonce) {
      return mandate.overrideNonce;
    }
    if (mandate.lastNonce >= U64_MAX) {
      throw new Error("VetoAgent.nextNonce: last_nonce is the maximum u64");
    }
    return mandate.lastNonce + 1n;
  }

  async status(): Promise<AgentStatus> {
    const mandate = await this.loadMandate();
    const lamports = BigInt(await this.connection.getBalance(this.agent.publicKey, "confirmed"));
    const remaining = mandate.cap > mandate.spent ? mandate.cap - mandate.spent : 0n;
    return {
      mandate: this.mandate.toBase58(),
      owner: mandate.owner.toBase58(),
      agent: mandate.agent.toBase58(),
      mint: mandate.mint.toBase58(),
      source: mandate.source.toBase58(),
      merchant: mandate.merchant.toBase58(),
      mandateId: mandate.mandateId,
      cap: mandate.cap,
      perTxMax: mandate.perTxMax,
      spent: mandate.spent,
      remaining,
      expiresAt: mandate.expiresAt,
      purpose: mandate.purpose,
      status: mandate.status,
      spendCount: mandate.spendCount,
      refusalCount: mandate.refusalCount,
      lastNonce: mandate.lastNonce,
      overrideAmount: mandate.overrideAmount,
      overrideNonce: mandate.overrideNonce,
      agentLamports: lamports,
      feeWarning: feeWarning(lamports),
    };
  }

  private async loadMandate(): Promise<MandateAccount> {
    try {
      return await fetchMandate(this.connection, this.mandate, this.programId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`VetoAgent: ${message}`, { cause: err });
    }
  }

  private async submit(ix: TransactionInstruction, label = "VetoAgent.charge"): Promise<string> {
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.feePayer = this.agent.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.lastValidBlockHeight = latest.lastValidBlockHeight;
    tx.add(ix);
    tx.sign(this.agent);
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}: ${message}`, { cause: err });
    }
    const confirmed = await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed",
    );
    if (confirmed.value.err) {
      throw new Error(
        `${label}: transaction ${signature} failed: ${JSON.stringify(confirmed.value.err)}`,
      );
    }
    return signature;
  }
}

export function feeWarning(lamports: bigint): string | null {
  if (lamports >= LOW_FEE_LAMPORTS) return null;
  return `agent SOL balance is ${lamports.toString()} lamports, under ${LOW_FEE_LAMPORTS.toString()} lamports (20 base fees of ${BASE_FEE_LAMPORTS.toString()}). The agent pays the transaction fee.`;
}

function pinnedProgramId(options: FromConfigOptions | undefined): PublicKey {
  if (options?.programId === undefined) return PROGRAM_ID;
  return toPublicKey(options.programId, "VetoAgent.fromConfig programId");
}

async function assertCluster(connection: Connection, cluster: string): Promise<void> {
  const expected = CLUSTER_GENESIS[cluster];
  if (expected === undefined) {
    throw new Error(
      `VetoAgent.fromConfig: cluster ${JSON.stringify(cluster)} must be devnet, testnet, or mainnet-beta`,
    );
  }
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `VetoAgent.fromConfig: cluster ${JSON.stringify(cluster)} genesis hash could not be read: ${JSON.stringify(message)}`,
      { cause: err },
    );
  }
  if (genesis !== expected) {
    throw new Error(
      `VetoAgent.fromConfig: cluster ${JSON.stringify(cluster)} does not match genesis hash ${JSON.stringify(genesis)}`,
    );
  }
}

async function assertKnownCluster(connection: Connection): Promise<void> {
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `VetoAgent.fromMandate: genesis hash could not be read: ${JSON.stringify(message)}`,
      { cause: err },
    );
  }
  if (!knownCluster(genesis)) {
    throw new Error(
      `VetoAgent.fromMandate: genesis hash ${JSON.stringify(genesis)} is not devnet, testnet, or mainnet-beta`,
    );
  }
}

function knownCluster(genesis: string): string | undefined {
  if (genesis === CLUSTER_GENESIS.devnet) return "devnet";
  if (genesis === CLUSTER_GENESIS.testnet) return "testnet";
  if (genesis === CLUSTER_GENESIS["mainnet-beta"]) return "mainnet-beta";
  return undefined;
}

async function readMandateMintDecimals(
  connection: Connection,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<number> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) {
    throw new Error(`VetoAgent.fromMandate: mint account ${mint.toBase58()} not found`);
  }
  if (!info.owner.equals(tokenProgram)) {
    throw new Error(
      `VetoAgent.fromMandate: mint account ${mint.toBase58()} is not owned by the source token program ${tokenProgram.toBase58()}`,
    );
  }
  const data = info.data;
  if (!(data instanceof Uint8Array) || data.length < MINT_DECIMALS_OFFSET + 1) {
    throw new Error(`VetoAgent.fromMandate: mint account ${mint.toBase58()} is too short to read decimals`);
  }
  const decimals = data[MINT_DECIMALS_OFFSET];
  if (decimals === undefined) {
    throw new Error(`VetoAgent.fromMandate: mint account ${mint.toBase58()} is too short to read decimals`);
  }
  return decimals;
}

async function readMintDecimals(
  connection: Connection,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<number> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) {
    throw new Error(`VetoAgent.chargeWithPurposeCheck: mint account ${mint.toBase58()} not found`);
  }
  if (!info.owner.equals(tokenProgram)) {
    throw new Error(
      `VetoAgent.chargeWithPurposeCheck: mint account ${mint.toBase58()} is not owned by the source token program ${tokenProgram.toBase58()}`,
    );
  }
  const data = info.data;
  if (!(data instanceof Uint8Array) || data.length < MINT_DECIMALS_OFFSET + 1) {
    throw new Error(`VetoAgent.chargeWithPurposeCheck: mint account ${mint.toBase58()} is too short to read decimals`);
  }
  const decimals = data[MINT_DECIMALS_OFFSET];
  if (decimals === undefined) {
    throw new Error(`VetoAgent.chargeWithPurposeCheck: mint account ${mint.toBase58()} is too short to read decimals`);
  }
  return decimals;
}

async function assertMintDecimals(
  connection: Connection,
  mint: PublicKey,
  tokenProgram: PublicKey,
  decimals: number,
): Promise<void> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) {
    throw new Error(`VetoAgent.fromConfig: mint account ${mint.toBase58()} not found`);
  }
  if (!info.owner.equals(tokenProgram)) {
    throw new Error(
      `VetoAgent.fromConfig: mint account ${mint.toBase58()} is not owned by the source token program ${tokenProgram.toBase58()}`,
    );
  }
  const data = info.data;
  if (!(data instanceof Uint8Array) || data.length < MINT_DECIMALS_OFFSET + 1) {
    throw new Error(`VetoAgent.fromConfig: mint account ${mint.toBase58()} is too short to read decimals`);
  }
  const onChain = data[MINT_DECIMALS_OFFSET];
  if (onChain !== decimals) {
    throw new Error(
      `VetoAgent.fromConfig: mint decimals ${String(onChain)} do not equal config mintDecimals ${String(decimals)}`,
    );
  }
}

function resolveMandate(args: VetoAgentArgs, programId: PublicKey): PublicKey {
  const hasMandate = args.mandate !== undefined;
  const hasOwner = args.owner !== undefined;
  const hasId = args.mandateId !== undefined;
  if (!hasMandate && !(hasOwner && hasId)) {
    throw new Error("VetoAgent: pass a mandate address, or an owner and a mandate id");
  }
  if (hasOwner !== hasId) {
    throw new Error("VetoAgent: owner and mandate id are used together");
  }
  let derived: PublicKey | undefined;
  if (hasOwner && hasId && args.owner !== undefined && args.mandateId !== undefined) {
    derived = mandatePda(programId, toPublicKey(args.owner, "VetoAgent owner"), asU64(args.mandateId, "VetoAgent mandateId"));
  }
  if (args.mandate !== undefined) {
    const given = toPublicKey(args.mandate, "VetoAgent mandate");
    if (derived && !derived.equals(given)) {
      throw new Error("VetoAgent: mandate address does not match owner and mandate id");
    }
    return given;
  }
  if (!derived) throw new Error("VetoAgent: pass a mandate address, or an owner and a mandate id");
  return derived;
}

async function merchantTokenAccount(
  connection: Connection,
  merchant: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  label = "VetoAgent.charge",
): Promise<PublicKey> {
  // The destination is the merchant associated token account for this mint and
  // the source token program. Listing is only for a merchant with no such account,
  // and more than one listed account is still an error.
  const ata = getAssociatedTokenAddressSync(mint, merchant, true, tokenProgram);
  const ataInfo = await connection.getAccountInfo(ata, "confirmed");
  if (ataInfo) return ata;

  const filter = tokenProgram.equals(TOKEN_PROGRAM_ID) ? { mint } : { programId: tokenProgram };
  const listed = await connection.getTokenAccountsByOwner(merchant, filter, "confirmed");
  const matches: PublicKey[] = [];
  for (const item of listed.value) {
    const data = item.account.data;
    if (!(data instanceof Uint8Array) || data.length < 32) {
      throw new Error(`${label}: token account data was not bytes`);
    }
    const accountMint = new PublicKey(data.subarray(0, 32));
    if (!accountMint.equals(mint)) continue;
    matches.push(item.pubkey);
  }
  if (matches.some((key) => key.equals(ata))) return ata;
  if (matches.length === 0) {
    throw new Error(
      `${label}: no token account for merchant ${merchant.toBase58()} and mint ${mint.toBase58()}`,
    );
  }
  if (matches.length > 1) {
    const list = matches.map((key) => key.toBase58()).join(", ");
    throw new Error(
      `${label}: merchant ${merchant.toBase58()} has ${matches.length} token accounts for mint ${mint.toBase58()}: ${list}`,
    );
  }
  const only = matches[0];
  if (!only) {
    throw new Error(
      `${label}: no token account for merchant ${merchant.toBase58()} and mint ${mint.toBase58()}`,
    );
  }
  return only;
}

async function confirmedTransaction(connection: Connection, signature: string): Promise<RpcTransaction | null> {
  const opts = { commitment: "confirmed" as const, maxSupportedTransactionVersion: 0 as const };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tx = await connection.getTransaction(signature, opts);
    if (tx) return tx as RpcTransaction;
    if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}
