import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type ConfirmedSignatureInfo, type Connection } from "@solana/web3.js";
import type { RpcTransaction } from "./events.js";
import {
  CHARGE_DISCRIMINATOR,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  PROGRAM_ID,
  TRADE_LEDGER_DISCRIMINATOR,
  TRADE_RULE_DISCRIMINATOR,
} from "./idl.js";
import {
  ENTRY_SIZE,
  LEDGER_CAPACITY,
  TRADE_ENTRY_SIZE,
  TRADE_LEDGER_CAPACITY,
  mandatePda,
  tradeRulePda,
} from "./layout.js";

export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;

export function u64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function tokenAccountData(mint: PublicKey, owner: PublicKey): Buffer {
  const data = Buffer.alloc(165);
  data.set(mint.toBuffer(), 0);
  data.set(owner.toBuffer(), 32);
  return data;
}

export type MandateFields = {
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

/** Writes a mandate at the on-chain offsets. Tests treat this as the spec. */
export function mandateBytes(fields: MandateFields): Buffer {
  const data = Buffer.alloc(310);
  data.set(MANDATE_DISCRIMINATOR, 0);
  let o = 8;
  const putKey = (key: PublicKey): void => {
    data.set(key.toBuffer(), o);
    o += 32;
  };
  const putU64 = (value: bigint): void => {
    data.writeBigUInt64LE(value, o);
    o += 8;
  };
  putKey(fields.owner);
  putKey(fields.agent);
  putKey(fields.mint);
  putKey(fields.source);
  putKey(fields.merchant);
  putU64(fields.mandateId);
  putU64(fields.cap);
  putU64(fields.spent);
  putU64(fields.perTxMax);
  data.writeBigInt64LE(fields.expiresAt, o);
  o += 8;
  putU64(fields.overrideAmount);
  putU64(fields.overrideNonce);
  putU64(fields.lastNonce);
  const purpose = Buffer.from(fields.purpose, "utf8");
  data.writeUInt32LE(purpose.length, o);
  o += 4;
  data.set(purpose, o);
  o += purpose.length;
  data.writeUInt8(fields.status, o);
  o += 1;
  data.writeUInt32LE(fields.spendCount, o);
  o += 4;
  data.writeUInt32LE(fields.refusalCount, o);
  o += 4;
  data.writeUInt8(fields.bump, o);
  return data;
}

export type EntryFields = {
  index: number;
  ts: bigint;
  amount: bigint;
  counterparty: PublicKey;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  reason: number;
};

export function ledgerBytes(args: {
  mandate: PublicKey;
  total: number;
  head: number;
  bump: number;
  entries?: EntryFields[];
}): Buffer {
  const data = Buffer.alloc(8 + 40 + LEDGER_CAPACITY * ENTRY_SIZE);
  data.set(LEDGER_DISCRIMINATOR, 0);
  data.set(args.mandate.toBuffer(), 8);
  data.writeUInt32LE(args.total, 40);
  data.writeUInt16LE(args.head, 44);
  data.writeUInt8(args.bump, 46);
  for (const entry of args.entries ?? []) {
    const off = 48 + entry.index * ENTRY_SIZE;
    data.writeBigInt64LE(entry.ts, off);
    data.writeBigUInt64LE(entry.amount, off + 8);
    data.set(entry.counterparty.toBuffer(), off + 16);
    data.writeBigUInt64LE(entry.nonce, off + 48);
    data.writeBigUInt64LE(entry.suggestedOverride, off + 56);
    data.writeUInt8(entry.kind, off + 64);
    data.writeUInt8(entry.reason, off + 65);
  }
  return data;
}

export function chargeData(amount: bigint, nonce: bigint): Buffer {
  return Buffer.concat([CHARGE_DISCRIMINATOR, u64(amount), u64(nonce)]);
}

export function paidLog(mandate: PublicKey, amount: bigint, nonce: bigint, spent: bigint): string {
  const raw = Buffer.concat([
    readDisc("Paid"),
    mandate.toBuffer(),
    u64(amount),
    u64(nonce),
    u64(spent),
  ]);
  return `Program data: ${raw.toString("base64")}`;
}

export function refusedLog(
  mandate: PublicKey,
  amount: bigint,
  nonce: bigint,
  reason: number,
  suggestedOverride: bigint,
): string {
  const raw = Buffer.concat([
    readDisc("Refused"),
    mandate.toBuffer(),
    u64(amount),
    u64(nonce),
    Buffer.from([reason]),
    u64(suggestedOverride),
  ]);
  return `Program data: ${raw.toString("base64")}`;
}

function readDisc(name: string): Buffer {
  const idl = JSON.parse(readFileSync(fileURLToPath(new URL("../idl/veto.json", import.meta.url)), "utf8")) as {
    events: { name: string; discriminator: number[] }[];
  };
  const found = idl.events.find((event) => event.name === name);
  if (!found) throw new Error(`fixture IDL missing ${name}`);
  return Buffer.from(found.discriminator);
}

type StoredAccount = { data: Buffer; owner: PublicKey; lamports: number };

export class FakeConnection {
  accounts = new Map<string, StoredAccount>();
  balances = new Map<string, number>();
  tokenAccounts: { owner: string; mint: string; pubkey: PublicKey; data: Buffer }[] = [];
  signatures: ConfirmedSignatureInfo[] = [];
  transactions = new Map<string, RpcTransaction>();
  sent: Buffer[] = [];
  signature = "sig";
  lastTokenFilter: { mint?: PublicKey; programId?: PublicKey } | undefined;
  signatureQueries: { limit?: number; before?: string; until?: string }[] = [];
  opened: string[] = [];
  programQueries: { programId: string; filters: ProgramAccountFilter[] }[] = [];
  /** Devnet genesis. A test sets this to another hash, or sets genesisError when the read should fail. */
  genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  genesisError: Error | undefined;

  async getAccountInfo(key: PublicKey): Promise<StoredAccount | null> {
    return this.accounts.get(key.toBase58()) ?? null;
  }

  async getGenesisHash(): Promise<string> {
    if (this.genesisError) throw this.genesisError;
    return this.genesisHash;
  }

  async getProgramAccounts(
    programId: PublicKey,
    configOrCommitment?: string | { filters?: ProgramAccountFilter[] },
  ): Promise<{ pubkey: PublicKey; account: StoredAccount }[]> {
    const filters = typeof configOrCommitment === "string" ? [] : (configOrCommitment?.filters ?? []);
    this.programQueries.push({ programId: programId.toBase58(), filters });
    const rows: { pubkey: PublicKey; account: StoredAccount }[] = [];
    for (const [address, account] of this.accounts) {
      if (!account.owner.equals(programId)) continue;
      if (!matchesProgramFilters(account.data, filters)) continue;
      rows.push({ pubkey: new PublicKey(address), account });
    }
    return rows;
  }

  async getBalance(key: PublicKey): Promise<number> {
    return this.balances.get(key.toBase58()) ?? 0;
  }

  async getTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint?: PublicKey; programId?: PublicKey },
  ): Promise<{
    context: { slot: number };
    value: { pubkey: PublicKey; account: StoredAccount }[];
  }> {
    this.lastTokenFilter = filter;
    const rows = this.tokenAccounts.filter((row) => {
      if (row.owner !== owner.toBase58()) return false;
      if (filter.mint && row.mint !== filter.mint.toBase58()) return false;
      return true;
    });
    return {
      context: { slot: 1 },
      value: rows.map((row) => ({
        pubkey: row.pubkey,
        account: { data: row.data, owner: TOKEN_PROGRAM_ID, lamports: 1 },
      })),
    };
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 };
  }

  async sendRawTransaction(raw: Uint8Array): Promise<string> {
    this.sent.push(Buffer.from(raw));
    return this.signature;
  }

  async confirmTransaction(): Promise<{ context: { slot: number }; value: { err: null } }> {
    return { context: { slot: 1 }, value: { err: null } };
  }

  async getTransaction(signature: string): Promise<RpcTransaction | null> {
    this.opened.push(signature);
    if (signature === "do-not-fetch") {
      throw new Error("fetched a signature that should have been skipped");
    }
    return this.transactions.get(signature) ?? null;
  }

  async getSignaturesForAddress(
    _address: PublicKey,
    config?: { limit?: number; before?: string; until?: string },
  ): Promise<ConfirmedSignatureInfo[]> {
    this.signatureQueries.push({ limit: config?.limit, before: config?.before, until: config?.until });
    let rows = this.signatures;
    if (config?.before) {
      const idx = rows.findIndex((row) => row.signature === config.before);
      rows = idx >= 0 ? rows.slice(idx + 1) : [];
    }
    if (config?.until) {
      const idx = rows.findIndex((row) => row.signature === config.until);
      if (idx >= 0) rows = rows.slice(0, idx);
    }
    return rows.slice(0, config?.limit ?? rows.length);
  }
}

