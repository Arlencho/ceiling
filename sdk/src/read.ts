import { Connection, PublicKey, type ConnectionConfig } from "@solana/web3.js";
import { advisoryDecisionsFromTx, MEMO_PROGRAM_ID } from "./advisory.js";
import { compareDecisions, decisionsFromTx, viewFromRpc, type Decision, type RpcTransaction, type TxView } from "./events.js";
import { MANDATE_DISCRIMINATOR, PROGRAM_ID } from "./idl.js";
import {
  MANDATE_AGENT_OFFSET,
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
  /** Transaction reads kept in flight. Default is 1. */
  concurrency?: number;
  /**
   * Wait used for a 429 and for the gap between RPC reads. Tests pass a fake.
   * An injected wait receives the backoff ceiling. The built-in wait jitters inside that ceiling.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Connection used as given for these paced reads.
   * When this is set, connectionConfig is not applied.
   * Build it with disableRetryOnRateLimit so web3.js does not also retry a 429.
   */
  readConnection?: Connection;
  /**
   * Config merged onto the connection opened for these reads, at the caller's
   * endpoint and commitment, with disableRetryOnRateLimit set.
   * web3.js does not expose headers, fetch, middleware, or the http agent on
   * an existing Connection, so pass them here.
   */
  connectionConfig?: ConnectionConfig;
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

/** A listed signature whose getTransaction answer is null. The page is not returned short. */
export class MissingListedTransactionError extends Error {
  readonly signature: string;

  constructor(signature: string) {
    super(`decisionsForMandate: getTransaction returned null for listed signature ${signature}`);
    this.name = "MissingListedTransactionError";
    this.signature = signature;
  }
}

/** Transaction reads kept in flight for one page. One, so a page does not burst a per-method limit. */
export const DECISION_FETCH_CONCURRENCY = 1;
/** Gap between RPC reads on a connection this module opens. */
export const DECISION_FETCH_SPACING_MS = 1000;
/** First 429 ceiling, doubled after each retry. */
export const DECISION_FETCH_BACKOFF_MS = 200;
/** Highest 429 ceiling. */
export const DECISION_FETCH_BACKOFF_CAP_MS = 2000;
const DECISION_FETCH_ATTEMPTS = 4;

/**
 * Ceiling for attempt 0 is DECISION_FETCH_BACKOFF_MS, then doubled, then capped.
 * Pass `random` for equal jitter in `[ceil(ceiling / 2), ceiling]`.
 */
export function decisionFetchBackoffMs(attempt: number, random?: () => number): number {
  const ceiling = Math.min(DECISION_FETCH_BACKOFF_CAP_MS, DECISION_FETCH_BACKOFF_MS * 2 ** attempt);
  if (!random) return ceiling;
  const floor = Math.ceil(ceiling / 2);
  if (ceiling <= floor) return ceiling;
  const span = ceiling - floor;
  const rolled = Math.floor(random() * (span + 1));
  return floor + Math.min(span, rolled);
}

/**
 * Decisions whose transaction touched this mandate, from one signature page.
 * A Veto frame without its Program data event is not a decision.
 * An advisory memo is a decision only when it succeeded, the mandate's agent
 * signed it, it names that mandate, and it parses as veto-advisory:v1.
 * A stranger's memo is ignored and stays on the signature cursor.
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
  const concurrency = clampConcurrency(options?.concurrency);
  const pause = options?.sleep ?? sleep;
  const jitter = options?.sleep === undefined;
  const { rpc, spacingMs } = readsConnection(connection, options);
  let spaced = false;
  const pace = async (): Promise<void> => {
    if (spaced && spacingMs > 0) await pause(spacingMs);
    spaced = true;
  };
  await pace();
  const listed = await withRateLimitRetry(() => listPage(rpc, key, pageSize, before, until), pause, jitter);
  const decisions: Decision[] = [];
  let agentKey: string | null | undefined;
  const agentFor = async (view: TxView): Promise<string | null> => {
    if (!view.instructions.some((ix) => ix.programId === MEMO_PROGRAM_ID.toBase58())) return null;
    if (agentKey === undefined) {
      await pace();
      agentKey = await memoAgent(rpc, key, programId, pause, jitter);
    }
    return agentKey;
  };
  let index = 0;
  while (index < listed.items.length && decisions.length < limit) {
    const room = limit - decisions.length;
    const width = Math.min(concurrency, room);
    const batch: DecisionPage[] = [];
    while (index < listed.items.length && batch.length < width) {
      const page = listed.items[index];
      index += 1;
      if (!page || page.err) continue;
      batch.push(page);
    }
    if (batch.length === 0) break;
    await pace();
    const loaded = await Promise.all(batch.map((page) => readTransaction(rpc, page.signature, pause, jitter)));
    for (let i = 0; i < batch.length; i += 1) {
      if (decisions.length >= limit) break;
      const page = batch[i];
      const tx = loaded[i];
      if (!page || !tx) throw new MissingListedTransactionError(page?.signature ?? "unknown");
      const view = viewFromRpc(tx, page);
      const signer = await agentFor(view);
      const found = decisionsFromTx(view, programId, key.toBase58());
      if (signer) found.push(...advisoryDecisionsFromTx(view, key.toBase58(), signer));
      // Keep every decision of this transaction, even when that passes limit.
      decisions.push(...found);
    }
  }
  decisions.sort(compareDecisions);
  return stamp(decisions, listed.oldestSignature, listed.pageFull);
}

async function memoAgent(
  connection: Connection,
  mandate: PublicKey,
  programId: string,
  pause: (ms: number) => Promise<void>,
  jitter: boolean,
): Promise<string | null> {
  try {
    const account = await withRateLimitRetry(() => fetchMandate(connection, mandate, programId), pause, jitter);
    return account.agent.toBase58();
  } catch (err) {
    if (rateLimited(err)) throw err;
    return null;
  }
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

/**
 * Paced reads use a connection with disableRetryOnRateLimit so web3.js does not
 * also retry a 429. web3.js does not expose a connection's config.
 * readConnection is used as given. connectionConfig is merged onto a new
 * connection at the caller's endpoint and commitment. With neither, that
 * connection carries the endpoint and commitment only.
 * A value that is not a web3 Connection has no endpoint to rebuild, so it is used as given.
 */
function readsConnection(
  connection: Connection,
  options: DecisionsForMandateOptions | undefined,
): { rpc: Connection; spacingMs: number } {
  if (options?.readConnection) {
    const rpc = options.readConnection;
    return { rpc, spacingMs: rpc instanceof Connection ? DECISION_FETCH_SPACING_MS : 0 };
  }
  if (!(connection instanceof Connection)) {
    if (options?.connectionConfig !== undefined) {
      throw new Error("decisionsForMandate: connectionConfig requires a web3 Connection");
    }
    return { rpc: connection, spacingMs: 0 };
  }
  return {
    rpc: new Connection(connection.rpcEndpoint, {
      ...options?.connectionConfig,
      commitment: connection.commitment,
      disableRetryOnRateLimit: true,
    }),
    spacingMs: DECISION_FETCH_SPACING_MS,
  };
}

function rateLimited(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === 429) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|too many requests/i.test(message);
}

