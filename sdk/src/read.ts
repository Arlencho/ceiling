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
  /**
   * Newest decisions to take from this page, at most 1000.
   * Omit it to take every decision on the page. The last transaction included
   * is never split, so the result can be longer than `limit`.
   */
  limit?: number;
  /** Start at signatures older than this one. */
  before?: string;
  /** Stop before this signature. It, and anything older, is not read. */
  until?: string;
  /** Delay used between 429 retries. Tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * One signature page: the decisions (oldest first), the oldest signature on
 * the listing, and whether that listing filled the page.
 * `oldestSignature` and `pageFull` are set for a page of only failed or
 * foreign signatures. They are non-enumerable so an empty decision list still
 * compares equal to `[]`.
 */
export type MandateDecisions = Decision[] & {
  oldestSignature: string | null;
  pageFull: boolean;
};

/** getTransaction calls kept in flight for one page. */
export const DECISION_FETCH_CONCURRENCY = 4;
/** First wait after a 429, doubled after each retry. */
export const DECISION_FETCH_BACKOFF_MS = 200;
const DECISION_FETCH_ATTEMPTS = 4;

/**
 * Decisions whose transaction touched this mandate, from one signature page.
 * A Veto frame without its Program data event is not a decision.
 * Walk older history with `before` set to `oldestSignature` while `pageFull` is true.
 */
export async function decisionsForMandate(
  connection: Connection,
  mandate: PublicKey | string,
  options?: DecisionsForMandateOptions,
): Promise<MandateDecisions> {
  const key = toPublicKey(mandate, "decisionsForMandate");
  const programId = options?.programId
    ? toPublicKey(options.programId, "decisionsForMandate programId").toBase58()
    : PROGRAM_ID.toBase58();
  const pageSize = clampPage(options?.pageSize);
  const limit = clampLimit(options?.limit);
  const before = signatureCursor(options?.before, "before");
  const until = signatureCursor(options?.until, "until");
  const pause = options?.sleep ?? sleep;
  const listed = await listPage(connection, key, pageSize, before, until);
  const decisions: Decision[] = [];
  let index = 0;
  while (index < listed.items.length && decisions.length < limit) {
    const room = limit - decisions.length;
    const width = Math.min(DECISION_FETCH_CONCURRENCY, room);
    const batch: DecisionPage[] = [];
    while (index < listed.items.length && batch.length < width) {
      const page = listed.items[index];
      index += 1;
      if (!page || page.err) continue;
      batch.push(page);
    }
    if (batch.length === 0) break;
    const loaded = await Promise.all(batch.map((page) => readTransaction(connection, page.signature, pause)));
    for (let i = 0; i < batch.length; i += 1) {
      if (decisions.length >= limit) break;
      const page = batch[i];
      const tx = loaded[i];
      if (!page || !tx) continue;
      const view = viewFromRpc(tx, page);
      // Keep every decision of this transaction, even when that passes limit.
      decisions.push(...decisionsFromTx(view, programId, key.toBase58()));
    }
  }
  decisions.sort(compareDecisions);
  return stamp(decisions, listed.oldestSignature, listed.pageFull);
}

function stamp(decisions: Decision[], oldestSignature: string | null, pageFull: boolean): MandateDecisions {
  const page = decisions as MandateDecisions;
  Object.defineProperty(page, "oldestSignature", { value: oldestSignature, enumerable: false });
  Object.defineProperty(page, "pageFull", { value: pageFull, enumerable: false });
  return page;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rateLimited(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === 429) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|too many requests/i.test(message);
}

async function readTransaction(
  connection: Connection,
  signature: string,
  pause: (ms: number) => Promise<void>,
): Promise<RpcTransaction | null> {
  let delay = DECISION_FETCH_BACKOFF_MS;
  for (let attempt = 0; attempt < DECISION_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      return (tx as RpcTransaction | null) ?? null;
    } catch (err) {
      if (!rateLimited(err) || attempt === DECISION_FETCH_ATTEMPTS - 1) throw err;
      await pause(delay);
      delay *= 2;
    }
  }
  return null;
}

function clampPage(pageSize: number | undefined): number {
  if (pageSize === undefined) return PAGE_MAX;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_MAX) {
    throw new Error(`decisionsForMandate: pageSize must be an integer from 1 to ${PAGE_MAX}`);
  }
  return pageSize;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
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

type ListedPage = {
  items: DecisionPage[];
  pageFull: boolean;
  oldestSignature: string | null;
};

async function listPage(
  connection: Connection,
  mandate: PublicKey,
  pageSize: number,
  before: string | undefined,
  until: string | undefined,
): Promise<ListedPage> {
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
  const oldest = batch.length > 0 ? batch[batch.length - 1] : undefined;
  return {
    items,
    pageFull: batch.length === pageSize,
    oldestSignature: oldest ? oldest.signature : null,
  };
}
