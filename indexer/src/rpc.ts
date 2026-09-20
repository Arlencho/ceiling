const RETRY_RE =
  /429|503|504|timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed|rate limit|Too many requests|socket hang up|Connect Timeout|503 Service/i;

const SKIP_RE =
  /cleaned up|does not exist on node|Block not available|Slot \d+ was skipped|was skipped, or missing/i;

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
  opts?: { attempts?: number; baseDelayMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 5;
  const base = opts?.baseDelayMs ?? 250;
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
      await sleep(base * 2 ** i);
    }
  }
  throw last instanceof Error ? last : new Error(`${label}: retry exhausted`);
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
