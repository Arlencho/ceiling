import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const INDEXER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = join(INDEXER_DIR, "..");

const SHORT_TO_VETO: Record<string, string> = {
  RPC: "VETO_RPC",
  PROGRAM_ID: "VETO_PROGRAM_ID",
  MINT: "VETO_MINT",
  OWNER: "VETO_OWNER",
  OWNER_TOKEN_ACCOUNT: "VETO_OWNER_TOKEN",
  MERCHANT: "VETO_MERCHANT",
  MERCHANT_TOKEN_ACCOUNT: "VETO_MERCHANT_TOKEN",
  AGENT: "VETO_AGENT",
};

const SEARCHED = ["keys/devnet-addresses.env", "indexer/.env"];

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

function normalizeFileMap(raw: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of raw) {
    const vetoKey = k.startsWith("VETO_") ? k : (SHORT_TO_VETO[k] ?? k);
    out.set(vetoKey, v);
  }
  return out;
}

function defaultEnvFiles(keysDir: string): string[] {
  return [join(keysDir, "devnet-addresses.env"), join(INDEXER_DIR, ".env")];
}

export function loadMergedEnvFiles(
  env: NodeJS.ProcessEnv = process.env,
  envFiles?: string[],
): Map<string, string> {
  const keysDir = env.VETO_KEYS_DIR && env.VETO_KEYS_DIR.length > 0
    ? resolve(env.VETO_KEYS_DIR)
    : join(REPO_DIR, "keys");
  const files = envFiles ?? defaultEnvFiles(keysDir);
  const out = new Map<string, string>();
  for (const path of files) {
    for (const [k, v] of normalizeFileMap(parseEnvFile(path))) {
      out.set(k, v);
    }
  }
  return out;
}

export function required(
  env: NodeJS.ProcessEnv,
  files: Map<string, string>,
  key: string,
): string {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const fromFile = files.get(key);
  if (fromFile !== undefined && fromFile.length > 0) return fromFile;
  throw new Error(
    `config.loadConfig: missing ${key}; set it in the environment, ${SEARCHED.join(", ")}`,
  );
}

export function requiredIdentity(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  opts?: LoadConfigOpts,
): string {
  return required(env, loadMergedEnvFiles(env, opts?.envFiles), key);
}
