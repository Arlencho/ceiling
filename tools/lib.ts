import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { createFailoverConnection, parseRpcList } from "./rpc.js";

export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = join(TOOLS_DIR, "..");
export const IDL_PATH = join(TOOLS_DIR, "idl", "veto.json");

export const DEFAULT_PROGRAM_ID = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
export const DEFAULT_PUBLIC_RPC = "https://api.devnet.solana.com";
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export const LEDGER_CAPACITY = 32;
export const KIND_PAID = 1;
export const KIND_REFUSED = 2;

export const CHARGE_DISCRIMINATOR = Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]);
export const MANDATE_DISCRIMINATOR = Buffer.from([113, 216, 98, 159, 185, 63, 55, 18]);
export const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);

export const REASON_TEXT: Record<number, string> = {
  0: "ok",
  1: "mandate not active",
  2: "past expiry",
  3: "nonce already settled",
  4: "merchant not allowed",
  5: "over per-payment maximum",
  6: "over remaining cap",
  7: "delegation withdrawn",
  8: "insufficient funds",
  9: "zero amount",
  10: "account frozen",
};

export function reasonText(code: number): string {
  return REASON_TEXT[code] ?? "unknown";
}

export function kindName(kind: number): "paid" | "refused" | null {
  if (kind === KIND_PAID) return "paid";
  if (kind === KIND_REFUSED) return "refused";
  return null;
}

export function kindByte(kind: string): number {
  if (kind === "paid") return KIND_PAID;
  if (kind === "refused") return KIND_REFUSED;
  throw new Error(`unknown kind: ${kind}`);
}

export type Limits = {
  cap: bigint;
  per_tx_max: bigint;
  expires_at: bigint;
  merchant: string;
  purpose: string;
};

export type DecisionRecord = {
  schema_version: number;
  cluster: string;
  genesis_hash: string;
  program_id: string;
  mandate: string;
  limits: Limits;
  kind: "paid" | "refused";
  amount: bigint;
  counterparty: string;
  timestamp: bigint;
  nonce: bigint;
  reason_code: number;
  reason_text: string;
  suggested_override: bigint;
  signature: string;
};

export type MandateAccount = {
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  source: PublicKey;
  merchant: PublicKey;
  mandateId: bigint;
  cap: bigint;
  spent: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  overrideAmount: bigint;
  overrideNonce: bigint;
  lastNonce: bigint;
  purpose: string;
  status: number;
  spendCount: number;
  refusalCount: number;
  bump: number;
};

export type LedgerEntry = {
  ts: bigint;
  amount: bigint;
  counterparty: PublicKey;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  reason: number;
};

export type LedgerAccount = {
  mandate: PublicKey;
  total: number;
  head: number;
  bump: number;
  entries: LedgerEntry[];
};

export type ChargeIx = {
  amount: bigint;
  nonce: bigint;
  agent: PublicKey;
  mandate: PublicKey;
  ledger: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  mint: PublicKey;
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function decodeBase58(str: string): Buffer {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  bytes.reverse();
  let leading = 0;
  for (const c of str) {
    if (c === "1") leading += 1;
    else break;
  }
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(bytes)]);
}

export type Cli = {
  flags: Record<string, string | boolean>;
  positional: string[];
};

export function parseArgs(argv: string[]): Cli {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

export function flagString(cli: Cli, name: string): string | undefined {
  const v = cli.flags[name];
  return typeof v === "string" ? v : undefined;
}

function parseEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return out;
}

export function addressesFile(repoRoot = REPO_DIR): Map<string, string> {
  return parseEnvFile(join(repoRoot, "keys", "devnet-addresses.env"));
}

export function resolveRpcList(cli?: Cli, repoRoot = REPO_DIR): string[] {
  const fromFlag = cli ? flagString(cli, "rpc") : undefined;
  if (fromFlag) {
    const listed = parseRpcList(fromFlag);
    if (listed.length > 0) return listed;
  }
  if (process.env.VETO_RPC && process.env.VETO_RPC.length > 0) {
    const listed = parseRpcList(process.env.VETO_RPC);
    if (listed.length > 0) return listed;
  }
  const fromFile = addressesFile(repoRoot).get("RPC");
  if (fromFile && fromFile.length > 0) {
    const listed = parseRpcList(fromFile);
    if (listed.length > 0) return listed;
  }
  return [DEFAULT_PUBLIC_RPC];
}

