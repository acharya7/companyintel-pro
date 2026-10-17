/**
 * The bounded object cache, R2 accounting, and compatibility with a real
 * format-v2 index.
 *
 * Search efficiency is a data-structure question, not a philosophy: a Cloudflare
 * isolate serves many requests, and a search re-reads the same immutable objects
 * (the directory, popular shards, a company's profile partition). What has to be
 * true is narrow and testable:
 *
 *   - an immutable object is fetched from R2 at most once per search, and never
 *     twice concurrently (`load` joins an in-flight read);
 *   - a *mutable* object (`app-data/`, `manifests/`) is never cached — a stale
 *     lead or settings read is a correctness bug, not a latency detail;
 *   - the cache is bounded by entries AND bytes, evicts the least recently used
 *     entry, and expires old ones, so it can never grow into "the index in
 *     Worker memory";
 *   - one bucket's cache is invisible to another bucket, and every key carries
 *     its dataset version;
 *   - none of this changes what a search returns — asserted against a real
 *     format-v2 index produced by the real indexer.
 *
 * The last case runs the operator-facing `scripts/explain-query.mjs` as a child
 * process, because the artifact an operator uses is the script.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ObjectCache, ReadMetrics, isCacheableKey, searchCacheFor } from "../worker/src/search-cache";
import { INDEX_FORMAT_VERSION, isSupportedFormatVersion } from "../src/shared/search/index-format";
import { R2Store } from "../worker/src/store";
import { R2CandidateSource } from "../worker/src/search-source";
import { searchCompanies } from "../src/shared/search/engine";
import { indexDirectoryKey, indexShardKey, companyPartitionKey } from "../src/shared/search/index-format";
import { FakeR2Bucket } from "./helpers/fake-r2";
import { buildFixtureDataset, type FixtureDataset } from "./helpers/fixture-dataset";

const root = join(import.meta.dir, "..");

/**
 * One real index for the whole file.
 *
 * `buildFixtureDataset()` memoises and its directory is shared with
 * `tests/e2e-index.test.ts` and `tests/api-e2e.test.ts`, which run in the same
 * process and read it after this file has finished. It is therefore deliberately
 * NOT cleaned up here: deleting the shared fixture broke those two files (the
 * second reader hit ENOENT on a company partition that had just been removed).
 * The temp directory is left to the OS temp cleaner, as it is for every other
 * file that uses the helper.
 */
let fixture: FixtureDataset;

beforeAll(async () => {
  fixture = await buildFixtureDataset();
});

/* --------------------------------- helpers -------------------------------- */

function object(body: string): { gzip: boolean; bytes: Uint8Array } {
  return { gzip: false, bytes: new TextEncoder().encode(body) };
}

/* ------------------------------ the cache itself --------------------------- */

