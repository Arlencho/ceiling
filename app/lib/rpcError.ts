export function isRateLimitError(err: unknown): boolean {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message, err.name);
    const extra = err as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
    if (extra.code != null) {
      parts.push(String(extra.code));
    }
    if (extra.status != null) {
      parts.push(String(extra.status));
    }
    if (extra.statusCode != null) {
      parts.push(String(extra.statusCode));
    }
  } else if (typeof err === 'string') {
    parts.push(err);
  } else if (err != null) {
    parts.push(String(err));
  }
  const blob = parts.join(' ').toLowerCase();
  return (
    blob.includes('429') ||
    blob.includes('too many requests') ||
    blob.includes('rate limit') ||
    blob.includes('ratelimit')
  );
}