export function resolveRpc(cli?: Cli, repoRoot = REPO_DIR): string {
  return resolveRpcList(cli, repoRoot)[0]!;
}

export function resolveProgramId(repoRoot = REPO_DIR): PublicKey {
  if (process.env.VETO_PROGRAM_ID) return new PublicKey(process.env.VETO_PROGRAM_ID);
  const fromFile = addressesFile(repoRoot).get("PROGRAM_ID");
  if (fromFile) return new PublicKey(fromFile);
  return new PublicKey(DEFAULT_PROGRAM_ID);
}

export function resolveClusterName(repoRoot = REPO_DIR): string {
  if (process.env.VETO_CLUSTER && process.env.VETO_CLUSTER.length > 0) return process.env.VETO_CLUSTER;
  const fromFile = addressesFile(repoRoot).get("CLUSTER");
  if (fromFile && fromFile.length > 0) return fromFile;
  return "devnet";
}

export function keysDir(repoRoot = REPO_DIR): string {
  const fromEnv = process.env.VETO_KEYS_DIR;
  if (fromEnv && fromEnv.length > 0) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(repoRoot, fromEnv);
  }
  return join(repoRoot, "keys");
}

export function connection(rpc: string | readonly string[]): Connection {
  const list = typeof rpc === "string" ? parseRpcList(rpc) : [...rpc];
  const endpoints = list.length > 0 ? list : [DEFAULT_PUBLIC_RPC];
  return createFailoverConnection(endpoints);
}

export function u64Le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function mandatePda(programId: PublicKey, owner: PublicKey, mandateId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), owner.toBuffer(), u64Le(mandateId)],
    programId,
  );
  return pda;
}

export function ledgerPda(programId: PublicKey, mandate: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ledger"), mandate.toBuffer()],
    programId,
  );
  return pda;
}

function requireDisc(data: Buffer, expected: Buffer, what: string): void {
  if (data.length < expected.length || !data.subarray(0, expected.length).equals(expected)) {
    throw new Error(`${what} account discriminator mismatch`);
  }
}

function readPubkey(data: Buffer, offset: number): [PublicKey, number] {
  return [new PublicKey(data.subarray(offset, offset + 32)), offset + 32];
}

function readU64(data: Buffer, offset: number): [bigint, number] {
  return [data.readBigUInt64LE(offset), offset + 8];
}

function readI64(data: Buffer, offset: number): [bigint, number] {
  return [data.readBigInt64LE(offset), offset + 8];
}

function readU32(data: Buffer, offset: number): [number, number] {
  return [data.readUInt32LE(offset), offset + 4];
}

function readU8(data: Buffer, offset: number): [number, number] {
  return [data.readUInt8(offset), offset + 1];
}

function readString(data: Buffer, offset: number): [string, number] {
  const [len, mid] = readU32(data, offset);
  if (len > 64) throw new Error(`purpose longer than on-chain max (${len})`);
  const end = mid + len;
  if (end > data.length) throw new Error("purpose overruns account data");
  return [data.subarray(mid, end).toString("utf8"), end];
}

export function decodeMandate(data: Buffer): MandateAccount {
  requireDisc(data, MANDATE_DISCRIMINATOR, "Mandate");
  let o = 8;
  let owner: PublicKey,
    agent: PublicKey,
    mint: PublicKey,
    source: PublicKey,
    merchant: PublicKey;
  [owner, o] = readPubkey(data, o);
  [agent, o] = readPubkey(data, o);
  [mint, o] = readPubkey(data, o);
  [source, o] = readPubkey(data, o);
  [merchant, o] = readPubkey(data, o);
  let mandateId: bigint,
    cap: bigint,
    spent: bigint,
    perTxMax: bigint,
    expiresAt: bigint,
    overrideAmount: bigint,
    overrideNonce: bigint,
    lastNonce: bigint,
    purpose: string,
    status: number,
    spendCount: number,
    refusalCount: number,
    bump: number;
  [mandateId, o] = readU64(data, o);
  [cap, o] = readU64(data, o);
  [spent, o] = readU64(data, o);
  [perTxMax, o] = readU64(data, o);
  [expiresAt, o] = readI64(data, o);
  [overrideAmount, o] = readU64(data, o);
  [overrideNonce, o] = readU64(data, o);
  [lastNonce, o] = readU64(data, o);
  [purpose, o] = readString(data, o);
  [status, o] = readU8(data, o);
  [spendCount, o] = readU32(data, o);
  [refusalCount, o] = readU32(data, o);
  [bump, o] = readU8(data, o);
  return {
    owner,
    agent,
    mint,
    source,
    merchant,
    mandateId,
    cap,
    spent,
    perTxMax,
    expiresAt,
    overrideAmount,
    overrideNonce,
    lastNonce,
    purpose,
    status,
    spendCount,
    refusalCount,
    bump,
  };
}