describe("bounded object cache", () => {
  test("counts hits and misses, and returns the stored object", () => {
    const cache = new ObjectCache();
    const value = { bytes: new Uint8Array([1, 2, 3]), gzip: false };
    expect(cache.get("indexes/v/exact/0000.json.gz")).toBeUndefined();
    cache.set("indexes/v/exact/0000.json.gz", value);
    expect(cache.get("indexes/v/exact/0000.json.gz")).toBe(value);
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(3);
  });

  test("is bounded by entries and evicts the least recently used one", () => {
    const cache = new ObjectCache({ maxEntries: 2 });
    cache.set("a", object("aaa"));
    cache.set("b", object("bbb"));
    cache.get("a"); // `a` becomes the most recently used
    cache.set("c", object("ccc"));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.stats().evictions).toBe(1);
    expect(cache.stats().entries).toBeLessThanOrEqual(2);
  });

  test("is bounded by bytes as well as by count", () => {
    const cache = new ObjectCache({ maxEntries: 100, maxBytes: 1024 });
    for (let i = 0; i < 20; i += 1) cache.set(`k${i}`, { bytes: new Uint8Array(512), gzip: false });
    const stats = cache.stats();
    expect(stats.bytes).toBeLessThanOrEqual(1024);
    expect(stats.entries).toBeLessThanOrEqual(2);
  });

  test("expires an entry that is older than the maximum age", () => {
    const cache = new ObjectCache({ maxAgeMs: 1000 });
    const start = 10_000;
    cache.set("indexes/v/prefix/0001.json.gz", object("x"), start);
    expect(cache.get("indexes/v/prefix/0001.json.gz", start + 500)).toBeDefined();
    expect(cache.get("indexes/v/prefix/0001.json.gz", start + 5000)).toBeUndefined();
    expect(cache.stats().expired).toBe(1);
  });

  test("joins an in-flight read instead of issuing a second one", async () => {
    const cache = new ObjectCache();
    let reads = 0;
    const read = async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return object("payload");
    };
    const [first, second, third] = await Promise.all([
      cache.load("companies/v/00000.json.gz", read),
      cache.load("companies/v/00000.json.gz", read),
      cache.load("companies/v/00000.json.gz", read),
    ]);
    expect(reads).toBe(1);
    expect(cache.stats().misses).toBe(1);
    expect(first).toBe(second);
    expect(second).toBe(third);

    // A later read is a hit, not a fetch.
    await cache.load("companies/v/00000.json.gz", read);
    expect(reads).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });

  test("only immutable index objects are cacheable", () => {
    expect(isCacheableKey(indexShardKey("v1", "trigram", 3))).toBe(true);
    expect(isCacheableKey(companyPartitionKey("v1", 12))).toBe(true);
    expect(isCacheableKey("contacts/v1/00003.json.gz")).toBe(true);
    expect(isCacheableKey(indexDirectoryKey("v1"))).toBe(true);
    // Mutable or unversioned: must never be served from the cache.
    expect(isCacheableKey("app-data/settings.json")).toBe(false);
    expect(isCacheableKey("app-data/leads/003.json")).toBe(false);
    expect(isCacheableKey("manifests/active.json")).toBe(false);
    expect(isCacheableKey("manifests/v1/manifest.json")).toBe(false);
  });

  test("one bucket's cache is invisible to another, and versions do not collide", () => {
    const first = {};
    const second = {};
    expect(searchCacheFor(first)).toBe(searchCacheFor(first));
    expect(searchCacheFor(second)).not.toBe(searchCacheFor(first));

    const cache = new ObjectCache();
    cache.set(indexShardKey("v1", "exact", 0), object("v1 bytes"));
    expect(cache.get(indexShardKey("v2", "exact", 0))).toBeUndefined();
  });
});

/* --------------------------- the store read path -------------------------- */

describe("R2Store read path with a cache", () => {
  test("an immutable object is fetched once and then served from the cache", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes(indexShardKey("v1", "exact", 0), Buffer.from(JSON.stringify({ terms: { tata: { refs: [1] } } })));
    const metrics = new ReadMetrics();
    const cache = new ObjectCache();
    const store = new R2Store(bucket, { cache, metrics });

    const first = await store.getShard("v1", "exact", 0);
    const second = await store.getShard("v1", "exact", 0);
    expect(first).toEqual(second);
    expect(bucket.counters.gets).toBe(1);
    expect(metrics.objectsRead).toBe(1);
    expect(metrics.shardGets).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });

  test("a mutable app-data object is never cached", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes("app-data/settings.json", Buffer.from(JSON.stringify({ theme: "dark" })));
    const cache = new ObjectCache();
    const store = new R2Store(bucket, { cache });

    await store.getJson("app-data/settings.json");
    bucket.putBytes("app-data/settings.json", Buffer.from(JSON.stringify({ theme: "light" })));
    const after = await store.getJson("app-data/settings.json");
    expect(after).toEqual({ theme: "light" });
    expect(bucket.counters.gets).toBe(2);
    expect(cache.stats().hits).toBe(0);
  });

  test("a gzipped object with no content-encoding metadata is still cached and readable", async () => {
    const bucket = new FakeR2Bucket();
    const { gzipSync } = await import("node:zlib");
    bucket.putBytes(indexDirectoryKey("v1"), gzipSync(Buffer.from(JSON.stringify({ version: "v1", formatVersion: 2 }), "utf8")));
    const store = new R2Store(bucket, { cache: new ObjectCache() });

    const first = await store.getDirectory("v1");
    const second = await store.getDirectory("v1");
    expect(first).toEqual({ version: "v1", formatVersion: 2 });
    expect(second).toEqual(first);
    expect(bucket.counters.gets).toBe(1);
  });

  test("two concurrent reads of one object are one R2 GET", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes(companyPartitionKey("v1", 0), Buffer.from(JSON.stringify({ firstRef: 0, companies: [] })));
    const store = new R2Store(bucket, { cache: new ObjectCache() });
    const [a, b] = await Promise.all([store.getJson(companyPartitionKey("v1", 0)), store.getJson(companyPartitionKey("v1", 0))]);
    expect(a).toEqual(b);
    expect(bucket.counters.gets).toBe(1);
  });
});

