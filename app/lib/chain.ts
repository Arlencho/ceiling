import { Buffer } from 'buffer';
import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccount3Instruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type ConfirmedSignatureInfo,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';

import type { AppConfig } from './appConfig';
import { loadConfig } from './config';
import {
  KIND_OPENED,
  KIND_OVERRIDE,
  KIND_REVOKED,
  LEDGER_ACCOUNT_SIZE,
  MANDATE_ACCOUNT_SIZE,
  PURPOSE_MAX_LEN,
  STATUS_ACTIVE,
} from './constants';
import { decodeEventsFromLogs, decodeInstructionKind } from './events';
import {
  closeMandateInstruction,
  grantOverrideInstruction,
  openMandateInstruction,
  revokeMandateInstruction,
} from './instructions';
import {
  classifyRuleSource,
  deriveRuleTokenAccount,
  OPEN_SIGNATURE_FEE_LAMPORTS,
  openFundsRefusal,
  readMintDecimals,
  readTokenAmount,
  ruleTokenSeed,
  type RuleAccountKind,
} from './ruleAccount';
import { assessOverride, type OverrideAssessment } from './override';
import { decodeMandateAccount, type MandateAccount } from './mandate';
import {
  attachSignatures,
  decodeLedgerAccount,
  ledgerPda,
  mandatePda,
  type DecodedTxDecision,
  type LedgerRow,
  type LedgerSnapshot,
} from './ring';

export type SignAndSend = (transactions: Transaction[]) => Promise<string[]>;

export type OpenMandateInput = {
  owner: PublicKey;
  agent: PublicKey;
  merchant: PublicKey;
  cap: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  purpose: string;
  mint?: PublicKey;
};

export type OpenMandateResult = {
  signature: string;
  mandate: MandateAccount;
  ledger: string;
};

export type RevokeResult = {
  signature: string;
  mandate: MandateAccount;
};

export type CloseResult = {
  signature: string;
};

export type RuleFunds = {
  source: string;
  balance: bigint | null;
  kind: RuleAccountKind;
};

export type GrantOverrideResult = {
  signature: string;
  mandate: MandateAccount;
  row: LedgerRow;
};

export type ChainClient = {
  config: AppConfig;
  connection: Connection;
  programId: PublicKey;
};

export function createClient(config: AppConfig = loadConfig()): ChainClient {
  return {
    config,
    connection: new Connection(config.rpcUrl, 'confirmed'),
    programId: new PublicKey(config.programId),
  };
}

export async function fetchMandate(
  client: ChainClient,
  address: PublicKey,
): Promise<MandateAccount> {
  const info = await client.connection.getAccountInfo(address, 'confirmed');
  if (!info) {
    throw new Error(`mandate ${address.toBase58()} was not found on chain`);
  }
  return decodeMandateAccount(address.toBase58(), info.data);
}

export async function fetchLedger(
  client: ChainClient,
  mandate: PublicKey,
): Promise<LedgerSnapshot> {
  const address = ledgerPda(client.programId, mandate);
  const info = await client.connection.getAccountInfo(address, 'confirmed');
  if (!info) {
    throw new Error(`ledger ${address.toBase58()} was not found on chain`);
  }
  return decodeLedgerAccount(address.toBase58(), info.data);
}

export async function fetchOwnerMandates(
  client: ChainClient,
  owner: PublicKey,
): Promise<MandateAccount[]> {
  const accounts = await client.connection.getProgramAccounts(client.programId, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 8, bytes: owner.toBase58() } }],
  });
  const mandates: MandateAccount[] = [];
  for (const account of accounts) {
    try {
      mandates.push(decodeMandateAccount(account.pubkey.toBase58(), account.account.data));
    } catch {
      // Ledgers and other program accounts share the program id. Skip those.
    }
  }
  mandates.sort((a, b) => (a.mandateId < b.mandateId ? 1 : a.mandateId > b.mandateId ? -1 : 0));
  return mandates;
}

