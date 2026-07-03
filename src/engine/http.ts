// Shared HTTP layer for every data source. The engine runs live during the demo
// and must survive transient failures and rate limits from the free public APIs
// (DexScreener, Honeypot.is, GoPlus), so all fetches go through here to get:
//   - a hard timeout (no hung requests stalling a CAP order),
//   - bounded retries with exponential backoff + jitter on network errors, 5xx,
//     and 429 (honouring Retry-After when the server sends it),
//   - a short in-memory TTL cache to dedupe repeated identical lookups under load.
//
// Verifiability note: the cache stores the ORIGINAL fetch timestamp and returns
// it, so a cited `fetchedAt` always reflects when the data actually left the
// upstream — a cache hit never back-dates or forward-dates a citation.

export interface FetchJsonResult<T> {
  data: T;
  /** ISO-8601 time the data actually left the upstream (preserved across cache hits). */
  fetchedAt: string;
  /** True when served from the in-memory cache rather than a fresh network call. */
  cached: boolean;
}

export interface FetchJsonOptions {
  timeoutMs?: number;
  /** Number of RETRIES after the first attempt (so total attempts = retries + 1). */
  retries?: number;
  /** Cache TTL in ms. 0 disables caching for this call. */
  cacheTtlMs?: number;
  accept?: string;
  /** Base backoff in ms (exposed mainly so tests can run without real delay). */
  retryBaseMs?: number;
  /** Injectable fetch, for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  timeoutMs: 8_000,
  retries: 2,
  cacheTtlMs: 15_000,
  accept: "application/json",
  retryBaseMs: 300,
};

const MAX_BACKOFF_MS = 3_000;
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  fetchedAt: string;
  expires: number;
  data: unknown;
}
const cache = new Map<string, CacheEntry>();

/** Clear the HTTP cache (used by tests; harmless in production). */
export function clearHttpCache(): void {
  cache.clear();
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(base: number, attempt: number): number {
  const raw = Math.min(MAX_BACKOFF_MS, base * 2 ** attempt);
  return Math.round(raw * (0.8 + Math.random() * 0.4)); // ±20% jitter
}

// Parse a Retry-After header: either delta-seconds or an HTTP date.
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // Simple FIFO trim — insertion order is preserved by Map.
  const excess = cache.size - MAX_CACHE_ENTRIES;
  let i = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    if (++i >= excess) break;
  }
}

/**
 * GET a URL and parse JSON, with timeout + retry + backoff + optional caching.
 * Throws HttpError on non-retryable HTTP status, or the last error after
 * exhausting retries. Callers that treat a source as optional should catch and
 * fall back to null.
 */
export async function fetchJson<T = any>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<FetchJsonResult<T>> {
  const opts = { ...DEFAULTS, ...options };
  const doFetch = opts.fetchImpl ?? fetch;

  if (opts.cacheTtlMs > 0) {
    const hit = cache.get(url);
    if (hit && hit.expires > Date.now()) {
      return { data: hit.data as T, fetchedAt: hit.fetchedAt, cached: true };
    }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await doFetch(url, {
        headers: { accept: opts.accept },
        signal: controller.signal,
      });

      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < opts.retries) {
          const wait = retryAfterMs(res.headers?.get?.("retry-after") ?? null) ?? backoff(opts.retryBaseMs, attempt);
          clearTimeout(timer);
          await sleep(wait);
          continue;
        }
        throw new HttpError(res.status, url);
      }

      const fetchedAt = new Date().toISOString();
      const data = (await res.json()) as T;
      if (opts.cacheTtlMs > 0) {
        cache.set(url, { fetchedAt, expires: Date.now() + opts.cacheTtlMs, data });
        evictIfNeeded();
      }
      return { data, fetchedAt, cached: false };
    } catch (e) {
      lastErr = e;
      // Non-retryable HTTP status: fail fast (don't waste retries on a 404).
      if (e instanceof HttpError && !RETRYABLE_STATUS.has(e.status)) throw e;
      if (attempt < opts.retries) {
        await sleep(backoff(opts.retryBaseMs, attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`fetch failed for ${url}`);
}
