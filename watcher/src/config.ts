import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KWH_MILLI, DEFAULT_MINT_DECIMALS } from "./money.js";
import { parseRpcList } from "./rpc.js";

export const WATCHER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = join(WATCHER_DIR, "..");

const DEFAULTS = {
  rpc: "http://127.0.0.1:8999",
  programId: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  mint: "2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU",
  owner: "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc",
  ownerTokenAccount: "FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE",
  merchant: "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG",
  merchantTokenAccount: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  agent: "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w",
};

export type WatcherConfig = {
  rpc: string;
  rpcs: string[];
  keysDir: string;
  journalPath: string;
  idlPath: string;
  programId: string;
  mint: string;
  owner: string;
  ownerTokenAccount: string;
  merchant: string;
  merchantTokenAccount: string;
  agent: string;
  mandateId: bigint;
  kwhMilli: bigint;
  mintDecimals: number;
  cap: bigint;
  perTxMax: bigint;
  purpose: string;
};

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

function pick(env: NodeJS.ProcessEnv, file: Map<string, string>, key: string, fallback: string): string {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const mapped: Record<string, string> = {
    VETO_RPC: "RPC",
    VETO_PROGRAM_ID: "PROGRAM_ID",
    VETO_MINT: "MINT",
    VETO_OWNER: "OWNER",
    VETO_OWNER_TOKEN: "OWNER_TOKEN_ACCOUNT",
    VETO_MERCHANT: "MERCHANT",
    VETO_MERCHANT_TOKEN: "MERCHANT_TOKEN_ACCOUNT",
    VETO_AGENT: "AGENT",
  };
  const fileKey = mapped[key];
  if (fileKey) {
    const fromFile = file.get(fileKey);
    if (fromFile !== undefined && fromFile.length > 0) return fromFile;
  }
  return fallback;
}

function resolvePath(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  const keysDir = resolvePath(env.VETO_KEYS_DIR ?? join(REPO_DIR, "keys"), WATCHER_DIR);
  const addresses = parseEnvFile(join(keysDir, "devnet-addresses.env"));
  const localEnv = parseEnvFile(join(WATCHER_DIR, ".env"));
  const merged = new Map([...addresses, ...localEnv]);

  const journalPath = resolvePath(env.VETO_JOURNAL ?? join(WATCHER_DIR, "data", "decisions.jsonl"), WATCHER_DIR);
  const targetIdl = join(REPO_DIR, "target", "idl", "veto.json");
  const bundledIdl = join(WATCHER_DIR, "idl", "veto.json");
  const idlPath = env.VETO_IDL
    ? resolvePath(env.VETO_IDL, WATCHER_DIR)
    : existsSync(targetIdl)
      ? targetIdl
      : bundledIdl;

  const mandateId = BigInt(env.VETO_MANDATE_ID ?? "1");
  const kwhMilli = BigInt(env.VETO_KWH_MILLI ?? DEFAULT_KWH_MILLI.toString());
  const mintDecimals = Number.parseInt(env.VETO_MINT_DECIMALS ?? String(DEFAULT_MINT_DECIMALS), 10);
  const cap = BigInt(env.VETO_CAP ?? "100000000");
  const perTxMax = BigInt(env.VETO_PER_TX_MAX ?? "500000");

  const rpcs = parseRpcList(pick(env, merged, "VETO_RPC", DEFAULTS.rpc));
  if (rpcs.length === 0) {
    throw new Error("VETO_RPC has no endpoints");
  }

  return {
    rpc: rpcs[0]!,
    rpcs,
    keysDir,
    journalPath,
    idlPath,
    programId: pick(env, merged, "VETO_PROGRAM_ID", DEFAULTS.programId),
    mint: pick(env, merged, "VETO_MINT", DEFAULTS.mint),
    owner: pick(env, merged, "VETO_OWNER", DEFAULTS.owner),
    ownerTokenAccount: pick(env, merged, "VETO_OWNER_TOKEN", DEFAULTS.ownerTokenAccount),
    merchant: pick(env, merged, "VETO_MERCHANT", DEFAULTS.merchant),
    merchantTokenAccount: pick(env, merged, "VETO_MERCHANT_TOKEN", DEFAULTS.merchantTokenAccount),
    agent: pick(env, merged, "VETO_AGENT", DEFAULTS.agent),
    mandateId,
    kwhMilli,
    mintDecimals,
    cap,
    perTxMax,
    purpose: env.VETO_PURPOSE ?? "SE3 home charging",
  };
}

export function keyPath(cfg: WatcherConfig, name: "agent" | "owner" | "merchant" | "deployer"): string {
  return join(cfg.keysDir, `${name}.json`);
}
