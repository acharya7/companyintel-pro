/**
 * Bounded per-isolate object cache for the immutable parts of the index, plus
 * the per-search R2 accounting the API reports.
 *
 * Why this exists
 * ---------------
 * A search against a real dataset reads the same objects again and again:
 *
 *   - the index directory (`indexes/<version>/directory.json`) is read by every
 *     request that needs the shard counts;
 *   - popular shards (the shard a common term hashes to, the shard for a
 *     company's profile partition on a detail page) are re-read by every query
 *     that touches them, and a Cloudflare isolate serves many requests;
 *   - the engine's own adaptive retries and deferred fuzzy stages ask for
 *     candidates it has already looked at.
 *
 * Every one of those objects is immutable and version-addressed, so caching one
 * is not a consistency trade-off — it is the same bytes for the same key. What
 * it must *not* be is unbounded: this cache holds a few hundred small objects,
 * never "the index", and it never caches a mutable `app-data/` object.
 *
 * Three jobs are kept separate on purpose:
 *
 *   1. `ObjectCache`   — the bounded store itself (LRU by entry count and by
 *                        bytes, with a maximum age) plus in-flight de-duplication,
 *                        so two concurrent reads of one key are one R2 GET.
 *   2. `searchCacheFor` — one cache per R2 bucket binding, held weakly. A Worker
 *                        isolate only ever has one binding, and tests build a new
 *                        bucket per case, so no entry can leak from one dataset
 *                        (or one test) to another.
 *   3. `ReadMetrics`   — what actually left R2 for *this* request: objects,
 *                        bytes, shards and partitions. Counted separately from
 *                        cache hits/misses so the two can be reported side by
 *                        side (`objectsRead === cacheMisses` by construction).
 */

/** Object key prefixes whose contents are immutable once published. */
const CACHEABLE_PREFIXES = ["indexes/", "companies/", "contacts/"] as const;

/**
 * True when an object may be cached.
 *
 * `app-data/` (leads, settings, saved searches, exports) and `manifests/`
 * (including the single mutable `active.json`) are deliberately excluded: they
 * are mutable, and a stale read of them is a correctness bug rather than a
 * performance detail.
 */
export function isCacheableKey(key: string): boolean {
  for (const prefix of CACHEABLE_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export interface CachedObject {
  bytes: Uint8Array;
  /** True when the body is gzip-compressed (metadata said so, or magic bytes). */
  gzip: boolean;
}

export interface ObjectCacheOptions {
  /** Maximum entries held. Default 512 (≈ a few hundred shards / partitions). */
  maxEntries?: number;
  /** Maximum total bytes held. Default 16 MiB. */
  maxBytes?: number;
  /** Maximum age of an entry, so a corrected object is never served forever. */
  maxAgeMs?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expired: number;
  entries: number;
  bytes: number;
}

export const DEFAULT_CACHE_OPTIONS = {
  maxEntries: 512,
  maxBytes: 16 * 1024 * 1024,
  maxAgeMs: 10 * 60 * 1000,
} as const;

export class ObjectCache {
  private readonly entries = new Map<string, { object: CachedObject; storedAt: number }>();
  private readonly inflight = new Map<string, Promise<CachedObject | null>>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expired = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;

  constructor(options: ObjectCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_CACHE_OPTIONS.maxEntries);
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_CACHE_OPTIONS.maxBytes);
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_CACHE_OPTIONS.maxAgeMs);
  }

  /** Cached object, or undefined. A hit refreshes the entry's LRU position. */
  get(key: string, now: number = Date.now()): CachedObject | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.maxAgeMs > 0 && now - entry.storedAt > this.maxAgeMs) {
      this.entries.delete(key);
      this.bytes -= entry.object.bytes.length;
      this.expired += 1;
      return undefined;
    }
    // Re-insert: `Map` iteration order is insertion order, so the newest entry
    // is the last one and eviction can take the first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.object;
  }

  /** Store an object, evicting until the entry and byte bounds both hold. */
  set(key: string, object: CachedObject, now: number = Date.now()): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= existing.object.bytes.length;
      this.entries.delete(key);
    }
    this.entries.set(key, { object, storedAt: now });
    this.bytes += object.bytes.length;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted) this.bytes -= evicted.object.bytes.length;
      this.evictions += 1;
    }
  }

  /**
   * Serve a read from the cache, an in-flight read of the same key, or `read`.
   *
   * The in-flight map is what makes concurrent identical reads one R2 GET: the
   * worker's parallel `mapLimit(…, 8)` fan-out can legitimately ask for the same
   * object twice (a retry, two batches of the same partition) and the second
   * caller must join the first request rather than duplicate it.
   */
  load(key: string, read: () => Promise<CachedObject | null>): Promise<CachedObject | null> {
    const cached = this.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    this.misses += 1;
    const promise = read()
      .then((object) => {
        if (object) this.set(key, object);
        return object;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expired: this.expired,
      entries: this.entries.size,
      bytes: this.bytes,
    };
  }

  /** Hits/misses so far — a caller snapshots this to get a per-request delta. */
  counters(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
    this.bytes = 0;
  }
}