function decodeEntry(data: Buffer, offset: number): LedgerEntry {
  const ts = data.readBigInt64LE(offset);
  const amount = data.readBigUInt64LE(offset + 8);
  const counterparty = new PublicKey(data.subarray(offset + 16, offset + 48));
  const nonce = data.readBigUInt64LE(offset + 48);
  const suggestedOverride = data.readBigUInt64LE(offset + 56);
  const kind = data.readUInt8(offset + 64);
  const reason = data.readUInt8(offset + 65);
  return { ts, amount, counterparty, nonce, suggestedOverride, kind, reason };
}

export function decodeLedger(data: Buffer): LedgerAccount {
  requireDisc(data, LEDGER_DISCRIMINATOR, "Ledger");
  const mandate = new PublicKey(data.subarray(8, 40));
  const total = data.readUInt32LE(40);
  const head = data.readUInt16LE(44);
  const bump = data.readUInt8(46);
  const entries: LedgerEntry[] = [];
  const base = 48;
  const entrySize = 72;
  for (let i = 0; i < LEDGER_CAPACITY; i += 1) {
    entries.push(decodeEntry(data, base + i * entrySize));
  }
  return { mandate, total, head, bump, entries };
}

export type IndexedEntry = {
  slot: number;
  sequence: number;
  entry: LedgerEntry;
};

export function indexedEntries(ledger: LedgerAccount): IndexedEntry[] {
  const n = Math.min(ledger.total, LEDGER_CAPACITY);
  const out: IndexedEntry[] = [];
  if (ledger.total <= LEDGER_CAPACITY) {
    for (let slot = 0; slot < n; slot += 1) {
      out.push({ slot, sequence: slot, entry: ledger.entries[slot]! });
    }
    return out;
  }
  for (let i = 0; i < LEDGER_CAPACITY; i += 1) {
    const slot = (ledger.head + i) % LEDGER_CAPACITY;
    const sequence = ledger.total - LEDGER_CAPACITY + i;
    out.push({ slot, sequence, entry: ledger.entries[slot]! });
  }
  return out;
}

export async function fetchMandate(conn: Connection, address: PublicKey): Promise<MandateAccount> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`mandate account not found: ${address.toBase58()}`);
  return decodeMandate(Buffer.from(info.data));
}

export async function fetchLedger(conn: Connection, address: PublicKey): Promise<LedgerAccount> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`ledger account not found: ${address.toBase58()}`);
  return decodeLedger(Buffer.from(info.data));
}

type RpcTx = {
  meta: {
    err: unknown;
    logMessages?: string[] | null;
  } | null;
  transaction: {
    message: {
      accountKeys?: Array<string | { pubkey: string } | PublicKey>;
      instructions?: Array<{
        programIdIndex: number;
        accounts: number[];
        data: string;
      }>;
      compiledInstructions?: Array<{
        programIdIndex: number;
        accountKeyIndexes: number[];
        data: Uint8Array | number[];
      }>;
      staticAccountKeys?: PublicKey[];
    };
  };
};

