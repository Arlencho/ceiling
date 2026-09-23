import type { Connection, ConfirmedSignatureInfo, VersionedTransactionResponse } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { decisionLogTruncated, decodeEventsFromLogs, decodeIxData, decisionsFromTx } from "./events.js";
import {
  clampPageSize,
  createFailoverConnection,
  asTransportError,
  isSkippableSlot,
  isTransportError,
  isUnavailableBlock,
  ListedBlockMissingError,
  ListedTransactionMissingError,
  parseRpcList,
  withRetry,
} from "./rpc.js";
import type { CompiledIx, Decision, FetchHistoryOptions, SignaturePage, TxView } from "./types.js";

export type HistoryResult = {
  decisions: Decision[];
  signaturePages: number;
  signatureCount: number;
  usedBlockScan: boolean;
  slotsScanned: number;
  // getTransaction results for the signatures this walk actually fetched.
  // A date_range verify hands them to the row checks instead of fetching again.
  transactions: Map<string, VersionedTransactionResponse | null>;
  // Signatures whose log ends in the runtime's "Log truncated" line.
  // An empty decision list for one of these is not "no decision".
  truncated: string[];
};

type TimeWindow = {
  from: number | null;
  to: number | null;
};

type MessageLike = {
  staticAccountKeys?: PublicKey[];
  accountKeys?: Array<PublicKey | string>;
  compiledInstructions?: {
    programIdIndex: number;
    accountKeyIndexes: number[];
    data: Uint8Array;
  }[];
  instructions?: { programIdIndex: number; accounts: number[]; data: string }[];
};

type MetaLike = {
  err?: unknown;
  logMessages?: string[] | null;
  loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] };
} | null;

export async function fetchDecisionHistory(opts: FetchHistoryOptions): Promise<HistoryResult> {
  const connection = opts.connection ?? connectionFromRpc(opts.rpcUrl);
  if (!opts.programId || opts.programId.length === 0) {
    throw new Error(
      "history.fetchDecisionHistory: missing programId; set VETO_PROGRAM_ID in the environment, keys/devnet-addresses.env, or indexer/.env",
    );
  }
  const programId = new PublicKey(opts.programId);
  const pageSize = clampPageSize(opts.pageSize);
  const allowBlockScan = opts.allowBlockScan !== false;
  const window: TimeWindow = { from: opts.from ?? null, to: opts.to ?? null };

  const listed = await listProgramSignatures(connection, programId, pageSize, window);
  let usedBlockScan = false;
  let slotsScanned = 0;
  let txViews: TxView[] = [];
  const transactions = new Map<string, VersionedTransactionResponse | null>();

  if (listed.items.length > 0) {
    txViews = await fetchTransactions(connection, listed.items, window, transactions);
  } else if (allowBlockScan && listed.pageCount === 0) {
    usedBlockScan = true;
    const scanned = await scanBlocksForProgram(connection, programId, {
      pageSize,
      maxSlots: opts.maxSlots ?? 50_000,
    });
    txViews = scanned.txs;
    slotsScanned = scanned.slotsScanned;
  }

  const decisions: Decision[] = [];
  const truncated: string[] = [];
  for (const tx of txViews) {
    const found = decisionsFromTx(tx, programId.toBase58(), opts.mandate);
    if (decisionLogTruncated(found)) truncated.push(tx.signature);
    decisions.push(...found);
  }
  decisions.sort(compareDecisions);
  truncated.sort();
  return {
    decisions,
    signaturePages: listed.pageCount,
    signatureCount: listed.items.length,
    usedBlockScan,
    slotsScanned,
    transactions,
    truncated,
  };
}

function connectionFromRpc(rpcUrl: string): Connection {
  const endpoints = parseRpcList(rpcUrl);
  if (endpoints.length === 0) throw new Error("no rpc endpoints configured");
  return createFailoverConnection(endpoints);
}

