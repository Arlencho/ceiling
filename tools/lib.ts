import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { decodeEventsFromLogs, linesForProgram } from "../indexer/src/events.js";
import { createFailoverConnection, parseRpcList, redactRpcUrl, redactRpcUrls } from "../indexer/src/rpc.js";

export { redactRpcUrl, redactRpcUrls };

export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = join(TOOLS_DIR, "..");
export const IDL_PATH = join(TOOLS_DIR, "idl", "veto.json");

// Well-known SPL Token program. Same on every cluster; not a Veto identity.
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

export function resolveRpcList(
  cli?: Cli,
  repoRoot = REPO_DIR,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const fromFlag = cli ? flagString(cli, "rpc") : undefined;
  if (fromFlag !== undefined) {
    const listed = parseRpcList(fromFlag);
    if (listed.length === 0) throw new Error("no rpc endpoints configured");
    return listed;
  }
  if (env.VETO_RPC && env.VETO_RPC.length > 0) {
    const listed = parseRpcList(env.VETO_RPC);
    if (listed.length === 0) throw new Error("no rpc endpoints configured");
    return listed;
  }
  const file = addressesFile(repoRoot);
  const fromFile = file.get("RPC") ?? file.get("VETO_RPC");
  if (fromFile && fromFile.length > 0) {
    const listed = parseRpcList(fromFile);
    if (listed.length === 0) throw new Error("no rpc endpoints configured");
    return listed;
  }
  throw new Error(
    "lib.resolveRpc: missing VETO_RPC; set it in the environment, keys/devnet-addresses.env, or pass --rpc",
  );
}

export function resolveRpc(
  cli?: Cli,
  repoRoot = REPO_DIR,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveRpcList(cli, repoRoot, env)[0]!;
}