export function pickMandate(
  mandates: MandateAccount[],
  preferredAddress: string | null,
): MandateAccount | null {
  if (mandates.length === 0) {
    return null;
  }
  if (preferredAddress) {
    const preferred = mandates.find((m) => m.address === preferredAddress);
    if (preferred) {
      return preferred;
    }
  }
  const active = mandates.find((m) => m.status === 0);
  return active ?? mandates[0] ?? null;
}

export async function fetchMintDecimals(client: ChainClient, mint: PublicKey): Promise<number> {
  const mintInfo = await getMint(client.connection, mint, 'confirmed');
  return mintInfo.decimals;
}

export async function tokenProgramOfMint(
  client: ChainClient,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await client.connection.getAccountInfo(mint, 'confirmed');
  if (!info) {
    throw new Error(`mint ${mint.toBase58()} was not found on chain`);
  }
  return info.owner;
}

export async function readRuleFunds(client: ChainClient, mandate: MandateAccount): Promise<RuleFunds> {
  const owner = new PublicKey(mandate.owner);
  const mint = new PublicKey(mandate.mint);
  const source = new PublicKey(mandate.source);
  const tokenProgram = await tokenProgramOfMint(client, mint);
  const kind = await classifyRuleSource({
    owner,
    mandateId: mandate.mandateId,
    mint,
    tokenProgram,
    source,
  });
  const info = await client.connection.getAccountInfo(source, 'confirmed');
  const balance = info ? readTokenAmount(info.data) : null;
  return { source: source.toBase58(), balance, kind };
}

async function confirmSignature(
  connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (result.value.err) {
    throw new Error(`transaction ${signature} landed with an error`);
  }
}

