import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "./constants.js";
import { decodeEventsFromLogs, decodeIxData, decisionsFromTx } from "./events.js";
import { clampPageSize, isSkippableSlot, paginateNewestFirst, withRetry } from "./rpc.js";
import type { CompiledIx, Decision, FetchHistoryOptions, SignaturePage, TxView } from "./types.js";

export type HistoryResult = {
  decisions: Decision[];
  signaturePages: number;
  signatureCount: number;
  usedBlockScan: boolean;
  slotsScanned: number;
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
  const connection = new Connection(opts.rpcUrl, "confirmed");
  const programId = new PublicKey(opts.programId ?? DEFAULT_PROGRAM_ID);
  const pageSize = clampPageSize(opts.pageSize);
  const allowBlockScan = opts.allowBlockScan !== false;

  const listed = await listProgramSignatures(connection, programId, pageSize);
  let usedBlockScan = false;
  let slotsScanned = 0;
  let txViews: TxView[] = [];

  if (listed.items.length > 0) {
    txViews = await fetchTransactions(connection, listed.items);
  } else if (allowBlockScan) {
    usedBlockScan = true;
    const scanned = await scanBlocksForProgram(connection, programId, {
      pageSize,
      maxSlots: opts.maxSlots ?? 50_000,
    });
    txViews = scanned.txs;
    slotsScanned = scanned.slotsScanned;
  }

  const decisions: Decision[] = [];
  for (const tx of txViews) {
    decisions.push(...decisionsFromTx(tx, programId.toBase58(), opts.mandate));
  }
  decisions.sort(compareDecisions);
  return {
    decisions,
    signaturePages: listed.pageCount,
    signatureCount: listed.items.length,
    usedBlockScan,
    slotsScanned,
  };
}

export async function listProgramSignatures(
  connection: Connection,
  programId: PublicKey,
  pageSize: number,
): Promise<{ items: SignaturePage[]; pageCount: number }> {
  const listed = await paginateNewestFirst(
    (before) =>
      withRetry("getSignaturesForAddress", () =>
        connection.getSignaturesForAddress(programId, {
          limit: pageSize,
          before,
        }),
      ),
    pageSize,
  );
  return {
    items: listed.items.map(toPage),
    pageCount: listed.pageCount,
  };
}

async function fetchTransactions(connection: Connection, pages: SignaturePage[]): Promise<TxView[]> {
  const views: TxView[] = [];
  for (const page of pages) {
    if (page.err) continue;
    const tx = await withRetry(`getTransaction ${page.signature.slice(0, 8)}`, () =>
      connection.getTransaction(page.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    );
    if (!tx) continue;
    const view = txToView(tx, page.signature, page.slot);
    if (view) views.push(view);
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
      if (!isSkippableSlot(err)) throw err;
      continue;
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
        throw err;
      }
      if (!block) continue;
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
        if (decodeEventsFromLogs(view.logs).length > 0) txs.push(view);
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
  const connection = new Connection(rpcUrl, "confirmed");
  const info = await withRetry(`getAccountInfo ${address}`, () =>
    connection.getAccountInfo(new PublicKey(address), "confirmed"),
  );
  if (!info) throw new Error(`ledger account ${address} not found`);
  return Buffer.from(info.data);
}
