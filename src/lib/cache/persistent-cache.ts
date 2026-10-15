/**
 * Cache layer 2 — persistent browser cache (IndexedDB).
 *
 * Purpose: a repeat visit, a page reload, or a back-navigation should not hit
 * R2 again for a query the user already ran. Entries are keyed with the shared
 * cache-key builders, which include the dataset version — so a new dataset
 * version can never be served stale company/contact data, it simply misses.
 *
 * Privacy:
 *  - Contact email/phone are redacted before caching unless the user opts in
 *    (`retainContactFieldsInCache`), so a shared machine does not accumulate
 *    contactable personal data in IndexedDB.
 *  - `clearAll()` is called when the dataset version changes or the user asks.
 *  - This is a *cache*. Anything not found here is re-fetched from the API; the
 *    application never treats IndexedDB as its source of truth.
 *
 * Bounded storage: entries are evicted LRU-first once `maxEntries` is reached,
 * and every read checks the TTL.
 */

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "companyintel-cache";
const DB_VERSION = 1;
const STORE = "entries";

interface CacheEntry {
  key: string;
  value: unknown;
  storedAt: number;
  lastAccess: number;
  datasetVersion: string;
  bytes: number;
  redacted: boolean;
}

export interface PersistentCacheOptions {
  enabled: boolean;
  ttlMinutes: number;
  maxEntries: number;
  redactContacts: boolean;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  errors: number;
  redactions: number;
}

export const cacheMetrics: CacheMetrics = {
  hits: 0,
  misses: 0,
  writes: 0,
  evictions: 0,
  errors: 0,
  redactions: 0,
};

export function resetCacheMetrics(): void {
  cacheMetrics.hits = 0;
  cacheMetrics.misses = 0;
  cacheMetrics.writes = 0;
  cacheMetrics.evictions = 0;
  cacheMetrics.errors = 0;
  cacheMetrics.redactions = 0;
}

/** Rough byte size of a cached value, used only for the storage report. */
function estimateBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

const CONTACT_MARKER_KEYS = ["email", "phone"];

/**
 * Remove contactable fields from a value before it is persisted.
 * Works on single contacts, contact arrays and nested response objects.
 */
function redactSensitive(value: unknown): { value: unknown; redacted: boolean } {
  let redacted = false;
  const walk = (node: unknown, inContact: boolean): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, inContact));
    }
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const looksLikeContact =
        typeof record.fullName === "string" && typeof record.companyId === "string" && ("title" in record || "designation" in record);
      const isContact = inContact || looksLikeContact;
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(record)) {
        if (isContact && CONTACT_MARKER_KEYS.includes(key) && raw) {
          delete out[key];
          redacted = true;
          continue;
        }
        out[key] = walk(raw, isContact);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value, false), redacted };
}

class PersistentCache {
  private db: IDBPDatabase | null = null;
  private opening: Promise<IDBPDatabase | null> | null = null;

  private async connect(): Promise<IDBPDatabase | null> {
    if (typeof indexedDB === "undefined") return null;
    if (this.db) return this.db;
    if (!this.opening) {
      this.opening = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: "key" });
            store.createIndex("datasetVersion", "datasetVersion");
            store.createIndex("lastAccess", "lastAccess");
          }
        },
      })
        .then((db) => {
          this.db = db;
          return db;
        })
        .catch(() => null);
    }
    return this.opening;
  }

  async get<T>(key: string, options: PersistentCacheOptions): Promise<T | null> {
    if (!options.enabled) {
      cacheMetrics.misses += 1;
      return null;
    }
    const db = await this.connect();
    if (!db) {
      cacheMetrics.misses += 1;
      return null;
    }
    try {
      const entry = (await db.get(STORE, key)) as CacheEntry | undefined;
      if (!entry) {
        cacheMetrics.misses += 1;
        return null;
      }
      const ageMs = Date.now() - entry.storedAt;
      if (ageMs > options.ttlMinutes * 60_000) {
        await db.delete(STORE, key);
        cacheMetrics.misses += 1;
        return null;
      }
      entry.lastAccess = Date.now();
      await db.put(STORE, entry);
      cacheMetrics.hits += 1;
      return entry.value as T;
    } catch {
      cacheMetrics.errors += 1;
      cacheMetrics.misses += 1;
      return null;
    }
  }

  async set(key: string, value: unknown, datasetVersion: string, options: PersistentCacheOptions): Promise<void> {
    if (!options.enabled) return;
    const db = await this.connect();
    if (!db) return;
    try {
      let payload = value;
      let redacted = false;
      if (options.redactContacts) {
        const result = redactSensitive(value);
        payload = result.value;
        redacted = result.redacted;
        if (redacted) cacheMetrics.redactions += 1;
      }
      const entry: CacheEntry = {
        key,
        value: payload,
        storedAt: Date.now(),
        lastAccess: Date.now(),
        datasetVersion,
        bytes: estimateBytes(payload),
        redacted,
      };
      await db.put(STORE, entry);
      cacheMetrics.writes += 1;
      await this.evict(options);
    } catch {
      // Quota or serialization failures must never break the request path.
      cacheMetrics.errors += 1;
    }
  }

  private async evict(options: PersistentCacheOptions): Promise<void> {
    const db = await this.connect();
    if (!db) return;
    try {
      const count = await db.count(STORE);
      const overflow = count - options.maxEntries;
      if (overflow <= 0) return;
      const tx = db.transaction(STORE, "readwrite");
      let removed = 0;
      let cursor = await tx.store.index("lastAccess").openCursor();
      while (cursor && removed < overflow) {
        await cursor.delete();
        removed += 1;
        cursor = await cursor.continue();
      }
      await tx.done;
      cacheMetrics.evictions += removed;
    } catch {
      cacheMetrics.errors += 1;
    }
  }

  /** Drop everything belonging to a non-active dataset version. */
  async invalidateExcept(datasetVersion: string | null): Promise<number> {
    const db = await this.connect();
    if (!db) return 0;
    try {
      const tx = db.transaction(STORE, "readwrite");
      let removed = 0;
      let cursor = await tx.store.openCursor();
      while (cursor) {
        if (datasetVersion === null || cursor.value.datasetVersion !== datasetVersion) {
          await cursor.delete();
          removed += 1;
        }
        cursor = await cursor.continue();
      }
      await tx.done;
      if (removed) cacheMetrics.evictions += removed;
      return removed;
    } catch {
      cacheMetrics.errors += 1;
      return 0;
    }
  }

  async clearAll(): Promise<void> {
    const db = await this.connect();
    if (!db) return;
    try {
      await db.clear(STORE);
    } catch {
      cacheMetrics.errors += 1;
    }
  }

  async stats(): Promise<{ entries: number; bytes: number; redactedEntries: number }> {
    const db = await this.connect();
    if (!db) return { entries: 0, bytes: 0, redactedEntries: 0 };
    try {
      let entries = 0;
      let bytes = 0;
      let redactedEntries = 0;
      let cursor = await db.transaction(STORE).store.openCursor();
      while (cursor) {
        entries += 1;
        bytes += cursor.value.bytes ?? 0;
        if (cursor.value.redacted) redactedEntries += 1;
        cursor = await cursor.continue();
      }
      return { entries, bytes, redactedEntries };
    } catch {
      cacheMetrics.errors += 1;
      return { entries: 0, bytes: 0, redactedEntries: 0 };
    }
  }
}

export const persistentCache = new PersistentCache();