export async function openMandate(
  client: ChainClient,
  signAndSend: SignAndSend,
  input: OpenMandateInput,
): Promise<OpenMandateResult> {
  if (input.cap <= 0n) {
    throw new Error('cap must be greater than zero');
  }
  if (input.perTxMax <= 0n) {
    throw new Error('per-payment maximum must be greater than zero');
  }
  if (input.perTxMax > input.cap) {
    throw new Error('per-payment maximum cannot exceed the cap');
  }
  if (input.purpose.length > PURPOSE_MAX_LEN) {
    throw new Error('purpose is longer than the on-chain limit');
  }
  if (input.merchant.equals(PublicKey.default)) {
    throw new Error('a mandate must name the merchant it may pay');
  }
  if (input.agent.equals(input.owner)) {
    throw new Error('the agent key must not be the owner key');
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (input.expiresAt <= now) {
    throw new Error('expiry must be in the future');
  }

  const mint = input.mint ?? (client.config.mint ? new PublicKey(client.config.mint) : null);
  if (!mint) {
    throw new Error(
      'Mint is missing from config. Set EXPO_PUBLIC_VETO_MINT as documented in app/README.md.',
    );
  }

  const mintInfo = await client.connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) {
    throw new Error(`mint ${mint.toBase58()} was not found on chain`);
  }
  const tokenProgram = mintInfo.owner;
  const decimals = readMintDecimals(mintInfo.data);
  const ata = getAssociatedTokenAddressSync(mint, input.owner, false, tokenProgram);
  const ataInfo = await client.connection.getAccountInfo(ata, 'confirmed');
  const balance = ataInfo ? readTokenAmount(ataInfo.data) : null;
  if (ataInfo && balance === null) {
    throw new Error(
      `The associated token account ${ata.toBase58()} could not be read, so nothing was submitted.`,
    );
  }

  const [tokenRent, mandateRent, ledgerRent, solBalance] = await Promise.all([
    client.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
    client.connection.getMinimumBalanceForRentExemption(MANDATE_ACCOUNT_SIZE),
    client.connection.getMinimumBalanceForRentExemption(LEDGER_ACCOUNT_SIZE),
    client.connection.getBalance(input.owner, 'confirmed'),
  ]);
  const refusal = openFundsRefusal({
    ata,
    ataFound: ataInfo !== null,
    balance: balance ?? 0n,
    cap: input.cap,
    solBalance: BigInt(solBalance),
    tokenRent: BigInt(tokenRent),
    mandateRent: BigInt(mandateRent),
    ledgerRent: BigInt(ledgerRent),
    feeLamports: OPEN_SIGNATURE_FEE_LAMPORTS,
  });
  if (refusal) {
    throw new Error(refusal);
  }

  let mandateId = BigInt(Date.now());
  let ruleAccount = await deriveRuleTokenAccount(input.owner, mandateId, tokenProgram);
  let free = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const mandatePk = mandatePda(client.programId, input.owner, mandateId);
    const [mandateInfo, ruleInfo] = await Promise.all([
      client.connection.getAccountInfo(mandatePk, 'confirmed'),
      client.connection.getAccountInfo(ruleAccount, 'confirmed'),
    ]);
    if (!mandateInfo && !ruleInfo) {
      free = true;
      break;
    }
    mandateId += 1n;
    ruleAccount = await deriveRuleTokenAccount(input.owner, mandateId, tokenProgram);
  }
  if (!free) {
    throw new Error('No free mandate id was found for a new rule account.');
  }

  const built = openMandateInstruction({
    programId: client.programId,
    owner: input.owner,
    agent: input.agent,
    merchant: input.merchant,
    mint,
    source: ruleAccount,
    tokenProgram,
    mandateId,
    cap: input.cap,
    perTxMax: input.perTxMax,
    expiresAt: input.expiresAt,
    purpose: input.purpose,
  });
  const seed = ruleTokenSeed(mandateId);
  const createRuleAccount = SystemProgram.createAccountWithSeed({
    fromPubkey: input.owner,
    basePubkey: input.owner,
    seed,
    newAccountPubkey: ruleAccount,
    lamports: tokenRent,
    space: ACCOUNT_SIZE,
    programId: tokenProgram,
  });
  const initializeRuleAccount = createInitializeAccount3Instruction(
    ruleAccount,
    mint,
    input.owner,
    tokenProgram,
  );
  const fundRuleAccount = createTransferCheckedInstruction(
    ata,
    mint,
    ruleAccount,
    input.owner,
    input.cap,
    decimals,
    [],
    tokenProgram,
  );

  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = input.owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(createRuleAccount, initializeRuleAccount, fundRuleAccount, built.instruction);

  const [signature] = await signAndSend([tx]);
  if (!signature) {
    throw new Error('wallet returned no signature');
  }
  await confirmSignature(client.connection, signature, latest.blockhash, latest.lastValidBlockHeight);

  const mandate = await fetchMandate(client, built.mandate);
  return { signature, mandate, ledger: built.ledger.toBase58() };
}

export async function revokeMandate(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  mandate: MandateAccount,
): Promise<RevokeResult> {
  const tokenProgram = await tokenProgramOfMint(client, new PublicKey(mandate.mint));
  const ix = revokeMandateInstruction({
    programId: client.programId,
    owner,
    mandate: new PublicKey(mandate.address),
    source: new PublicKey(mandate.source),
    tokenProgram,
  });
  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(ix);

  const [signature] = await signAndSend([tx]);
  if (!signature) {
    throw new Error('wallet returned no signature');
  }
  await confirmSignature(client.connection, signature, latest.blockhash, latest.lastValidBlockHeight);
  const next = await fetchMandate(client, new PublicKey(mandate.address));
  return { signature, mandate: next };
}

