import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { compareDecisions, decisionsFromTx, viewFromRpc, type Decision, type RpcTransaction } from "./events.js";
import { PROGRAM_ID } from "./idl.js";
import {
  decodeLedger,
  decodeMandate,
  toPublicKey,
  type LedgerAccount,
  type MandateAccount,
} from "./layout.js";

export type { Decision, LedgerAccount, MandateAccount };

const PAGE_MAX = 1000;

async function accountData(
  connection: Connection,
  address: PublicKey,
  what: string,
  programId: PublicKey,
): Promise<Buffer> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`${what}: account not found: ${address.toBase58()}`);
  if (!info.owner.equals(programId)) {
    throw new Error(`${what}: ${address.toBase58()} is not owned by the Veto program`);
  }
  return Buffer.from(info.data);
}

export async function fetchMandate(
  connection: Connection,
  address: PublicKey | string,
  programId: PublicKey | string = PROGRAM_ID,
): Promise<MandateAccount> {
  const key = toPublicKey(address, "fetchMandate");
  const owner = toPublicKey(programId, "fetchMandate programId");
  try {
    return decodeMandate(await accountData(connection, key, "fetchMandate", owner));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("fetchMandate:")) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`fetchMandate: ${message}`, { cause: err });
  }
}

export async function fetchLedger(
  connection: Connection,
  address: PublicKey | string,
  programId: PublicKey | string = PROGRAM_ID,
): Promise<LedgerAccount> {
  const key = toPublicKey(address, "fetchLedger");
  const owner = toPublicKey(programId, "fetchLedger programId");
  try {
    return decodeLedger(await accountData(connection, key, "fetchLedger", owner));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("fetchLedger:")) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`fetchLedger: ${message}`, { cause: err });
  }
}

export type DecisionPage = {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
};

export type DecisionsForMandateOptions = {
  pageSize?: number;
  programId?: PublicKey | string;
  /** Newest decisions to take from this page. Defaults to the whole page. */
  limit?: number;
  /** Start at signatures older than this one. */
  before?: string;
  /** Stop before this signature. It, and anything older, is not read. */
  until?: string;
};

/**
 * Decisions whose transaction touched this mandate, from one signature page.
 * A Veto frame without its Program data event is not a decision.
 * Pass `before` as the oldest signature already read to fetch the next older page.
 */
export async function decisionsForMandate(
  connection: Connection,
  mandate: PublicKey | string,
  options?: DecisionsForMandateOptions,
): Promise<Decision[]> {
  const key = toPublicKey(mandate, "decisionsForMandate");
  const programId = options?.programId
    ? toPublicKey(options.programId, "decisionsForMandate programId").toBase58()
    : PROGRAM_ID.toBase58();
  const pageSize = clampPage(options?.pageSize);
  const limit = clampLimit(options?.limit);
  const before = signatureCursor(options?.before, "before");
  const until = signatureCursor(options?.until, "until");
  const pages = await listPage(connection, key, pageSize, before, until);
  const decisions: Decision[] = [];
  for (const page of pages) {
    if (decisions.length >= limit) break;
    if (page.err) continue;
    const tx = await connection.getTransaction(page.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;
    const view = viewFromRpc(tx as RpcTransaction, page);
    for (const decision of decisionsFromTx(view, programId, key.toBase58())) {
      if (decisions.length >= limit) break;
      decisions.push(decision);
    }
  }
  decisions.sort(compareDecisions);
  return decisions;
}

function clampPage(pageSize: number | undefined): number {
  if (pageSize === undefined) return PAGE_MAX;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_MAX) {
    throw new Error(`decisionsForMandate: pageSize must be an integer from 1 to ${PAGE_MAX}`);
  }
  return pageSize;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) {
    throw new Error(`decisionsForMandate: limit must be an integer from 1 to ${PAGE_MAX}`);
  }
  return limit;
}

function signatureCursor(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) {
    throw new Error(`decisionsForMandate: ${name} must be a signature`);
  }
  return value;
}

async function listPage(
  connection: Connection,
  mandate: PublicKey,
  pageSize: number,
  before: string | undefined,
  until: string | undefined,
): Promise<DecisionPage[]> {
  const batch = await connection.getSignaturesForAddress(mandate, { limit: pageSize, before, until });
  const items: DecisionPage[] = [];
  const seen = new Set<string>();
  for (const item of batch) {
    if (seen.has(item.signature)) continue;
    seen.add(item.signature);
    items.push({
      signature: item.signature,
      slot: item.slot,
      err: item.err,
      blockTime: item.blockTime ?? null,
    });
  }
  return items;
}