async function withRateLimitRetry<T>(
  run: () => Promise<T>,
  pause: (ms: number) => Promise<void>,
  jitter: boolean,
): Promise<T> {
  for (let attempt = 0; attempt < DECISION_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!rateLimited(err) || attempt === DECISION_FETCH_ATTEMPTS - 1) throw err;
      await pause(decisionFetchBackoffMs(attempt, jitter ? Math.random : undefined));
    }
  }
  throw new Error("decisionsForMandate: rate limit retries exhausted");
}

async function readTransaction(
  connection: Connection,
  signature: string,
  pause: (ms: number) => Promise<void>,
  jitter: boolean,
): Promise<RpcTransaction> {
  const tx = await withRateLimitRetry(
    () =>
      connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    pause,
    jitter,
  );
  if (!tx) throw new MissingListedTransactionError(signature);
  return tx as RpcTransaction;
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

function clampConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) return DECISION_FETCH_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > PAGE_MAX) {
    throw new Error(`decisionsForMandate: concurrency must be an integer from 1 to ${PAGE_MAX}`);
  }
  return concurrency;
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

/** A decoded mandate plus the account address it was read from. */
export type AgentMandate = MandateAccount & {
  address: PublicKey;
};

/**
 * Mandate accounts whose agent field equals `agent`, newest mandate id first.
 * The chain filters are the mandate discriminator and a memcmp at MANDATE_AGENT_OFFSET.
 */
export async function mandatesForAgent(
  connection: Connection,
  agent: PublicKey | string,
): Promise<AgentMandate[]> {
  const agentKey = toPublicKey(agent, "mandatesForAgent agent");
  const rows = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: MANDATE_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
      {
        memcmp: {
          offset: MANDATE_AGENT_OFFSET,
          bytes: agentKey.toBase58(),
        },
      },
    ],
  });
  const found: AgentMandate[] = [];
  for (const row of rows) {
    const data = row.account.data;
    if (!(data instanceof Uint8Array)) {
      throw new Error(`mandatesForAgent: account ${row.pubkey.toBase58()} data was not bytes`);
    }
    const mandate = decodeMandate(Buffer.from(data));
    found.push({ ...mandate, address: row.pubkey });
  }
  found.sort((a, b) => {
    if (a.mandateId === b.mandateId) return 0;
    return a.mandateId > b.mandateId ? -1 : 1;
  });
  return found;
}
