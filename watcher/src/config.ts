import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KWH_MILLI, DEFAULT_MINT_DECIMALS } from "./money.js";

export const WATCHER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = join(WATCHER_DIR, "..");
export const TERMINAL_DIR = join(REPO_DIR, "terminal");

const SHORT_TO_VETO: Record<string, string> = {
  RPC: "VETO_RPC",
  PROGRAM_ID: "VETO_PROGRAM_ID",
  MINT: "VETO_MINT",
  OWNER: "VETO_OWNER",
  OWNER_TOKEN_ACCOUNT: "VETO_OWNER_TOKEN",
  MERCHANT: "VETO_MERCHANT",
  MERCHANT_TOKEN_ACCOUNT: "VETO_MERCHANT_TOKEN",
  AGENT: "VETO_AGENT",
  KWH_MILLI: "VETO_KWH_MILLI",
  MINT_DECIMALS: "VETO_MINT_DECIMALS",
  TERMINAL_PORT: "VETO_TERMINAL_PORT",
};

export type WatcherConfig = {
  rpc: string;
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

export type LoadConfigOpts = {
  /** Override the default env-file list. Tests use this so they do not touch package .env files. */
  envFiles?: string[];
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

function normalizeFileMap(raw: Map<string, string>, path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of raw) {
    const vetoKey = k.startsWith("VETO_") ? k : (SHORT_TO_VETO[k] ?? k);
    const existing = out.get(vetoKey);
    if (existing !== undefined && existing !== v) {
      throw new Error(`config.loadConfig: ${vetoKey} is set twice in ${path}`);
    }
    out.set(vetoKey, v);
  }
  return out;
}

function defaultEnvFiles(keysDir: string): string[] {
  return [
    join(keysDir, "devnet-addresses.env"),
    join(WATCHER_DIR, ".env"),
    join(TERMINAL_DIR, ".env"),
  ];
}

/** Merge env files. A key set to two different values is an error, not a silent last-write. */
export function loadMergedEnvFiles(env: NodeJS.ProcessEnv = process.env, envFiles?: string[]): Map<string, string> {
  const keysDir = resolvePath(env.VETO_KEYS_DIR ?? join(REPO_DIR, "keys"), WATCHER_DIR);
  const files = envFiles ?? defaultEnvFiles(keysDir);
  const out = new Map<string, string>();
  const source = new Map<string, string>();
  for (const path of files) {
    const norm = normalizeFileMap(parseEnvFile(path), path);
    for (const [k, v] of norm) {
      const prev = out.get(k);
      if (prev !== undefined && prev !== v) {
        throw new Error(
          `config.loadConfig: ${k} disagrees between ${source.get(k) ?? "?"} (${prev}) and ${path} (${v})`,
        );
      }
      out.set(k, v);
      source.set(k, path);
    }
  }
  return out;
}

export function lookupConfigString(
  env: NodeJS.ProcessEnv,
  key: string,
  opts?: LoadConfigOpts,
): string | undefined {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const files = loadMergedEnvFiles(env, opts?.envFiles);
  const fromFile = files.get(key);
  if (fromFile !== undefined && fromFile.length > 0) return fromFile;
  return undefined;
}

function required(env: NodeJS.ProcessEnv, files: Map<string, string>, key: string): string {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const fromFile = files.get(key);
  if (fromFile !== undefined && fromFile.length > 0) return fromFile;
  throw new Error(
    `config.loadConfig: missing ${key}; set it in the environment, keys/devnet-addresses.env, watcher/.env, or terminal/.env`,
  );
}

function resolvePath(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts?: LoadConfigOpts): WatcherConfig {
  const keysDir = resolvePath(env.VETO_KEYS_DIR ?? join(REPO_DIR, "keys"), WATCHER_DIR);
  const files = loadMergedEnvFiles(env, opts?.envFiles ?? defaultEnvFiles(keysDir));

  const journalPath = resolvePath(env.VETO_JOURNAL ?? join(WATCHER_DIR, "data", "decisions.jsonl"), WATCHER_DIR);
  const targetIdl = join(REPO_DIR, "target", "idl", "veto.json");
  const bundledIdl = join(WATCHER_DIR, "idl", "veto.json");
  const idlPath = env.VETO_IDL
    ? resolvePath(env.VETO_IDL, WATCHER_DIR)
    : existsSync(targetIdl)
      ? targetIdl
      : bundledIdl;

  const mandateId = BigInt(env.VETO_MANDATE_ID ?? "1");
  const kwhMilli = BigInt(lookupFrom(env, files, "VETO_KWH_MILLI") ?? DEFAULT_KWH_MILLI.toString());
  const mintDecimals = Number.parseInt(
    lookupFrom(env, files, "VETO_MINT_DECIMALS") ?? String(DEFAULT_MINT_DECIMALS),
    10,
  );
  const cap = BigInt(env.VETO_CAP ?? "100000000");
  const perTxMax = BigInt(env.VETO_PER_TX_MAX ?? "500000");

  return {
    rpc: required(env, files, "VETO_RPC"),
    keysDir,
    journalPath,
    idlPath,
    programId: required(env, files, "VETO_PROGRAM_ID"),
    mint: required(env, files, "VETO_MINT"),
    owner: required(env, files, "VETO_OWNER"),
    ownerTokenAccount: required(env, files, "VETO_OWNER_TOKEN"),
    merchant: required(env, files, "VETO_MERCHANT"),
    merchantTokenAccount: required(env, files, "VETO_MERCHANT_TOKEN"),
    agent: required(env, files, "VETO_AGENT"),
    mandateId,
    kwhMilli,
    mintDecimals,
    cap,
    perTxMax,
    purpose: env.VETO_PURPOSE ?? "SE3 home charging",
  };
}

function lookupFrom(env: NodeJS.ProcessEnv, files: Map<string, string>, key: string): string | undefined {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const fromFile = files.get(key);
  if (fromFile !== undefined && fromFile.length > 0) return fromFile;
  return undefined;
}

export function keyPath(cfg: WatcherConfig, name: "agent" | "owner" | "merchant" | "deployer"): string {
  return join(cfg.keysDir, `${name}.json`);
}
