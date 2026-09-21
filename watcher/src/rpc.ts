import { Connection } from "@solana/web3.js";

export class RateLimitedError extends Error {
  readonly endpoints: readonly string[];

  constructor(message: string, endpoints: readonly string[] = []) {
    super(message);
    this.name = "RateLimitedError";
    this.endpoints = endpoints;
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type FailoverFetchOpts = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  initialDelayMs?: number;
};

export function parseRpcList(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null) return [];
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

export function isRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitedError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /429|too many requests|rate limit/i.test(msg);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function makeFailoverFetch(
  endpoints: readonly string[],
  log: (line: string) => void = () => {},
  opts: FailoverFetchOpts = {},
): FetchLike {
  const list = [...endpoints];
  if (list.length === 0) {
    throw new Error("no rpc endpoints configured");
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleepFn = opts.sleep ?? sleep;
  const initialDelayMs = opts.initialDelayMs ?? 250;

  return async (input, init) => {
    let delay = initialDelayMs;
    let lastErr: unknown;
    for (let i = 0; i < list.length; i += 1) {
      const endpoint = list[i]!;
      const url = i === 0 ? requestUrl(input) : endpoint;
      try {
        const res = await doFetch(url, init);
        if (res.status === 429) {
          log(`rpc rate limited on ${endpoint}`);
          lastErr = new RateLimitedError(`rpc rate limited on ${endpoint}`, list);
          if (i + 1 < list.length) {
            if (delay > 0) await sleepFn(delay);
            delay *= 2;
            continue;
          }
          throw lastErr;
        }
        return res;
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        lastErr = err;
        if (isRateLimitError(err) && i + 1 < list.length) {
          log(`rpc rate limited on ${endpoint}`);
          if (delay > 0) await sleepFn(delay);
          delay *= 2;
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new RateLimitedError("rpc rate limited on all endpoints", list);
  };
}

export function createFailoverConnection(
  endpoints: readonly string[],
  log: (line: string) => void = () => {},
  opts: FailoverFetchOpts = {},
): Connection {
  const list = [...endpoints];
  if (list.length === 0) {
    throw new Error("no rpc endpoints configured");
  }
  return new Connection(list[0]!, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: makeFailoverFetch(list, log, opts),
  });
}

export async function withRpcFailover<T>(
  label: string,
  endpoints: readonly string[],
  fn: (endpoint: string) => Promise<T>,
  opts: {
    log?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
    initialDelayMs?: number;
  } = {},
): Promise<T> {
  const list = [...endpoints];
  if (list.length === 0) {
    throw new Error(`${label}: no rpc endpoints configured`);
  }
  const log = opts.log ?? (() => {});
  const sleepFn = opts.sleep ?? sleep;
  let delay = opts.initialDelayMs ?? 250;
  let lastErr: unknown;
  for (let i = 0; i < list.length; i += 1) {
    const endpoint = list[i]!;
    try {
      return await fn(endpoint);
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err)) throw err;
      log(`${label}: rpc rate limited on ${endpoint}`);
      if (i + 1 < list.length) {
        if (delay > 0) await sleepFn(delay);
        delay *= 2;
        continue;
      }
      throw new RateLimitedError(`${label}: rpc rate limited on all endpoints`, list);
    }
  }
  throw lastErr instanceof Error ? lastErr : new RateLimitedError(`${label}: rpc rate limited on all endpoints`, list);
}
