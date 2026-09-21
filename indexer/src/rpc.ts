import { Connection } from "@solana/web3.js";

const RETRY_RE =
  /\b429\b|503|504|timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed|rate limit|Too many requests|socket hang up|Connect Timeout|503 Service/i;

const SKIP_RE =
  /cleaned up|does not exist on node|Block not available|Slot \d+ was skipped|was skipped, or missing/i;

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
  maxDelayMs?: number;
  maxPasses?: number;
};

const RATE_LIMIT_RE = /\b429\b|too many requests|rate limit/i;

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
    assertHttpUrl(part);
    seen.add(part);
    out.push(part);
  }
  return out;
}

function assertHttpUrl(part: string): void {
  let url: URL;
  try {
    url = new URL(part);
  } catch {
    throw new Error(`invalid rpc endpoint: ${part}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid rpc endpoint: ${part}`);
  }
  if (url.hostname.length === 0) {
    throw new Error(`invalid rpc endpoint: ${part}`);
  }
}

export function isRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitedError) return true;
  if (typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "RateLimitedError") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_RE.test(msg);
}

export function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (SKIP_RE.test(msg)) return false;
  return RETRY_RE.test(msg);
}

export function isSkippableSlot(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return SKIP_RE.test(msg);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { attempts?: number; baseDelayMs?: number; log?: (line: string) => void },
): Promise<T> {
  const attempts = opts?.attempts ?? 5;
  const base = opts?.baseDelayMs ?? 250;
  const log = opts?.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || i === attempts - 1) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${label}: ${msg}`);
      }
      const delay = base * 2 ** i;
      const msg = err instanceof Error ? err.message : String(err);
      if (isRateLimitError(err)) {
        log(`${label}: rpc rate limited, retry in ${delay}ms`);
      } else {
        log(`${label}: rpc failure, retry in ${delay}ms: ${msg}`);
      }
      await sleep(delay);
    }
  }
  throw last instanceof Error ? last : new Error(`${label}: retry exhausted`);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function nextDelay(delay: number, cap: number): number {
  if (delay <= 0) return delay;
  const doubled = delay * 2;
  return doubled > cap ? cap : doubled;
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
  const maxDelayMs = opts.maxDelayMs ?? 8_000;
  const maxPasses = opts.maxPasses ?? 5;

  return async (input, init) => {
    let delay = initialDelayMs;
    let lastErr: unknown;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      for (let i = 0; i < list.length; i += 1) {
        const endpoint = list[i]!;
        const url = i === 0 ? requestUrl(input) : endpoint;
        const hasMore = i + 1 < list.length || pass + 1 < maxPasses;
        try {
          const res = await doFetch(url, init);
          if (res.status === 429) {
            log(`rpc rate limited on ${endpoint}`);
            lastErr = new RateLimitedError(`rpc rate limited on ${endpoint}`, list);
            if (!hasMore) throw lastErr;
            if (delay > 0) await sleepFn(delay);
            delay = nextDelay(delay, maxDelayMs);
            continue;
          }
          return res;
        } catch (err) {
          if (err instanceof RateLimitedError && !hasMore) throw err;
          lastErr = err;
          if (isRateLimitError(err)) {
            if (!(err instanceof RateLimitedError)) {
              log(`rpc rate limited on ${endpoint}`);
            }
            if (!hasMore) {
              throw err instanceof RateLimitedError
                ? err
                : new RateLimitedError("rpc rate limited on all endpoints", list);
            }
            if (delay > 0) await sleepFn(delay);
            delay = nextDelay(delay, maxDelayMs);
            continue;
          }
          throw err;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new RateLimitedError("rpc rate limited on all endpoints", list);
  };
}

export function createFailoverConnection(
  endpoints: readonly string[],
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
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

export function clampPageSize(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 200;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 1000) return 1000;
  return i;
}

export async function paginateNewestFirst<T extends { signature: string }>(
  fetchPage: (before?: string) => Promise<T[]>,
  pageSize: number,
): Promise<{ items: T[]; pageCount: number }> {
  const items: T[] = [];
  let pageCount = 0;
  let before: string | undefined;
  for (;;) {
    const batch = await fetchPage(before);
    if (batch.length === 0) break;
    pageCount += 1;
    items.push(...batch);
    if (batch.length < pageSize) break;
    const last = batch[batch.length - 1];
    if (!last) break;
    before = last.signature;
  }
  return { items, pageCount };
}