function programIdFromIdl(repoRoot: string): string | undefined {
  const path = join(repoRoot, "tools", "idl", "veto.json");
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `lib.resolveProgramId: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed && typeof parsed === "object" && "address" in parsed) {
    const address = (parsed as { address: unknown }).address;
    if (typeof address === "string" && address.length > 0) return address;
  }
  return undefined;
}

export type VerifyProgramSource = "VETO_PROGRAM_ID" | "idl";

// Verify does not read keys/devnet-addresses.env. A local devnet setup must
// not silently change the program a record is checked against.
export function resolveVerifyProgramId(
  repoRoot = REPO_DIR,
  env: NodeJS.ProcessEnv = process.env,
): { programId: PublicKey; source: VerifyProgramSource } {
  if (env.VETO_PROGRAM_ID && env.VETO_PROGRAM_ID.length > 0) {
    return { programId: new PublicKey(env.VETO_PROGRAM_ID), source: "VETO_PROGRAM_ID" };
  }
  const fromIdl = programIdFromIdl(repoRoot);
  if (fromIdl) return { programId: new PublicKey(fromIdl), source: "idl" };
  throw new Error(
    "lib.resolveVerifyProgramId: missing program id; pass --program-id or set VETO_PROGRAM_ID",
  );
}

export function resolveProgramId(
  repoRoot = REPO_DIR,
  env: NodeJS.ProcessEnv = process.env,
): PublicKey {
  if (env.VETO_PROGRAM_ID && env.VETO_PROGRAM_ID.length > 0) {
    return new PublicKey(env.VETO_PROGRAM_ID);
  }
  const file = addressesFile(repoRoot);
  const fromFile = file.get("PROGRAM_ID") ?? file.get("VETO_PROGRAM_ID");
  if (fromFile && fromFile.length > 0) return new PublicKey(fromFile);
  const fromIdl = programIdFromIdl(repoRoot);
  if (fromIdl) return new PublicKey(fromIdl);
  throw new Error(
    "lib.resolveProgramId: missing VETO_PROGRAM_ID; set it in the environment or keys/devnet-addresses.env",
  );
}

export function resolveClusterName(repoRoot = REPO_DIR): string {
  if (process.env.VETO_CLUSTER && process.env.VETO_CLUSTER.length > 0) return process.env.VETO_CLUSTER;
  const fromFile = addressesFile(repoRoot).get("CLUSTER");
  if (fromFile && fromFile.length > 0) return fromFile;
  // A cluster label, not an endpoint, program, mint, or account.
  return "devnet";
}

const CLUSTER_BY_GENESIS: Readonly<Record<string, string>> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

export function clusterForGenesis(genesis: string): string {
  return CLUSTER_BY_GENESIS[genesis] ?? "localnet";
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
  if (list.length === 0) throw new Error("no rpc endpoints configured");
  return createFailoverConnection(list);
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

type AccountKeyLike = string | { pubkey: string } | { toBase58: () => string };

type RpcTx = {
  meta: {
    err: unknown;
    logMessages?: string[] | null;
  } | null;
  transaction: {
    message: {
      accountKeys?: Array<AccountKeyLike>;
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
      staticAccountKeys?: AccountKeyLike[];
    };
  };
};

function toPublicKey(k: unknown): PublicKey {
  if (k instanceof PublicKey) return k;
  if (typeof k === "string") return new PublicKey(k);
  if (k && typeof k === "object") {
    const rec = k as { toBase58?: unknown; pubkey?: unknown };
    if (typeof rec.toBase58 === "function") {
      return new PublicKey((rec.toBase58 as () => string)());
    }
    if (rec.pubkey !== undefined) return toPublicKey(rec.pubkey);
  }
  throw new Error("lib.toPublicKey: not a public key");
}

function flattenAccountKeys(tx: RpcTx, loaded?: { writable: AccountKeyLike[]; readonly: AccountKeyLike[] }): PublicKey[] {
  const msg = tx.transaction.message;
  if (Array.isArray(msg.accountKeys) && msg.accountKeys.length > 0) {
    return msg.accountKeys.map((k) => toPublicKey(k));
  }
  const staticKeys = msg.staticAccountKeys ?? [];
  return [
    ...staticKeys.map((k) => toPublicKey(k)),
    ...(loaded?.writable ?? []).map((k) => toPublicKey(k)),
    ...(loaded?.readonly ?? []).map((k) => toPublicKey(k)),
  ];
}

export function parseChargeFromTx(
  tx: RpcTx & { meta?: { loadedAddresses?: { writable: AccountKeyLike[]; readonly: AccountKeyLike[] } } | null },
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

export type ChargeLogDecision = {
  kind: "paid" | "refused";
  reasonCode: number;
  reasonText: string;
  amount: bigint;
  suggestedOverride: bigint;
};

// Every attributed VETO PAID / VETO REFUSED line, in log order. parseChargeLogs
// keeps the first, which is what a single-charge export reads.
export function chargeLogDecisions(logs: readonly string[], programId: PublicKey | string): ChargeLogDecision[] {
  const id = typeof programId === "string" ? programId : programId.toBase58();
  const out: ChargeLogDecision[] = [];
  for (const line of linesForProgram(logs, id)) {
    const paid = /VETO PAID amount=(\d+)/.exec(line);
    if (paid) {
      out.push({
        kind: "paid",
        reasonCode: 0,
        reasonText: "ok",
        amount: BigInt(paid[1]!),
        suggestedOverride: 0n,
      });
      continue;
    }
    const refused = /VETO REFUSED reason=(\d+) \(([^)]*)\) amount=(\d+).*override_to_clear=(\d+)/.exec(line);
    if (refused) {
      const reasonCode = Number.parseInt(refused[1]!, 10);
      out.push({
        kind: "refused",
        reasonCode,
        reasonText: refused[2] && refused[2].length > 0 ? refused[2] : reasonText(reasonCode),
        amount: BigInt(refused[3]!),
        suggestedOverride: BigInt(refused[4]!),
      });
    }
  }
  return out;
}

export function parseChargeLogs(logs: readonly string[], programId: PublicKey | string): ChargeLogDecision | null {
  return chargeLogDecisions(logs, programId)[0] ?? null;
}

export type DecisionTriple = {
  mandate: string;
  nonce: bigint;
  amount: bigint;
};

// Shared binder for a ring row and for a Veto event. Nonce alone is not a
// decision: one transaction can refuse and then pay the same nonce at two
// amounts, or pay one nonce and refuse another. Position is not a decision
// either. Callers that still have more than one hit (two refusals of one
// nonce at different times) disambiguate themselves. Callers that cannot
// (events in one transaction) require exactly one hit.
export function bindByTriple<T>(items: readonly T[], want: DecisionTriple, keyOf: (item: T) => DecisionTriple): T[] {
  return items.filter((item) => {
    const key = keyOf(item);
    return key.mandate === want.mandate && key.nonce === want.nonce && key.amount === want.amount;
  });
}

export function vetoDecisionCountError(count: number, nonce: bigint): string {
  return `transaction carries ${count} Veto decisions for nonce ${nonce.toString()}`;
}

export type BoundVetoDecision =
  | { status: "one"; decision: ChargeLogDecision }
  | { status: "error"; error: string }
  | { status: "none" };

// Kind, reason, and override come from the one Veto event that matches the
// charge triple. Zero events or several events fail closed. A text line is
// used only when the transaction carries no Veto event at all, and then only
// when exactly one Veto decision line is present.
export function boundVetoDecision(
  logs: readonly string[],
  programId: PublicKey | string,
  want: DecisionTriple,
): BoundVetoDecision {
  const id = typeof programId === "string" ? programId : programId.toBase58();
  const events = decodeEventsFromLogs(logs, id);
  if (events.length > 0) {
    const matches = bindByTriple(events, want, (event) => ({
      mandate: event.mandate,
      nonce: event.nonce,
      amount: event.amount,
    }));
    if (matches.length !== 1) {
      return { status: "error", error: vetoDecisionCountError(matches.length, want.nonce) };
    }
    const event = matches[0]!;
    return {
      status: "one",
      decision: {
        kind: event.kind,
        reasonCode: event.reason,
        reasonText: reasonText(event.reason),
        amount: event.amount,
        suggestedOverride: event.suggestedOverride,
      },
    };
  }
  const lines = chargeLogDecisions(logs, id);
  if (lines.length === 0) return { status: "none" };
  if (lines.length !== 1) {
    return { status: "error", error: vetoDecisionCountError(lines.length, want.nonce) };
  }
  return { status: "one", decision: lines[0]! };
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

function sameComparedFields(a: LedgerEntry, b: LedgerEntry): boolean {
  return (
    a.kind === b.kind &&
    a.nonce === b.nonce &&
    a.ts === b.ts &&
    a.amount === b.amount &&
    a.counterparty.equals(b.counterparty) &&
    a.reason === b.reason &&
    a.suggestedOverride === b.suggestedOverride
  );
}

// The ring row for this signature. Distance is absolute time from blockTime.
// A tie binds only when the tied rows agree on every field a record compares.
// A null block time with more than one row refuses to bind to the newest.
export function ringEntryForSignature(
  rows: IndexedEntry[],
  blockTime: number | null,
  signature: string,
): { entry: LedgerEntry } | { error: string } {
  const nonce = rows[0]!.entry.nonce.toString();
  if (blockTime === null) {
    if (rows.length > 1) {
      return {
        error: `signature ${signature} matches ${rows.length} ledger rows for nonce ${nonce} equally; refusing to bind to the newest`,
      };
    }
    return { entry: rows[0]!.entry };
  }
  const target = BigInt(blockTime);
  const distance = (row: IndexedEntry): bigint => {
    const ts = row.entry.ts;
    return ts >= target ? ts - target : target - ts;
  };
  const ranked = [...rows].sort((a, b) => {
    const delta = distance(a) - distance(b);
    if (delta !== 0n) return delta < 0n ? -1 : 1;
    return b.sequence - a.sequence;
  });
  const best = ranked[0]!;
  const bestDistance = distance(best);
  const tied = ranked.filter((row) => distance(row) === bestDistance);
  if (tied.length > 1 && tied.some((row) => !sameComparedFields(row.entry, best.entry))) {
    return {
      error: `signature ${signature} matches ${tied.length} ledger rows for nonce ${best.entry.nonce.toString()} equally; refusing to bind to the newest`,
    };
  }
  return { entry: best.entry };
}

export function matchingRingEntry(
  ledger: LedgerAccount,
  want: {
    amount: bigint;
    nonce: bigint;
    kind: "paid" | "refused";
    timestamp?: number | null;
    signature?: string;
  },
): LedgerEntry | null {
  const kind = kindByte(want.kind);
  const hits = indexedEntries(ledger).filter((row) =>
    entryMatches(row.entry, { amount: want.amount, nonce: want.nonce, kind }),
  );
  if (hits.length === 0) return null;
  const picked = ringEntryForSignature(hits, want.timestamp ?? null, want.signature ?? "");
  if ("error" in picked) return null;
  return picked.entry;
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
