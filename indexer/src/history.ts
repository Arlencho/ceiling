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
  ListedLogBodyMissingError,
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
  addressTableLookups?: readonly unknown[] | null;
  version?: unknown;
};

type InnerIxLike = { programIdIndex: number };

type LoadedAddresses = {
  writable?: readonly (PublicKey | string)[];
  readonly?: readonly (PublicKey | string)[];
};

type MetaLike = {
  err?: unknown;
  logMessages?: string[] | null;
  loadedAddresses?: LoadedAddresses | null;
  innerInstructions?: Array<{ instructions?: InnerIxLike[] }> | null;
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
    txViews = await fetchTransactions(connection, listed.items, window, transactions, programId.toBase58());
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
  programId: string,
): Promise<TxView[]> {
  const views: TxView[] = [];
  const missing: string[] = [];
  const nullLogs: string[] = [];
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
    const message = tx.transaction.message as MessageLike;
    const meta = tx.meta as MetaLike;
    const version = (tx as { version?: unknown }).version;
    // A missing log body is not an empty log. null, an omitted key, and a
    // null meta are the same gap. A CPI payment is only in that body.
    // Listed for the program: keys that omit it, and do not cover a declared
    // lookup table, are a contradiction beside that missing body.
    if (nullLogBodyInvokesProgram(message, meta, programId, { version, listed: true })) {
      nullLogs.push(page.signature);
      continue;
    }
    const view = txToView(tx, page.signature, page.slot, programId);
    if (view) views.push(view);
  }
  if (nullLogs.length > 0) {
    nullLogs.sort();
    throw new ListedLogBodyMissingError(nullLogs);
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
        const signature = item.transaction.signatures[0] ?? "";
        const message = item.transaction.message as MessageLike;
        const meta = item.meta as MetaLike;
        const version = (item as { version?: unknown }).version;
        if (signature && nullLogBodyInvokesProgram(message, meta, program, { version, listed: false })) {
          throw new ListedLogBodyMissingError([signature]);
        }
        const view = txPartsToView({
          signature,
          slot,
          blockTime: block.blockTime ?? null,
          message,
          meta,
          program,
          version,
          listed: false,
        });
        if (!view) continue;
        // The runtime invoke frame attributes the log, including when a
        // lookup-table index is still unresolved.
        if (decodeEventsFromLogs(view.logs, program).length > 0) txs.push(view);
      }
    }
  }
  return { txs, slotsScanned };
}

function keyText(key: PublicKey | string): string {
  return typeof key === "string" ? key : key.toBase58();
}

function loadedKeyTexts(keys: readonly (PublicKey | string)[] | undefined): string[] {
  if (!Array.isArray(keys)) return [];
  return keys.map((key) => keyText(key));
}

function accountKeyList(message: MessageLike, meta: MetaLike): string[] {
  const staticKeys = (message.staticAccountKeys ?? message.accountKeys ?? []).map((key) => keyText(key));
  return [
    ...staticKeys,
    ...loadedKeyTexts(meta?.loadedAddresses?.writable),
    ...loadedKeyTexts(meta?.loadedAddresses?.readonly),
  ];
}

// Static keys, then one slot per address the lookup tables declare.
// A loaded set shorter than this is unresolved wherever the missing entry sits.
function declaredAccountCount(message: MessageLike): number {
  const staticCount = (message.staticAccountKeys ?? message.accountKeys ?? []).length;
  const lookups = message.addressTableLookups;
  if (!Array.isArray(lookups)) return staticCount;
  let loaded = 0;
  for (const lookup of lookups) {
    if (!lookup || typeof lookup !== "object") continue;
    const row = lookup as { writableIndexes?: unknown; readonlyIndexes?: unknown };
    if (Array.isArray(row.writableIndexes)) loaded += row.writableIndexes.length;
    if (Array.isArray(row.readonlyIndexes)) loaded += row.readonlyIndexes.length;
  }
  return staticCount + loaded;
}

function transactionInvokesProgram(message: MessageLike, meta: MetaLike, program: string): boolean {
  const keys = accountKeyList(message, meta);
  const compiled = message.compiledInstructions ?? [];
  const legacy = message.instructions ?? [];
  const top = compiled.length > 0 ? compiled : legacy;
  for (const ix of top) {
    if ((keys[ix.programIdIndex] ?? "") === program) return true;
  }
  // A null or absent CPI list is not an empty one. Recording off drops this
  // list and the log body together, so it cannot prove the program was not
  // invoked.
  if (!meta || !Array.isArray(meta.innerInstructions)) return false;
  for (const group of meta.innerInstructions) {
    for (const ix of group.instructions ?? []) {
      if ((keys[ix.programIdIndex] ?? "") === program) return true;
    }
  }
  return false;
}

function listsProgram(message: MessageLike, meta: MetaLike, program: string): boolean {
  return accountKeyList(message, meta).includes(program);
}

