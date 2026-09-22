import { Connection } from "@solana/web3.js";

export function redactRpcUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid-rpc-url";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid-rpc-url";
  if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0 && url.hash.length === 0) {
    return raw;
  }
  const host = url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname;
  const port = url.port.length > 0 ? `:${url.port}` : "";
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${host}${port}${path}`;
}

export function redactRpcUrls(urls: readonly string[]): string {
  return urls.map((url) => redactRpcUrl(url)).join(",");
}

export function redactRpcUrlsInText(message: string): string {
  return message.replace(/https?:\/\/[^\s]+/g, (match) => {
    const trimmed = match.replace(/[),.;]+$/g, "");
    return redactRpcUrl(trimmed) + match.slice(trimmed.length);
  });
}

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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
            const shown = redactRpcUrl(endpoint);
            log(`rpc rate limited on ${shown}`);
            lastErr = new RateLimitedError(`rpc rate limited on ${shown}`, list);
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
              log(`rpc rate limited on ${redactRpcUrl(endpoint)}`);
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


