export function config(env: NodeJS.ProcessEnv, smoke: boolean) {
  const endpoint = new URL(env.VETO_RPC ?? 'http://127.0.0.1:18899');
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('VETO_RPC must be a plain HTTP localhost URL');
  }
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const port = Number(endpoint.port || 80);
  if (port < 1024 || port > 65530) throw new Error('RPC port must be between 1024 and 65530');
  return { rpc: `http://127.0.0.1:${port}`, port, n: smoke ? 10 : positive('N', 200),
    a: positive('A', smoke ? 10 : 50), w: positive('W', 16),
    duration: smoke ? 10 : positive('DURATION_SECONDS', 60) };
}

export function percentile(samples: number[], quantile: number): number | null {
  if (!samples.length) return null;
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * quantile) - 1];
}