export function asConnection(fake: FakeConnection): Connection {
  return fake as unknown as Connection;
}

export type World = {
  fake: FakeConnection;
  connection: Connection;
  agent: Keypair;
  owner: Keypair;
  merchant: Keypair;
  mint: Keypair;
  source: Keypair;
  destination: Keypair;
  mandate: PublicKey;
  mandateId: bigint;
};

export function world(patch?: Partial<MandateFields> & { balance?: number; tokenProgram?: PublicKey }): World {
  const agent = Keypair.generate();
  const owner = Keypair.generate();
  const merchant = Keypair.generate();
  const mint = Keypair.generate();
  const source = Keypair.generate();
  const destination = Keypair.generate();
  const mandateId = 3n;
  const mandate = mandatePda(PROGRAM_ID, owner.publicKey, mandateId);
  const { balance, tokenProgram, ...mandatePatch } = patch ?? {};
  const fields: MandateFields = {
    owner: owner.publicKey,
    agent: agent.publicKey,
    mint: mint.publicKey,
    source: source.publicKey,
    merchant: merchant.publicKey,
    mandateId,
    cap: 300_000_000n,
    spent: 0n,
    perTxMax: 10_000_000n,
    expiresAt: 1_797_805_739n,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: "Charging top-ups at the SE3 spot rate",
    status: 0,
    spendCount: 0,
    refusalCount: 0,
    bump: 254,
    ...mandatePatch,
  };
  const fake = new FakeConnection();
  fake.accounts.set(mandate.toBase58(), {
    data: mandateBytes(fields),
    owner: PROGRAM_ID,
    lamports: 2_225_040,
  });
  fake.accounts.set(source.publicKey.toBase58(), {
    data: tokenAccountData(mint.publicKey, owner.publicKey),
    owner: tokenProgram ?? TOKEN_PROGRAM_ID,
    lamports: 1,
  });
  const mintData = Buffer.alloc(82);
  mintData.writeUInt8(6, 44);
  mintData.writeUInt8(1, 45);
  fake.accounts.set(mint.publicKey.toBase58(), {
    data: mintData,
    owner: tokenProgram ?? TOKEN_PROGRAM_ID,
    lamports: 1,
  });
  fake.tokenAccounts.push({
    owner: merchant.publicKey.toBase58(),
    mint: mint.publicKey.toBase58(),
    pubkey: destination.publicKey,
    data: tokenAccountData(mint.publicKey, merchant.publicKey),
  });
  fake.balances.set(agent.publicKey.toBase58(), balance ?? 1_000_000);
  return {
    fake,
    connection: asConnection(fake),
    agent,
    owner,
    merchant,
    mint,
    source,
    destination,
    mandate,
    mandateId,
  };
}