/**
 * One cache per R2 binding, held weakly so a bucket that goes away takes its
 * cached objects with it. Keyed by bindings *and* by the version inside every
 * object key, so two datasets in one isolate can never serve each other's bytes.
 */
const bucketCaches = new WeakMap<object, ObjectCache>();

export function searchCacheFor(bucket: object, options?: ObjectCacheOptions): ObjectCache {
  const existing = bucketCaches.get(bucket);
  if (existing) return existing;
  const created = new ObjectCache(options);
  bucketCaches.set(bucket, created);
  return created;
}

/**
 * What this request actually fetched from R2, counted per read so the API can
 * report a search's real transfer cost instead of a modelled one.
 */
export class ReadMetrics {
  /** Objects actually fetched from R2 while answering the request. */
  objectsRead = 0;
  bytesRead = 0;
  /** Index shard objects fetched from R2 (the directory is not a shard). */
  shardGets = 0;
  /** Company profile partitions fetched from R2. */
  partitionGets = 0;
  /**
   * Shard objects the search *asked* for — served from the cache or from R2.
   * Together with `shardGets` this is the cache's saving for the query.
   */
  shardRequests = 0;
  /** Company partitions the search asked for, cache-served or not. */
  partitionRequests = 0;
  /** Cache hits/misses snapshotted around the request (see `snapshotCache`). */
  cacheHits = 0;
  cacheMisses = 0;

  recordObject(key: string, bytes: number): void {
    this.objectsRead += 1;
    this.bytesRead += bytes;
    // The directory is an index object but not a shard: it is read once per
    // request (and then cached), so counting it as a shard would overstate a
    // search's shard traffic.
    if (key.startsWith("indexes/")) {
      if (!key.endsWith("/directory.json")) this.shardGets += 1;
    } else if (key.startsWith("companies/")) {
      this.partitionGets += 1;
    }
  }

  /** Freeze the cache counters before the work, so the delta is this search. */
  snapshotCache(cache: ObjectCache): { hits: number; misses: number } {
    return cache.counters();
  }

  /** Record the cache delta measured around the work. */
  recordCacheDelta(cache: ObjectCache, before: { hits: number; misses: number }): void {
    const after = cache.counters();
    this.cacheHits = after.hits - before.hits;
    this.cacheMisses = after.misses - before.misses;
  }

  toJSON(): {
    objectsRead: number;
    bytesRead: number;
    shardGets: number;
    partitionGets: number;
    shardRequests: number;
    partitionRequests: number;
    cacheHits: number;
    cacheMisses: number;
  } {
    return {
      objectsRead: this.objectsRead,
      bytesRead: this.bytesRead,
      shardGets: this.shardGets,
      partitionGets: this.partitionGets,
      shardRequests: this.shardRequests,
      partitionRequests: this.partitionRequests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
    };
  }
}
