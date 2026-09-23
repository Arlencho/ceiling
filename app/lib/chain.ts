import { Buffer } from 'buffer';
import { getAssociatedTokenAddressSync, getMint } from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  Transaction,
  type ConfirmedSignatureInfo,
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
  OPEN_FEE_MARGIN_LAMPORTS,
  PURPOSE_MAX_LEN,
} from './constants';
import { decodeEventsFromLogs, decodeInstructionKind } from './events';
import { grantOverrideInstruction, openMandateInstruction, revokeMandateInstruction } from './instructions';
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

// (account bytes + 128) * lamports per byte. This is devnet rent on 2026-09-23
// when the connection does not expose getMinimumBalanceForRentExemption.
const RENT_ACCOUNT_OVERHEAD = 128;
const RENT_LAMPORTS_PER_EXEMPT_BYTE = 5080;

export function rentExemptLamports(space: number): number {
  return (space + RENT_ACCOUNT_OVERHEAD) * RENT_LAMPORTS_PER_EXEMPT_BYTE;
}

async function rentForOpen(connection: Connection): Promise<number> {
  if (typeof connection.getMinimumBalanceForRentExemption === 'function') {
    const mandate = await connection.getMinimumBalanceForRentExemption(MANDATE_ACCOUNT_SIZE);
    const ledger = await connection.getMinimumBalanceForRentExemption(LEDGER_ACCOUNT_SIZE);
    return mandate + ledger;
  }
  return rentExemptLamports(MANDATE_ACCOUNT_SIZE) + rentExemptLamports(LEDGER_ACCOUNT_SIZE);
}

async function ownerLamports(connection: Connection, owner: PublicKey): Promise<number> {
  if (typeof connection.getBalance === 'function') {
    return connection.getBalance(owner, 'confirmed');
  }
  const info = await connection.getAccountInfo(owner, 'confirmed');
  return info?.lamports ?? 0;
}

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

  const mint = input.mint ?? (client.config.mint ? new PublicKey(client.config.mint) : null);
  if (!mint) {
    throw new Error(
      'Mint is missing from config. Set EXPO_PUBLIC_VETO_MINT as documented in app/README.md.',
    );
  }

  const tokenProgram = await tokenProgramOfMint(client, mint);
  const source = getAssociatedTokenAddressSync(mint, input.owner, false, tokenProgram);
  const sourceInfo = await client.connection.getAccountInfo(source, 'confirmed');
  if (!sourceInfo) {
    throw new Error(
      `The owner holds none of mint ${mint.toBase58()}. This app will not create a token account for it. The rule spends tokens the owner already holds.`,
    );
  }

  const rent = await rentForOpen(client.connection);
  const needed = rent + OPEN_FEE_MARGIN_LAMPORTS;
  const balance = await ownerLamports(client.connection, input.owner);
  if (balance < needed) {
    throw new Error(
      `Opening a rule creates two accounts, the mandate and the ledger. Rent is ${rent} lamports plus a ${OPEN_FEE_MARGIN_LAMPORTS} lamport fee margin, so this wallet needs ${needed} lamports. It has ${balance} lamports.`,
    );
  }

  let mandateId = BigInt(Date.now());
  let mandatePk = mandatePda(client.programId, input.owner, mandateId);
  for (let i = 0; i < 8; i++) {
    const existing = await client.connection.getAccountInfo(mandatePk, 'confirmed');
    if (!existing) {
      break;
    }
    mandateId += 1n;
    mandatePk = mandatePda(client.programId, input.owner, mandateId);
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (input.expiresAt <= now) {
    throw new Error('expiry must be in the future');
  }

  const built = openMandateInstruction({
    programId: client.programId,
    owner: input.owner,
    agent: input.agent,
    merchant: input.merchant,
    mint,
    source,
    tokenProgram,
    mandateId,
    cap: input.cap,
    perTxMax: input.perTxMax,
    expiresAt: input.expiresAt,
    purpose: input.purpose,
  });

  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = input.owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(built.instruction);

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