function flattenAccountKeys(tx: RpcTx, loaded?: { writable: PublicKey[]; readonly: PublicKey[] }): PublicKey[] {
  const msg = tx.transaction.message;
  if (Array.isArray(msg.accountKeys) && msg.accountKeys.length > 0) {
    return msg.accountKeys.map((k) => {
      if (k instanceof PublicKey) return k;
      if (typeof k === "string") return new PublicKey(k);
      return new PublicKey(k.pubkey);
    });
  }
  const staticKeys = msg.staticAccountKeys ?? [];
  return [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

export function parseChargeFromTx(
  tx: RpcTx & { meta?: { loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } } | null },
  programId: PublicKey,
): ChargeIx | null {
  const keys = flattenAccountKeys(tx, tx.meta?.loadedAddresses ?? undefined);
  const msg = tx.transaction.message;
  const compiled = msg.compiledInstructions;
  const legacy = msg.instructions;
  const ixs =
    compiled?.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accounts: ix.accountKeyIndexes,
      data: Buffer.from(ix.data),
    })) ??
    legacy?.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accounts: ix.accounts,
      data: decodeBase58(ix.data),
    })) ??
    [];

  for (const ix of ixs) {
    const pid = keys[ix.programIdIndex];
    if (!pid || !pid.equals(programId)) continue;
    if (ix.data.length < 24) continue;
    if (!ix.data.subarray(0, 8).equals(CHARGE_DISCRIMINATOR)) continue;
    if (ix.accounts.length < 7) {
      throw new Error("charge instruction has fewer than 7 accounts");
    }
    const amount = ix.data.readBigUInt64LE(8);
    const nonce = ix.data.readBigUInt64LE(16);
    const pick = (i: number): PublicKey => {
      const idx = ix.accounts[i];
      const key = keys[idx];
      if (!key) throw new Error(`charge account index ${idx} missing`);
      return key;
    };
    return {
      amount,
      nonce,
      agent: pick(0),
      mandate: pick(1),
      ledger: pick(2),
      source: pick(3),
      destination: pick(4),
      mint: pick(5),
    };
  }
  return null;
}

export function parseChargeLogs(logs: readonly string[]): {
  kind: "paid" | "refused";
  reasonCode: number;
  reasonText: string;
  amount: bigint;
  suggestedOverride: bigint;
} | null {
  for (const line of logs) {
    const paid = /VETO PAID amount=(\d+)/.exec(line);
    if (paid) {
      return {
        kind: "paid",
        reasonCode: 0,
        reasonText: "ok",
        amount: BigInt(paid[1]!),
        suggestedOverride: 0n,
      };
    }
    const refused = /VETO REFUSED reason=(\d+) \(([^)]*)\) amount=(\d+).*override_to_clear=(\d+)/.exec(
      line,
    );
    if (refused) {
      const reasonCode = Number.parseInt(refused[1]!, 10);
      return {
        kind: "refused",
        reasonCode,
        reasonText: refused[2] && refused[2].length > 0 ? refused[2] : reasonText(reasonCode),
        amount: BigInt(refused[3]!),
        suggestedOverride: BigInt(refused[4]!),
      };
    }
  }
  return null;
}

function requireSafeInt(value: unknown, field: string): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${field} must be a safe integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (!/^-?\d+$/.test(value)) throw new Error(`${field} must be an integer string`);
    return BigInt(value);
  }
  throw new Error(`${field} must be an integer`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requirePubkey(value: unknown, field: string): string {
  const s = requireString(value, field);
  try {
    const pk = new PublicKey(s);
    if (pk.toBase58() !== s) throw new Error("not canonical");
    return s;
  } catch {
    throw new Error(`${field} is not a valid pubkey`);
  }
}

export function parseRecord(input: unknown): DecisionRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("record must be a JSON object");
  }
  const o = input as Record<string, unknown>;
  const schema_version = Number(requireSafeInt(o.schema_version, "schema_version"));
  if (schema_version !== 1) throw new Error(`unsupported schema_version: ${schema_version}`);
  const kindRaw = requireString(o.kind, "kind");
  if (kindRaw !== "paid" && kindRaw !== "refused") throw new Error(`kind must be paid or refused`);
  if (typeof o.limits !== "object" || o.limits === null || Array.isArray(o.limits)) {
    throw new Error("limits must be an object");
  }
  const lim = o.limits as Record<string, unknown>;
  const reason_code = Number(requireSafeInt(o.reason_code, "reason_code"));
  if (reason_code < 0 || reason_code > 255) throw new Error("reason_code out of u8 range");
  const record: DecisionRecord = {
    schema_version,
    cluster: requireString(o.cluster, "cluster"),
    genesis_hash: requireString(o.genesis_hash, "genesis_hash"),
    program_id: requirePubkey(o.program_id, "program_id"),
    mandate: requirePubkey(o.mandate, "mandate"),
    limits: {
      cap: requireSafeInt(lim.cap, "limits.cap"),
      per_tx_max: requireSafeInt(lim.per_tx_max, "limits.per_tx_max"),
      expires_at: requireSafeInt(lim.expires_at, "limits.expires_at"),
      merchant: requirePubkey(lim.merchant, "limits.merchant"),
      purpose: requireString(lim.purpose, "limits.purpose"),
    },
    kind: kindRaw,
    amount: requireSafeInt(o.amount, "amount"),
    counterparty: requirePubkey(o.counterparty, "counterparty"),
    timestamp: requireSafeInt(o.timestamp, "timestamp"),
    nonce: requireSafeInt(o.nonce, "nonce"),
    reason_code,
    reason_text: requireString(o.reason_text, "reason_text"),
    suggested_override: requireSafeInt(o.suggested_override, "suggested_override"),
    signature: requireString(o.signature, "signature"),
  };
  return record;
}