// The response carries version. A MessageV0 instance also exposes it. Legacy
// JSON does not, and it uses accountKeys rather than staticAccountKeys.
function version0Message(message: MessageLike, version: unknown): boolean {
  if (version === "legacy" || message.version === "legacy") return false;
  if (version === 0 || message.version === 0) return true;
  return message.staticAccountKeys != null || message.compiledInstructions != null;
}

// Same gap as a short loaded set: the lookup list was not an array, so the
// loaded accounts are not resolved.
function version0LookupsUnresolved(message: MessageLike, version: unknown): boolean {
  return version0Message(message, version) && !Array.isArray(message.addressTableLookups);
}

// A declared lookup list whose loaded set covers every index is resolved.
// The program not appearing in that list is a checked absence. A missing
// list is not resolved: on a version 0 message the tables may have been
// stripped, and on a legacy message there is nowhere else for the program
// to have been.
function lookupListResolved(message: MessageLike, meta: MetaLike): boolean {
  if (!Array.isArray(message.addressTableLookups)) return false;
  return declaredAccountCount(message) <= accountKeyList(message, meta).length;
}

// When the log body is missing, a loaded set shorter than the addresses the
// message declares is unresolved, whether or not innerInstructions is present.
// A missing entry at the front, middle, or tail, or an empty set, is that gap.
// A programIdIndex at or past the resolved key list is the second net, for a
// message whose lookup list was stripped so the declared count falls back to
// the static keys.
function unresolvedProgramIndex(message: MessageLike, meta: MetaLike): boolean {
  const length = accountKeyList(message, meta).length;
  if (declaredAccountCount(message) > length) return true;
  const compiled = message.compiledInstructions ?? [];
  const legacy = message.instructions ?? [];
  const top = compiled.length > 0 ? compiled : legacy;
  for (const ix of top) {
    if (ix.programIdIndex >= length) return true;
  }
  if (meta && Array.isArray(meta.innerInstructions)) {
    for (const group of meta.innerInstructions) {
      for (const ix of group.instructions ?? []) {
        if (ix.programIdIndex >= length) return true;
      }
    }
  }
  return false;
}

// A log body is an array. null, an omitted key, and a null meta are the same
// missing body, and none of them is an empty log. An empty array is a log
// list that happened to be empty. A failed transaction stays out. When the
// CPI list is itself null or absent, a transaction that lists the program
// was not checked. An unresolved programIdIndex is the same gap: the
// invokes-the-program test cannot be answered. A version 0 message whose
// addressTableLookups is not an array is that same gap. On the listed path,
// a signature returned for the program whose resolved keys do not contain
// it is a contradiction unless that key list covers a declared lookup table.
function nullLogBodyInvokesProgram(
  message: MessageLike,
  meta: MetaLike,
  program: string,
  source?: { version?: unknown; listed?: boolean },
): boolean {
  if (meta?.err) return false;
  if (meta && Array.isArray(meta.logMessages)) return false;
  if (version0LookupsUnresolved(message, source?.version)) return true;
  if (unresolvedProgramIndex(message, meta)) return true;
  if (transactionInvokesProgram(message, meta, program)) return true;
  const innerMissing = !meta || !Array.isArray(meta.innerInstructions);
  if (innerMissing && listsProgram(message, meta, program)) return true;
  return source?.listed === true && !listsProgram(message, meta, program) && !lookupListResolved(message, meta);
}

function toPage(item: ConfirmedSignatureInfo): SignaturePage {
  return {
    signature: item.signature,
    slot: item.slot,
    blockTime: item.blockTime ?? null,
    err: item.err,
  };
}

function txToView(
  tx: VersionedTransactionResponse,
  signature: string,
  slot: number,
  program: string,
): TxView | null {
  const message = tx.transaction.message as MessageLike;
  return txPartsToView({
    signature,
    slot: tx.slot ?? slot,
    blockTime: tx.blockTime ?? null,
    message,
    meta: tx.meta as MetaLike,
    program,
    version: (tx as { version?: unknown }).version,
    listed: true,
  });
}

function txPartsToView(args: {
  signature: string;
  slot: number;
  blockTime: number | null;
  message: MessageLike;
  meta: MetaLike;
  program: string;
  version?: unknown;
  listed?: boolean;
}): TxView | null {
  if (!args.signature) return null;
  // The same gap as the guard. A missing log body must not become logs: [].
  if (nullLogBodyInvokesProgram(args.message, args.meta, args.program, { version: args.version, listed: args.listed })) {
    throw new ListedLogBodyMissingError([args.signature]);
  }
  if (!args.meta || !Array.isArray(args.meta.logMessages)) return null;
  const logs = args.meta.logMessages;
  const keys = accountKeyList(args.message, args.meta);
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
    err: args.meta.err ?? null,
    logs,
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