export function legacyChargeTx(args: {
  signature: string;
  slot: number;
  blockTime: number | null;
  err?: unknown;
  logs: string[];
  keys: PublicKey[];
  amount: bigint;
  nonce: bigint;
}): RpcTransaction {
  const keys = args.keys.map((key) => key.toBase58());
  return {
    slot: args.slot,
    blockTime: args.blockTime,
    meta: { err: args.err ?? null, logMessages: args.logs },
    transaction: {
      signatures: [args.signature],
      message: {
        accountKeys: keys,
        instructions: [
          {
            programIdIndex: keys.indexOf(PROGRAM_ID.toBase58()),
            accounts: [0, 1, 2, 3, 4, 5, 6],
            data: encodeBase58(chargeData(args.amount, args.nonce)),
          },
        ],
      },
    },
  };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type ProgramAccountFilter =
  | { dataSize: number }
  | { memcmp: { offset: number; bytes: string; encoding?: "base58" | "base64" } };

function matchesProgramFilters(data: Buffer, filters: ProgramAccountFilter[]): boolean {
  for (const filter of filters) {
    if ("dataSize" in filter) {
      if (data.length !== filter.dataSize) return false;
      continue;
    }
    const raw =
      filter.memcmp.encoding === "base64"
        ? Buffer.from(filter.memcmp.bytes, "base64")
        : decodeBase58(filter.memcmp.bytes);
    const offset = filter.memcmp.offset;
    if (offset < 0 || offset + raw.length > data.length) return false;
    if (!data.subarray(offset, offset + raw.length).equals(raw)) return false;
  }
  return true;
}

export function encodeBase58(bytes: Buffer): string {
  let zeros = 0;
  for (const byte of bytes) {
    if (byte === 0) zeros += 1;
    else break;
  }
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function decodeBase58(text: string): Buffer {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  let n = 0n;
  for (let i = zeros; i < text.length; i += 1) {
    const value = B58.indexOf(text[i] ?? "");
    if (value < 0) throw new Error(`invalid base58: ${text}`);
    n = n * 58n + BigInt(value);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.push(Number(n % 256n));
    n /= 256n;
  }
  const out = Buffer.alloc(zeros + body.length);
  for (let i = 0; i < body.length; i += 1) {
    out[zeros + i] = body[body.length - 1 - i] ?? 0;
  }
  return out;
}

export function framed(program: string, lines: string[]): string[] {
  return [`Program ${program} invoke [1]`, ...lines, `Program ${program} success`];
}

export type TradeRuleFields = {
  owner: PublicKey;
  agent: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  inMint: PublicKey;
  outMint: PublicKey;
  exchangeProgram: PublicKey;
  exchangeKind: number;
  pool: PublicKey;
  poolAuthority: PublicKey;
  poolInVault: PublicKey;
  poolOutVault: PublicKey;
  poolMint: PublicKey;
  poolFeeAccount: PublicKey;
  ruleId: bigint;
  cap: bigint;
  spent: bigint;
  perTradeMax: bigint;
  dailyLimit: bigint;
  dailyBuckets: { hour: bigint; amount: bigint }[];
  floorNum: bigint;
  floorDen: bigint;
  expiresAt: bigint;
  overrideAmount: bigint;
  overrideNonce: bigint;
  lastNonce: bigint;
  purpose: string;
  status: number;
  tradeCount: number;
  refusalCount: number;
  bump: number;
};

/** Writes a trade rule at the on-chain offsets. Tests treat this as the spec. */
export function tradeRuleBytes(fields: TradeRuleFields): Buffer {
  const purpose = Buffer.from(fields.purpose, "utf8");
  const data = Buffer.alloc(8 + 224 + 1 + 192 + 11 * 8 + 25 * 16 + 4 + purpose.length + 1 + 4 + 4 + 1);
  data.set(TRADE_RULE_DISCRIMINATOR, 0);
  let o = 8;
  const putKey = (key: PublicKey): void => {
    data.set(key.toBuffer(), o);
    o += 32;
  };
  const putU64 = (value: bigint): void => {
    data.writeBigUInt64LE(value, o);
    o += 8;
  };
  putKey(fields.owner);
  putKey(fields.agent);
  putKey(fields.source);
  putKey(fields.destination);
  putKey(fields.inMint);
  putKey(fields.outMint);
  putKey(fields.exchangeProgram);
  data.writeUInt8(fields.exchangeKind, o);
  o += 1;
  putKey(fields.pool);
  putKey(fields.poolAuthority);
  putKey(fields.poolInVault);
  putKey(fields.poolOutVault);
  putKey(fields.poolMint);
  putKey(fields.poolFeeAccount);
  putU64(fields.ruleId);
  putU64(fields.cap);
  putU64(fields.spent);
  putU64(fields.perTradeMax);
  putU64(fields.dailyLimit);
  if (fields.dailyBuckets.length !== 25) throw new Error("expected 25 daily buckets");
  for (const bucket of fields.dailyBuckets) {
    data.writeBigInt64LE(bucket.hour, o);
    o += 8;
    putU64(bucket.amount);
  }
  putU64(fields.floorNum);
  putU64(fields.floorDen);
  data.writeBigInt64LE(fields.expiresAt, o);
  o += 8;
  putU64(fields.overrideAmount);
  putU64(fields.overrideNonce);
  putU64(fields.lastNonce);
  data.writeUInt32LE(purpose.length, o);
  o += 4;
  data.set(purpose, o);
  o += purpose.length;
  data.writeUInt8(fields.status, o);
  o += 1;
  data.writeUInt32LE(fields.tradeCount, o);
  o += 4;
  data.writeUInt32LE(fields.refusalCount, o);
  o += 4;
  data.writeUInt8(fields.bump, o);
  o += 1;
  return data.subarray(0, o);
}

export type TradeEntryFields = {
  index: number;
  ts: bigint;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  counterparty: PublicKey;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  reason: number;
};

export function tradeLedgerBytes(args: {
  rule: PublicKey;
  total: number;
  head: number;
  bump: number;
  entries?: TradeEntryFields[];
}): Buffer {
  const data = Buffer.alloc(8 + 40 + TRADE_LEDGER_CAPACITY * TRADE_ENTRY_SIZE);
  data.set(TRADE_LEDGER_DISCRIMINATOR, 0);
  data.set(args.rule.toBuffer(), 8);
  data.writeUInt32LE(args.total, 40);
  data.writeUInt16LE(args.head, 44);
  data.writeUInt8(args.bump, 46);
  for (const entry of args.entries ?? []) {
    const off = 48 + entry.index * TRADE_ENTRY_SIZE;
    data.writeBigInt64LE(entry.ts, off);
    data.writeBigUInt64LE(entry.amountIn, off + 8);
    data.writeBigUInt64LE(entry.amountOut, off + 16);
    data.writeBigUInt64LE(entry.minOut, off + 24);
    data.set(entry.counterparty.toBuffer(), off + 32);
    data.writeBigUInt64LE(entry.nonce, off + 64);
    data.writeBigUInt64LE(entry.suggestedOverride, off + 72);
    data.writeUInt8(entry.kind, off + 80);
    data.writeUInt8(entry.reason, off + 81);
  }
  return data;
}

export function tradedLog(
  rule: PublicKey,
  amountIn: bigint,
  amountOut: bigint,
  nonce: bigint,
  spent: bigint,
): string {
  const raw = Buffer.concat([
    readDisc("Traded"),
    rule.toBuffer(),
    u64(amountIn),
    u64(amountOut),
    u64(nonce),
    u64(spent),
  ]);
  return `Program data: ${raw.toString("base64")}`;
}

export function tradeRefusedLog(
  rule: PublicKey,
  amountIn: bigint,
  minOut: bigint,
  nonce: bigint,
  reason: number,
  suggestedOverride: bigint,
): string {
  const raw = Buffer.concat([
    readDisc("TradeRefused"),
    rule.toBuffer(),
    u64(amountIn),
    u64(minOut),
    u64(nonce),
    Buffer.from([reason]),
    u64(suggestedOverride),
  ]);
  return `Program data: ${raw.toString("base64")}`;
}

export type TradeWorld = {
  fake: FakeConnection;
  connection: Connection;
  agent: Keypair;
  owner: Keypair;
  inMint: Keypair;
  outMint: Keypair;
  source: Keypair;
  destination: Keypair;
  exchangeProgram: Keypair;
  pool: Keypair;
  poolAuthority: Keypair;
  poolInVault: Keypair;
  poolOutVault: Keypair;
  poolMint: Keypair;
  poolFee: Keypair;
  rule: PublicKey;
  ruleId: bigint;
  fields: TradeRuleFields;
};

function mintAccountData(decimals: number): Buffer {
  const data = Buffer.alloc(82);
  data.writeUInt8(decimals, 44);
  data.writeUInt8(1, 45);
  return data;
}

export function tradeWorld(
  patch?: Partial<TradeRuleFields> & { inDecimals?: number; outDecimals?: number; balance?: number },
): TradeWorld {
  const agent = Keypair.generate();
  const owner = Keypair.generate();
  const inMint = Keypair.generate();
  const outMint = Keypair.generate();
  const source = Keypair.generate();
  const destination = Keypair.generate();
  const exchangeProgram = Keypair.generate();
  const pool = Keypair.generate();
  const poolAuthority = Keypair.generate();
  const poolInVault = Keypair.generate();
  const poolOutVault = Keypair.generate();
  const poolMint = Keypair.generate();
  const poolFee = Keypair.generate();
  const { inDecimals, outDecimals, balance, ...rulePatch } = patch ?? {};
  const fields: TradeRuleFields = {
    owner: owner.publicKey,
    agent: agent.publicKey,
    source: source.publicKey,
    destination: destination.publicKey,
    inMint: inMint.publicKey,
    outMint: outMint.publicKey,
    exchangeProgram: exchangeProgram.publicKey,
    exchangeKind: 0,
    pool: pool.publicKey,
    poolAuthority: poolAuthority.publicKey,
    poolInVault: poolInVault.publicKey,
    poolOutVault: poolOutVault.publicKey,
    poolMint: poolMint.publicKey,
    poolFeeAccount: poolFee.publicKey,
    ruleId: 7n,
    cap: 1_000_000_000n,
    spent: 0n,
    perTradeMax: 10_000_000n,
    dailyLimit: 100_000_000n,
    dailyBuckets: Array.from({ length: 25 }, () => ({ hour: 0n, amount: 0n })),
    floorNum: 9_500n,
    floorDen: 10_000n,
    expiresAt: 1_900_000_000n,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: "Swap at the pinned pool",
    status: 0,
    tradeCount: 0,
    refusalCount: 0,
    bump: 1,
    ...rulePatch,
  };
  const rule = tradeRulePda(PROGRAM_ID, fields.owner, fields.ruleId);
  const fake = new FakeConnection();
  fake.accounts.set(rule.toBase58(), {
    data: tradeRuleBytes(fields),
    owner: PROGRAM_ID,
    lamports: 1,
  });
  fake.accounts.set(fields.source.toBase58(), {
    data: tokenAccountData(fields.inMint, fields.owner),
    owner: TOKEN_PROGRAM_ID,
    lamports: 1,
  });
  fake.accounts.set(fields.destination.toBase58(), {
    data: tokenAccountData(fields.outMint, fields.owner),
    owner: TOKEN_PROGRAM_ID,
    lamports: 1,
  });
  fake.accounts.set(fields.inMint.toBase58(), {
    data: mintAccountData(inDecimals ?? 9),
    owner: TOKEN_PROGRAM_ID,
    lamports: 1,
  });
  fake.accounts.set(fields.outMint.toBase58(), {
    data: mintAccountData(outDecimals ?? 6),
    owner: TOKEN_PROGRAM_ID,
    lamports: 1,
  });
  fake.balances.set(fields.agent.toBase58(), balance ?? 1_000_000);
  return {
    fake,
    connection: asConnection(fake),
    agent,
    owner,
    inMint,
    outMint,
    source,
    destination,
    exchangeProgram,
    pool,
    poolAuthority,
    poolInVault,
    poolOutVault,
    poolMint,
    poolFee,
    rule,
    ruleId: fields.ruleId,
    fields,
  };
}
