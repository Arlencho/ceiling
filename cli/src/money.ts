import type { Connection } from "./web3.js";
import { PublicKey, type PublicKey as Address } from "./web3.js";
import { CliError } from "./errors.js";

/** Devnet USDC. Mainnet must be given; this mint is not assumed there. */
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const VTEST_MINT = "2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU";
const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";

const KNOWN_SYMBOL: Readonly<Record<string, string>> = {
  [DEVNET_USDC_MINT]: "USDC",
  [MAINNET_USDC_MINT]: "USDC",
  [VTEST_MINT]: "VTEST",
  [SKR_MINT]: "SKR",
};

const U64_MAX = 18446744073709551615n;
const MINT_DECIMALS_OFFSET = 44;

/** The line an owner pastes into the agent's MCP config. */
export const MCP_CONFIG_LINE =
  '{"mcpServers":{"veto":{"command":"npx","args":["-y","@veto-hq/veto","mcp"]}}}';

export function shortAddress(address: string): string {
  if (address.length <= 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/** Symbol when the mint is known. Shortened mint otherwise. Never a guessed ticker. */
export function tokenSymbol(mint: string): string {
  return KNOWN_SYMBOL[mint] ?? shortAddress(mint);
}

export function parseBaseUnits(text: string, field: string): bigint {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new CliError(`${field} must be an integer in base units.`);
  }
  const value = BigInt(trimmed);
  if (value <= 0n || value > U64_MAX) {
    throw new CliError(`${field} must be an integer in base units.`);
  }
  return value;
}

export function parseDays(text: string): number {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new CliError("Days must be a whole number from 1 to 3650.");
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > 3650) {
    throw new CliError("Days must be a whole number from 1 to 3650.");
  }
  return value;
}

/** Exact decimal from integer base units. No binary float. */
export function formatUnits(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new CliError("Mint decimals are out of range.");
  }
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const sign = negative ? "-" : "";
  if (frac === 0n) return `${sign}${whole.toString()}`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}.${fracStr}`;
}

/**
 * Token amounts keep at least two fractional digits when they are not whole,
 * so 500000 base units of USDC reads as 0.50. A longer fraction stays exact.
 */
export function formatTokenUnits(amount: bigint, decimals: number): string {
  const exact = formatUnits(amount, decimals);
  const dot = exact.indexOf(".");
  if (dot === -1) return exact;
  const frac = exact.slice(dot + 1);
  if (frac.length >= 2) return exact;
  return `${exact}${"0".repeat(2 - frac.length)}`;
}

export function formatUtcDay(unixSeconds: bigint): string {
  if (unixSeconds < 0n || unixSeconds > 8_640_000_000_000n) {
    throw new CliError("Expiry is out of range.");
  }
  const date = new Date(Number(unixSeconds) * 1000);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function approvedSentence(args: {
  cap: bigint;
  max: bigint;
  decimals: number;
  symbol: string;
  expiresAt: bigint;
  payee: string;
}): string {
  const total = formatTokenUnits(args.cap, args.decimals);
  const most = formatTokenUnits(args.max, args.decimals);
  const ends = formatUtcDay(args.expiresAt);
  const pays = shortAddress(args.payee);
  return `Rule approved. Total ${total} ${args.symbol}, most per payment ${most} ${args.symbol}, ends ${ends}, pays ${pays}. Your agent can pay with: veto pay <amount>`;
}

export function unixSeconds(now: Date): bigint {
  const ms = now.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new CliError("Clock is out of range.");
  }
  return BigInt(ms) / 1000n;
}

/** Active is status 0, the value the program writes for STATUS_ACTIVE, and an expiry still ahead. */
export function isActive(status: number, expiresAt: bigint, nowSec: bigint): boolean {
  return status === 0 && expiresAt > nowSec;
}

export async function readDecimals(connection: Connection, mint: Address): Promise<number> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  const data = info?.data;
  if (!(data instanceof Uint8Array) || data.length < MINT_DECIMALS_OFFSET + 1) {
    throw new CliError(`Mint ${mint.toBase58()} has no decimals.`);
  }
  const decimals = data[MINT_DECIMALS_OFFSET];
  if (decimals === undefined || decimals > 18) {
    throw new CliError(`Mint ${mint.toBase58()} has no decimals.`);
  }
  return decimals;
}