export async function closeMandate(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  mandate: MandateAccount,
): Promise<CloseResult> {
  const live = await fetchMandate(client, new PublicKey(mandate.address));
  if (!owner.equals(new PublicKey(live.owner))) {
    throw new Error('Only the owner can close this rule.');
  }

  const mint = new PublicKey(live.mint);
  const source = new PublicKey(live.source);
  const mandateKey = new PublicKey(live.address);
  const mintInfo = await client.connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) {
    throw new Error(`mint ${mint.toBase58()} was not found on chain`);
  }
  const tokenProgram = mintInfo.owner;
  const kind = await classifyRuleSource({
    owner,
    mandateId: live.mandateId,
    mint,
    tokenProgram,
    source,
  });

  const instructions: TransactionInstruction[] = [];
  const sourceInfo = await client.connection.getAccountInfo(source, 'confirmed');
  if (live.status === STATUS_ACTIVE && !sourceInfo) {
    throw new Error(
      `The token account ${source.toBase58()} is not on chain, so this active rule cannot be revoked and closed.`,
    );
  }
  if (live.status === STATUS_ACTIVE) {
    instructions.push(
      revokeMandateInstruction({
        programId: client.programId,
        owner,
        mandate: mandateKey,
        source,
        tokenProgram,
      }),
    );
  }

  if (kind === 'dedicated' && sourceInfo) {
    const amount = readTokenAmount(sourceInfo.data);
    if (amount === null) {
      throw new Error('The rule token account could not be read, so nothing was submitted.');
    }
    if (amount > 0n) {
      const decimals = readMintDecimals(mintInfo.data);
      const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
      const ataInfo = await client.connection.getAccountInfo(ata, 'confirmed');
      if (!ataInfo) {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, tokenProgram),
        );
      }
      instructions.push(
        createTransferCheckedInstruction(source, mint, ata, owner, amount, decimals, [], tokenProgram),
      );
    }
    instructions.push(createCloseAccountInstruction(source, owner, owner, [], tokenProgram));
  }

  instructions.push(
    closeMandateInstruction({
      programId: client.programId,
      owner,
      mandate: mandateKey,
    }),
  );

  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(...instructions);

  const [signature] = await signAndSend([tx]);
  if (!signature) {
    throw new Error('wallet returned no signature');
  }
  await confirmSignature(client.connection, signature, latest.blockhash, latest.lastValidBlockHeight);
  return { signature };
}

function unixNowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export async function probeOverride(
  client: ChainClient,
  mandateAddress: PublicKey,
  row: LedgerRow,
  decimals: number,
  nowSec: bigint = unixNowSec(),
): Promise<OverrideAssessment> {
  const live = await fetchMandate(client, mandateAddress);
  return assessOverride({ row, mandate: live, decimals, nowSec });
}

export async function grantOverride(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  mandate: MandateAccount,
  row: LedgerRow,
  decimals: number,
): Promise<GrantOverrideResult> {
  const live = await fetchMandate(client, new PublicKey(mandate.address));
  const assessment = assessOverride({
    row,
    mandate: live,
    decimals,
    nowSec: unixNowSec(),
  });
  if (assessment.status !== 'ready') {
    throw new Error(assessment.why);
  }

  const tokenProgram = await tokenProgramOfMint(client, new PublicKey(live.mint));
  const ix = grantOverrideInstruction({
    programId: client.programId,
    owner,
    mandate: new PublicKey(live.address),
    source: new PublicKey(live.source),
    tokenProgram,
    amount: assessment.amount,
    nonce: assessment.nonce,
  });
  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(ix);

  const [signature] = await signAndSend([tx]);
  if (!signature) {
    throw new Error('wallet returned no signature');
  }
  await confirmSignature(client.connection, signature, latest.blockhash, latest.lastValidBlockHeight);

  const next = await fetchMandate(client, new PublicKey(live.address));
  const ledger = await fetchLedgerRows(client, new PublicKey(live.address));
  const confirmed =
    ledger.rows.find((item) => item.kind === KIND_OVERRIDE && item.signature === signature) ??
    ledger.rows
      .filter(
        (item) =>
          item.kind === KIND_OVERRIDE &&
          item.nonce === assessment.nonce &&
          item.amount === assessment.amount,
      )
      .at(-1);
  if (!confirmed) {
    throw new Error(
      'The transaction confirmed, but the ledger does not yet show an override row. Pull to retry. This screen will not invent one.',
    );
  }
  return { signature, mandate: next, row: confirmed };
}