export async function listProgramSignatures(
  connection: Connection,
  programId: PublicKey,
  pageSize: number,
  window?: TimeWindow,
): Promise<{ items: SignaturePage[]; pageCount: number }> {
  const from = window?.from ?? null;
  const to = window?.to ?? null;
  const items: SignaturePage[] = [];
  let pageCount = 0;
  let before: string | undefined;
  for (;;) {
    const batch = await withRetry("getSignaturesForAddress", () =>
      connection.getSignaturesForAddress(programId, {
        limit: pageSize,
        before,
      }),
    );
    if (batch.length === 0) break;
    pageCount += 1;
    let crossedFrom = false;
    for (const item of batch) {
      const page = toPage(item);
      // Newest-first. Once a signature is older than `from`, the rest of this
      // page and every later page are older too.
      if (from !== null && page.blockTime !== null && page.blockTime < from) {
        crossedFrom = true;
        break;
      }
      if (to !== null && page.blockTime !== null && page.blockTime > to) continue;
      items.push(page);
    }
    if (crossedFrom) break;
    if (batch.length < pageSize) break;
    const last = batch[batch.length - 1];
    if (!last) break;
    before = last.signature;
  }
  return { items, pageCount };
}

function outsideWindow(blockTime: number | null, window: TimeWindow): boolean {
  if (blockTime === null) return false;
  if (window.from !== null && blockTime < window.from) return true;
  if (window.to !== null && blockTime > window.to) return true;
  return false;
}

async function fetchTransactions(
  connection: Connection,
  pages: SignaturePage[],
  window: TimeWindow,
  fetched: Map<string, VersionedTransactionResponse | null>,
): Promise<TxView[]> {
  const views: TxView[] = [];
  const missing: string[] = [];
  for (const page of pages) {
    if (page.err) continue;
    if (outsideWindow(page.blockTime, window)) continue;
    const tx = await withRetry(`getTransaction ${page.signature.slice(0, 8)}`, () =>
      connection.getTransaction(page.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    );
    fetched.set(page.signature, tx);
    if (!tx) {
      missing.push(page.signature);
      continue;
    }
    const view = txToView(tx, page.signature, page.slot);
    if (view) views.push(view);
  }
  if (missing.length > 0) {
    missing.sort();
    throw new ListedTransactionMissingError(missing);
  }
  return views;
}

async function scanBlocksForProgram(
  connection: Connection,
  programId: PublicKey,
  opts: { pageSize: number; maxSlots: number },
): Promise<{ txs: TxView[]; slotsScanned: number }> {
  const program = programId.toBase58();
  const latest = await withRetry("getSlot", () => connection.getSlot("confirmed"));
  const first = await withRetry("getFirstAvailableBlock", () => connection.getFirstAvailableBlock());
  const end = latest;
  const start = Math.max(first, end - opts.maxSlots + 1);
  const txs: TxView[] = [];
  let slotsScanned = 0;
  const step = Math.max(opts.pageSize, 25);

  for (let rangeEnd = end; rangeEnd >= start; rangeEnd -= step) {
    const rangeStart = Math.max(start, rangeEnd - step + 1);
    let slots: number[] = [];
    try {
      slots = await withRetry("getBlocks", () => connection.getBlocks(rangeStart, rangeEnd));
    } catch (err) {
      if (isSkippableSlot(err)) continue;
      if (isUnavailableBlock(err) || isTransportError(err)) throw asTransportError(err);
      throw err;
    }
    for (const slot of slots) {
      slotsScanned += 1;
      let block;
      try {
        block = await withRetry(`getBlock ${slot}`, () =>
          connection.getBlock(slot, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
            transactionDetails: "full",
            rewards: false,
          }),
        );
      } catch (err) {
        if (isSkippableSlot(err)) continue;
        if (isUnavailableBlock(err) || isTransportError(err)) throw asTransportError(err);
        throw err;
      }
      // getBlocks listed this slot. A null getBlock is not a skipped slot and
      // not an empty block. Same class as a listed signature whose
      // getTransaction answers null.
      if (!block) throw new ListedBlockMissingError([slot]);
      for (const item of block.transactions) {
        const view = txPartsToView({
          signature: item.transaction.signatures[0] ?? "",
          slot,
          blockTime: block.blockTime ?? null,
          message: item.transaction.message as MessageLike,
          meta: item.meta as MetaLike,
        });
        if (!view) continue;
        if (!view.accountKeys.includes(program)) continue;
        if (decodeEventsFromLogs(view.logs, program).length > 0) txs.push(view);
      }
    }
  }
  return { txs, slotsScanned };
}