/* -------------------- a real format-v2 index, end to end ------------------- */

describe("search over a real format-v2 index", () => {
  test("a v2 directory and a generated directory both search without duplicate objects", async () => {
    const bucket = new FakeR2Bucket();
    const { readdirSync, statSync } = await import("node:fs");
    const { relative, sep } = await import("node:path");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(relative(fixture.outputDir, path).split(sep).join("/"));
      }
    };
    walk(fixture.outputDir);
    bucket.loadObjects(
      fixture.outputDir,
      files.filter((file) => !file.endsWith("objects.jsonl")),
    );

    const metrics = new ReadMetrics();
    // The same per-bucket cache the Worker installs, so the assertions below are
    // about the real cache an isolate would use.
    const cache = searchCacheFor(bucket);
    const store = new R2Store(bucket, { cache, metrics });
    const directory = await store.getDirectory(fixture.version);
    expect(directory).not.toBeNull();
    expect(directory!.formatVersion).toBe(INDEX_FORMAT_VERSION);

    const source = new R2CandidateSource(store, directory!);
    const exact = await searchCompanies(source, "Microsoft Corporation", { pageSize: 25, maxHydrate: 8 });
    expect(exact.hits[0]?.name).toBe("Microsoft Corporation");
    expect(exact.retrieval.hydrationPasses).toBeGreaterThan(0);

    const fuzzy = await searchCompanies(source, "Microsft", { pageSize: 25, maxHydrate: 8 });
    expect(fuzzy.hits[0]?.name).toBe("Microsoft Corporation");

    /*
     * Backward compatibility, checked on the same objects: a directory written by
     * the format-v2 build (no `spoolPartitions`, no `unassigned` block, no
     * association metadata) must still be readable and searchable. That is what
     * keeps the already-published v1-bench-1m index usable after this change.
     */
    expect(isSupportedFormatVersion(2)).toBe(true);
    const v2 = { ...directory!, formatVersion: 2, shards: { ...directory!.shards }, counts: { ...directory!.counts } } as typeof directory;
    delete (v2.shards as { spoolPartitions?: number }).spoolPartitions;
    delete (v2 as { unassigned?: unknown }).unassigned;
    const v2Source = new R2CandidateSource(store, v2);
    const v2Search = await searchCompanies(v2Source, "Microsoft Corporation", { pageSize: 25, maxHydrate: 8 });
    expect(v2Search.hits[0]?.name).toBe("Microsoft Corporation");
    expect(await store.getUnassignedContacts(fixture.version, 0)).toEqual([]);

    const keys = bucket.counters.readKeys;
    expect(keys.length).toBe(new Set(keys).size);
    expect(metrics.objectsRead).toBeGreaterThan(0);

    // Every object this version needs has now been read once, so the cache holds
    // real entries and a repeat query never has to fetch them again.
    expect(cache.stats().hits).toBeGreaterThan(0);
    expect(cache.stats().entries).toBeGreaterThan(0);
  });
});

/* --------------------------- the operator's script ------------------------- */

describe("explain-query script", () => {
  test("explains a query against a real index, with stage attribution", () => {
    const script = join(root, "scripts", "explain-query.mjs");
    const result = spawnSync(
      "bun",
      [script, "--output-dir", fixture.outputDir, "--version", fixture.version, "--query", "zzzzzzqqqqq", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.version).toBe(fixture.version);
    expect(report.stageCounts).toBeDefined();
    expect(report.engine.retrieval.candidates).toBeGreaterThanOrEqual(0);
    expect(report.minScore).toBeGreaterThan(0);
    // The diagnostic must attribute every candidate it lists.
    for (const row of report.candidates_detail) {
      expect(typeof row.stage).toBe("string");
      expect(typeof row.name).toBe("string");
      expect(typeof row.passesThreshold).toBe("boolean");
    }
    // Nothing is shown for a nonsense query on this corpus either.
    expect(report.hits).toEqual([]);
  }, 60_000);
});
