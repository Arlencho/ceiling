import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

// Callers may pass a partial env. This package merges a required NODE_ENV into
// ProcessEnv, and these checks only read VETO_KEYS_DIR.
type KeysEnv = {
  VETO_KEYS_DIR?: string;
};

// VETO_KEYS_DIR when it is set, otherwise <repo>/keys. Same rule as tools/lib.ts keysDir.
export function resolveKeysDir(repoRoot: string, env?: KeysEnv): string {
  const fromEnv = (env ?? process.env).VETO_KEYS_DIR;
  if (fromEnv && fromEnv.length > 0) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(repoRoot, fromEnv);
  }
  return join(repoRoot, 'keys');
}

function deployerKeyPath(repoRoot: string, env?: KeysEnv): string {
  return join(resolveKeysDir(repoRoot, env), 'deployer.json');
}

export function readDeployerKey(repoRoot: string, env?: KeysEnv): string {
  const path = deployerKeyPath(repoRoot, env);
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (isMissing(err)) {
      throw new Error(`devnet journey: deployer key not found at ${path}`);
    }
    throw err;
  }
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}
