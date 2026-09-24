import { PublicKey } from "@solana/web3.js";

const AGENT_CONFIG_KEYS = [
  "mandate",
  "programId",
  "mint",
  "mintDecimals",
  "sourceTokenAccount",
  "payeeTokenAccount",
  "agent",
  "cluster",
  "rpcUrl",
] as const;

const CLUSTERS = ["devnet", "testnet", "mainnet-beta"] as const;

/** The JSON block the rule screen copies and encodes in the QR. */
export type AgentConfig = {
  mandate: string;
  programId: string;
  mint: string;
  mintDecimals: number;
  sourceTokenAccount: string;
  payeeTokenAccount: string;
  agent: string;
  cluster: string;
  rpcUrl: string;
};

/**
 * Reads the block the app copies. Accepts the JSON text or the parsed object.
 * Every field is checked. A missing, extra, or unusable field throws.
 */
export function loadAgentConfig(json: string | unknown): AgentConfig {
  let raw: unknown = json;
  if (typeof json === "string") {
    try {
      raw = JSON.parse(json) as unknown;
    } catch (err) {
      throw new Error("agent config is not valid JSON", { cause: err });
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("agent config must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const missing = AGENT_CONFIG_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  const extra = Object.keys(record).filter(
    (key) => !AGENT_CONFIG_KEYS.includes(key as (typeof AGENT_CONFIG_KEYS)[number]),
  );
  if (missing.length > 0 || extra.length > 0) {
    throw new Error("agent config keys do not match the documented shape");
  }
  const mintDecimals = record.mintDecimals;
  if (
    typeof mintDecimals !== "number" ||
    !Number.isInteger(mintDecimals) ||
    mintDecimals < 0 ||
    mintDecimals > 18
  ) {
    throw new Error("mint decimals must be an integer from 0 to 18");
  }
  const rpcUrl = record.rpcUrl;
  if (typeof rpcUrl !== "string" || rpcUrl.length === 0) {
    throw new Error("rpc url is missing");
  }
  const cluster = record.cluster;
  if (typeof cluster !== "string" || !CLUSTERS.includes(cluster as (typeof CLUSTERS)[number])) {
    const shown = typeof cluster === "string" ? JSON.stringify(cluster) : typeof cluster;
    throw new Error(
      `Unknown cluster ${shown}. The cluster must be devnet, testnet, or mainnet-beta.`,
    );
  }
  return {
    mandate: canonicalAddress(record.mandate, "mandate"),
    programId: canonicalAddress(record.programId, "program id"),
    mint: canonicalAddress(record.mint, "mint"),
    mintDecimals,
    sourceTokenAccount: canonicalAddress(record.sourceTokenAccount, "source token account"),
    payeeTokenAccount: canonicalAddress(record.payeeTokenAccount, "payee token account"),
    agent: canonicalAddress(record.agent, "agent"),
    cluster,
    rpcUrl,
  };
}

function canonicalAddress(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    throw new Error(`${field} must be a base58 public key`);
  }
  if (key.toBase58() !== value) {
    throw new Error(`${field} must be a base58 public key`);
  }
  return value;
}
