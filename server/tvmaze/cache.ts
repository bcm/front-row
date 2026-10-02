// Tiny in-memory GET cache for TVMaze responses (issue #5).
//
// TVMaze show/episode data changes slowly; serving repeats from memory
// cuts upstream calls more than any pacing cleverness. Cache loss is never
// a correctness issue — a miss just fetches upstream — so in-memory with
// TTL is fine and keeps this out of Postgres. Only 200s are cached.

const CACHE_TTL_MS = 60 * 60_000; // TVMaze data is stable on the order of an hour
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  status: number;
  body: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCachedResponse(url: string, now: number = Date.now()): Response | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  if (now > entry.expiresAt) {
    cache.delete(url);
    return undefined;
  }
  return new Response(entry.body, { status: entry.status });
}

export function putCachedResponse(url: string, status: number, body: string): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Evict the oldest-inserted entry; Map iterates in insertion order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(url, { status, body, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test hook: empty the cache. */
export function clearTvmazeCache(): void {
  cache.clear();
}