function instructionData(data: string | Uint8Array | number[] | Buffer): Uint8Array {
  if (typeof data === 'string') {
    try {
      return Buffer.from(data, 'base64');
    } catch {
      return new Uint8Array();
    }
  }
  return Uint8Array.from(data);
}

export function decisionsFromTx(
  signature: string,
  tx: VersionedTransactionResponse,
  programId: string,
): DecodedTxDecision[] {
  const logs = tx.meta?.logMessages ?? [];
  const fromEvents = decodeEventsFromLogs(signature, logs);
  if (fromEvents.length > 0) {
    return fromEvents;
  }

  const message = tx.transaction.message;
  const keys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const compiled =
    'compiledInstructions' in message
      ? message.compiledInstructions
      : (message as unknown as { instructions?: Array<{ programIdIndex: number; data: string }> })
          .instructions ?? [];

  const out: DecodedTxDecision[] = [];
  for (const ix of compiled) {
    const program = keys.get(ix.programIdIndex);
    if (!program || program.toBase58() !== programId) {
      continue;
    }
    const data =
      'data' in ix && ix.data !== undefined ? instructionData(ix.data as string | Uint8Array) : new Uint8Array();
    const decoded = decodeInstructionKind(signature, data);
    if (decoded && (decoded.kind === KIND_OPENED || decoded.kind === KIND_REVOKED || decoded.kind === KIND_OVERRIDE)) {
      out.push(decoded);
    }
  }
  return out;
}

export async function fetchLedgerRows(
  client: ChainClient,
  mandate: PublicKey,
): Promise<{ snapshot: LedgerSnapshot; rows: LedgerRow[] }> {
  const snapshot = await fetchLedger(client, mandate);
  const ledgerAddress = new PublicKey(snapshot.address);
  let signatures: ConfirmedSignatureInfo[];
  try {
    signatures = await listSignatures(client, ledgerAddress, 4);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list ledger signatures: ${detail}`);
  }

  const decoded: DecodedTxDecision[] = [];
  const ok = signatures.filter((info) => !info.err);
  if (ok.length === 0) {
    return { snapshot, rows: attachSignatures(snapshot.entries, decoded) };
  }

  const chunkSize = 10;
  for (let i = 0; i < ok.length; i += chunkSize) {
    const chunk = ok.slice(i, i + chunkSize);
    const bodies = await Promise.all(
      chunk.map((info) =>
        client.connection
          .getTransaction(info.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          })
          .catch(() => null),
      ),
    );
    for (let j = 0; j < chunk.length; j++) {
      const tx = bodies[j];
      const info = chunk[j];
      if (!tx || !info) {
        continue;
      }
      const blockTime = info.blockTime ?? tx.blockTime ?? null;
      decoded.push(
        ...decisionsFromTx(info.signature, tx, client.programId.toBase58()).map((decision) => ({
          ...decision,
          blockTime,
          slot: info.slot,
        })),
      );
    }
  }

  return { snapshot, rows: attachSignatures(snapshot.entries, decoded) };
}

export async function listSignatures(
  client: ChainClient,
  address: PublicKey,
  maxPages = 4,
): Promise<ConfirmedSignatureInfo[]> {
  const out: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  const pages = Math.max(1, maxPages);
  for (let page = 0; page < pages; page++) {
    const batch = await client.connection.getSignaturesForAddress(
      address,
      { limit: 50, before },
      'confirmed',
    );
    if (batch.length === 0) {
      break;
    }
    out.push(...batch);
    if (batch.length < 50) {
      break;
    }
    const last = batch[batch.length - 1];
    if (!last) {
      break;
    }
    before = last.signature;
  }
  return out;
}

export async function fetchGenesisHash(client: ChainClient): Promise<string> {
  return client.connection.getGenesisHash();
}