export function recordToPlain(record: DecisionRecord): Record<string, unknown> {
  return {
    schema_version: record.schema_version,
    cluster: record.cluster,
    genesis_hash: record.genesis_hash,
    program_id: record.program_id,
    mandate: record.mandate,
    limits: {
      cap: Number(record.limits.cap),
      per_tx_max: Number(record.limits.per_tx_max),
      expires_at: Number(record.limits.expires_at),
      merchant: record.limits.merchant,
      purpose: record.limits.purpose,
    },
    kind: record.kind,
    amount: Number(record.amount),
    counterparty: record.counterparty,
    timestamp: Number(record.timestamp),
    nonce: Number(record.nonce),
    reason_code: record.reason_code,
    reason_text: record.reason_text,
    suggested_override: Number(record.suggested_override),
    signature: record.signature,
  };
}

export function recordToJson(record: DecisionRecord): string {
  return `${JSON.stringify(recordToPlain(record), null, 2)}\n`;
}

export function buildRecord(args: {
  cluster: string;
  genesisHash: string;
  programId: PublicKey;
  mandate: PublicKey;
  mandateAccount: MandateAccount;
  entry: LedgerEntry;
  signature: string;
}): DecisionRecord {
  const kind = kindName(args.entry.kind);
  if (!kind) {
    throw new Error(`ledger entry kind ${args.entry.kind} is not a paid or refused charge`);
  }
  return {
    schema_version: 1,
    cluster: args.cluster,
    genesis_hash: args.genesisHash,
    program_id: args.programId.toBase58(),
    mandate: args.mandate.toBase58(),
    limits: {
      cap: args.mandateAccount.cap,
      per_tx_max: args.mandateAccount.perTxMax,
      expires_at: args.mandateAccount.expiresAt,
      merchant: args.mandateAccount.merchant.toBase58(),
      purpose: args.mandateAccount.purpose,
    },
    kind,
    amount: args.entry.amount,
    counterparty: args.entry.counterparty.toBase58(),
    timestamp: args.entry.ts,
    nonce: args.entry.nonce,
    reason_code: args.entry.reason,
    reason_text: reasonText(args.entry.reason),
    suggested_override: args.entry.suggestedOverride,
    signature: args.signature,
  };
}

export function entryMatches(
  entry: LedgerEntry,
  want: { amount: bigint; nonce: bigint; kind: number; ts?: bigint },
): boolean {
  if (entry.amount !== want.amount) return false;
  if (entry.nonce !== want.nonce) return false;
  if (entry.kind !== want.kind) return false;
  if (want.ts !== undefined && entry.ts !== want.ts) return false;
  return true;
}

export function matchingRingEntry(
  ledger: LedgerAccount,
  want: { amount: bigint; nonce: bigint; kind: "paid" | "refused" },
): LedgerEntry | null {
  const kind = kindByte(want.kind);
  const hits = indexedEntries(ledger).filter((row) =>
    entryMatches(row.entry, { amount: want.amount, nonce: want.nonce, kind }),
  );
  if (hits.length === 0) return null;
  return hits[hits.length - 1]!.entry;
}

export async function tokenAccountOwner(conn: Connection, address: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`token account not found: ${address.toBase58()}`);
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`counterparty ${address.toBase58()} is not an SPL token account`);
  }
  if (info.data.length < 64) throw new Error("token account data too short");
  return new PublicKey(info.data.subarray(32, 64));
}
