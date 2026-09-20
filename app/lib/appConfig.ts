export type AppConfig = {
  rpcUrl: string;
  programId: string;
  mint: string | null;
  explorerCluster: string;
  mintDecimals: number;
};

function pick(
  extra: Record<string, unknown>,
  extraKey: string,
  env: Record<string, string | undefined>,
  envKey: string,
): string {
  const fromExtra = extra[extraKey];
  if (typeof fromExtra === 'string' && fromExtra.trim().length > 0) {
    return fromExtra.trim();
  }
  const fromEnv = env[envKey];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return '';
}

function parseDecimals(raw: string): number {
  if (raw.length === 0) {
    return 6;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 18) {
    throw new Error('mint decimals must be an integer from 0 to 18');
  }
  return n;
}

export function configFromExtra(
  extra: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): AppConfig {
  const rpcUrl = pick(extra, 'vetoRpc', env, 'EXPO_PUBLIC_VETO_RPC');
  if (rpcUrl.length === 0) {
    throw new Error(
      'RPC url is missing from config. Set EXPO_PUBLIC_VETO_RPC as documented in app/README.md.',
    );
  }
  const programId = pick(extra, 'vetoProgramId', env, 'EXPO_PUBLIC_VETO_PROGRAM_ID');
  if (programId.length === 0) {
    throw new Error(
      'Program id is missing from config. Set EXPO_PUBLIC_VETO_PROGRAM_ID as documented in app/README.md.',
    );
  }
  const mintRaw = pick(extra, 'vetoMint', env, 'EXPO_PUBLIC_VETO_MINT');
  const decimalsRaw = pick(extra, 'vetoMintDecimals', env, 'EXPO_PUBLIC_VETO_MINT_DECIMALS');
  const explorerCluster =
    pick(extra, 'vetoExplorerCluster', env, 'EXPO_PUBLIC_VETO_EXPLORER_CLUSTER') || 'devnet';
  return {
    rpcUrl,
    programId,
    mint: mintRaw.length > 0 ? mintRaw : null,
    explorerCluster,
    mintDecimals: parseDecimals(decimalsRaw),
  };
}

export function tryConfigFromExtra(
  extra: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): { ok: true; config: AppConfig } | { ok: false; error: string } {
  try {
    return { ok: true, config: configFromExtra(extra, env) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Config is invalid' };
  }
}