function toPage(item: ConfirmedSignatureInfo): SignaturePage {
  return {
    signature: item.signature,
    slot: item.slot,
    blockTime: item.blockTime ?? null,
    err: item.err,
  };
}

function txToView(tx: VersionedTransactionResponse, signature: string, slot: number): TxView | null {
  return txPartsToView({
    signature,
    slot: tx.slot ?? slot,
    blockTime: tx.blockTime ?? null,
    message: tx.transaction.message as MessageLike,
    meta: tx.meta as MetaLike,
  });
}

function txPartsToView(args: {
  signature: string;
  slot: number;
  blockTime: number | null;
  message: MessageLike;
  meta: MetaLike;
}): TxView | null {
  if (!args.signature) return null;
  const staticKeys = (args.message.staticAccountKeys ?? args.message.accountKeys ?? []).map((k) =>
    typeof k === "string" ? k : k.toBase58(),
  );
  const loadedWritable = args.meta?.loadedAddresses?.writable.map((k) => k.toBase58()) ?? [];
  const loadedReadonly = args.meta?.loadedAddresses?.readonly.map((k) => k.toBase58()) ?? [];
  const keys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
  const compiled = (args.message.compiledInstructions ?? []).map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accountKeyIndexes: ix.accountKeyIndexes,
    data: Buffer.from(ix.data),
  }));
  const legacy = (args.message.instructions ?? []).map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accountKeyIndexes: ix.accounts,
    data: decodeIxData(ix.data),
  }));
  return compiledToView({
    signature: args.signature,
    slot: args.slot,
    blockTime: args.blockTime,
    err: args.meta?.err ?? null,
    logs: args.meta?.logMessages ?? [],
    keys,
    compiled: compiled.length > 0 ? compiled : legacy,
  });
}

function compiledToView(args: {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  logs: string[];
  keys: string[];
  compiled: { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer }[];
}): TxView {
  const instructions: CompiledIx[] = args.compiled.map((ix) => ({
    programId: args.keys[ix.programIdIndex] ?? "",
    accounts: ix.accountKeyIndexes.map((i) => args.keys[i] ?? ""),
    data: ix.data,
  }));
  return {
    signature: args.signature,
    slot: args.slot,
    blockTime: args.blockTime,
    err: args.err,
    logs: args.logs,
    accountKeys: args.keys,
    instructions,
  };
}

function compareDecisions(a: Decision, b: Decision): number {
  const ta = a.timestamp ?? 0;
  const tb = b.timestamp ?? 0;
  if (ta !== tb) return ta - tb;
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1;
  return a.signature.localeCompare(b.signature);
}

export async function fetchLedgerBytes(
  rpcUrl: string,
  address: string,
): Promise<Buffer> {
  const endpoints = parseRpcList(rpcUrl);
  if (endpoints.length === 0) throw new Error("no rpc endpoints configured");
  const connection = createFailoverConnection(endpoints);
  const info = await withRetry(`getAccountInfo ${address}`, () =>
    connection.getAccountInfo(new PublicKey(address), "confirmed"),
  );
  if (!info) throw new Error(`ledger account ${address} not found`);
  return Buffer.from(info.data);
}
