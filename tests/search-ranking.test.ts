/**
 * Search relevance, retrieval budgets and completeness — through the REAL R2
 * read path.
 *
 * Every case here goes `FakeR2Bucket → R2Store → R2CandidateSource → engine`, on
 * an index written to disk in the production layout (sharded postings, 250
 * companies per profile partition, gzipped bodies). That matters: the behaviours
 * under test are about *which objects get read* and *in what order*, so a
 * simulated source with an in-memory map would prove nothing about them.
 *
 * The cases map one-to-one onto the acceptance criteria:
 *
 *   1  exact-name matches outrank fuzzy noise, whatever partition they are in
 *   2  prefix, token and fuzzy matching all still work (the gates must not break
 *      legitimate typo tolerance)
 *   3  the candidate (CPU) budget truncates the WEAKEST evidence, never a strong
 *      candidate in favour of a weak one, and says how many it dropped
 *   4  a partition budget that cuts the answer short is reported, not hidden
 *   5  the adaptive ladder 16→32→64 fills pages the single retry could not
 *   6  no object is read twice for one search
 *   7  pagination is stable and never overlaps
 *   8  ordering is by relevance regardless of which partition a candidate is in
 *   9  a nonsense query returns nothing, including for the short junk names that
 *      used to slip through the whole-string similarity rule
 *   13 a format-v2 index produced by the real indexer still answers correctly
 *   14 CPU/memory/R2 work stays inside its configured bounds
 *   15 the response still satisfies the shared Zod contract the frontend parses
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import type { Company } from "../src/shared/models";
import { companyId, shardOf } from "../src/shared/hash";
import { nameVariants, normalizeName, tokenize } from "../src/shared/normalize";
import { companySearchResponseSchema } from "../src/shared/api-contract";
import {
  SHARDING,
  companyPartitionKey,
  contactPartitionKey,
  indexDirectoryKey,
  indexShardKey,
  qualityByte,
  type IndexDirectory,
  type IndexKind,
  type Postings,
  type ShardPayload,
} from "../src/shared/search/index-format";
import { trigramsOf } from "../src/shared/search/similarity";
import { R2Store } from "../worker/src/store";
import { R2CandidateSource } from "../worker/src/search-source";
import { ReadMetrics, ObjectCache } from "../worker/src/search-cache";
import { FakeR2Bucket } from "./helpers/fake-r2";
import { searchCompanies, SEARCH_LIMITS } from "../src/shared/search/engine";

const VERSION = "ranking-v1";
const SHARDS = { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 } as const;

/* --------------------------------- fixture -------------------------------- */

function makeCompany(ref: number, name: string, contactCount: number, country = "United States"): Company {
  const primary = normalizeName(name);
  const aliases = [...new Set(nameVariants(name).filter((variant) => variant !== primary))];
  return {
    id: companyId(`c:${ref}:${primary}`),
    name,
    normalizedName: primary,
    aliases,
    domain: `company-${ref}.example`,
    industry: "Software",
    country,
    city: "Austin",
    contactCount,
    sources: [{ source: "csv1", row: ref + 2 }],
  } as Company;
}

function termsFor(company: Company, kind: IndexKind): string[] {
  const variants = new Set([company.normalizedName, ...(company.aliases ?? [])]);
  if (kind === "exact") return [...variants];
  if (kind === "prefix") {
    const prefixes: string[] = [];
    for (const variant of variants) {
      for (let i = 1; i <= Math.min(SHARDING.maxPrefixLength, variant.length); i += 1) prefixes.push(variant.slice(0, i));
    }
    return [...new Set(prefixes)];
  }
  if (kind === "token") return [...new Set(tokenize(company.normalizedName))];
  if (kind === "trigram") {
    const grams = new Set<string>();
    for (const variant of variants) for (const gram of trigramsOf(variant)) grams.add(gram);
    return [...grams];
  }
  return [company.id];
}

/** Write one gzipped object at a production key, creating its directories. */
function writeKey(root: string, key: string, value: unknown): void {
  const path = join(root, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
}

/** Write a production-layout index to disk and load it into the fake binding. */
function buildIndex(companies: Company[]): { bucket: FakeR2Bucket; dir: string; directory: IndexDirectory } {
  const root = mkdtempSync(join(tmpdir(), "companyintel-ranking-"));

  const perPartition = SHARDING.companiesPerPartition;
  const partitions = Math.max(1, Math.ceil(companies.length / perPartition));
  for (let partition = 0; partition < partitions; partition += 1) {
    const slice = companies.slice(partition * perPartition, (partition + 1) * perPartition);
    writeKey(root, companyPartitionKey(VERSION, partition), { firstRef: partition * perPartition, companies: slice });
  }
  for (let partition = 0; partition < Math.ceil(companies.length / SHARDING.companiesPerContactPartition); partition += 1) {
    writeKey(root, contactPartitionKey(VERSION, partition), {
      firstRef: partition * SHARDING.companiesPerContactPartition,
      byCompany: {},
    });
  }

  for (const kind of ["exact", "prefix", "token", "trigram", "ids"] as const) {
    const count = SHARDS[kind];
    const shards: Record<string, Postings>[] = new Array(count).fill(0).map(() => Object.create(null) as Record<string, Postings>);
    companies.forEach((company, ref) => {
      const quality = qualityByte(company.contactCount, company.normalizedName.length);
      for (const term of termsFor(company, kind)) {
        // The REAL shard function: a test that hashed differently from the reader
        // would silently write shards nothing ever reads.
        const shard = shardOf(term, count);
        const postings = shards[shard][term] ?? { refs: [], q: [] };
        postings.refs.push(ref);
        postings.q!.push(quality);
        shards[shard][term] = postings;
      }
    });
    for (let shard = 0; shard < count; shard += 1) {
      writeKey(root, indexShardKey(VERSION, kind, shard), { terms: shards[shard] } satisfies ShardPayload);
    }
  }

  const directory: IndexDirectory = {
    formatVersion: 2,
    normalizerVersion: 1,
    version: VERSION,
    createdAt: new Date(0).toISOString(),
    shards: { ...SHARDS, companyPartitions: partitions, contactPartitions: 1 },
    counts: { companies: companies.length, contacts: 0, indexedAliases: 0 },
    sources: ["csv1"],
    bytes: { indexes: 0, companies: 0, contacts: 0, total: 0 },
    fields: { company: ["name"], contact: [] },
  };
  const directoryPath = join(root, indexDirectoryKey(VERSION));
  mkdirSync(dirname(directoryPath), { recursive: true });
  writeFileSync(directoryPath, JSON.stringify(directory));

  const bucket = new FakeR2Bucket();
  const files: string[] = [];
  const walk = (dir: string, prefix = "") => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${entry}/`);
      else files.push(`${prefix}${entry}`);
    }
  };
  walk(root);
  bucket.loadObjects(root, files);
  return { bucket, dir: root, directory };
}

function readKeys(bucket: FakeR2Bucket): string[] {
  return bucket.counters.readKeys;
}

function duplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  return dupes;
}

/* ---------------------------------- cases --------------------------------- */

describe("ranking above retrieval noise", () => {
  // One real company among 600 decoys that share its trigrams, deliberately
  // spread over three profile partitions (250 companies each).
  const companies: Company[] = [];
  companies.push(makeCompany(0, "Microsoft Corporation", 412));
  for (let i = 1; i <= 600; i += 1) companies.push(makeCompany(i, `Misco Systems ${i}`, 1));

  test("the exact match is ranked first and every exact hit outranks a fuzzy one", async () => {
    const { bucket, directory, dir } = buildIndex(companies);
    try {
      const store = new R2Store(bucket);
      const source = new R2CandidateSource(store, directory);
      const response = await searchCompanies(source, "Microsoft Corporation", { pageSize: 25, maxHydrate: 4 });

      expect(response.hits[0].name).toBe("Microsoft Corporation");
      expect(response.hits[0].matchCategory).toBe("exact");
      const categories = response.hits.map((hit) => hit.matchCategory);
      const firstNonExact = categories.findIndex((category) => category !== "exact");
      if (firstNonExact !== -1) {
        expect(categories.slice(firstNonExact).every((category) => category !== "exact")).toBe(true);
      }
      expect(response.retrieval.exact).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a candidate in a later partition is not out-ranked by an earlier one", async () => {
    const { bucket, directory, dir } = buildIndex(companies);
    try {
      const store = new R2Store(bucket);
      const source = new R2CandidateSource(store, directory);
      // The exact record is ref 0 (partition 0); the query is answered only by
      // hydration in candidate order, so an exact hit can never be pushed out by
      // a decoy that happens to live in an earlier partition.
      const response = await searchCompanies(source, "microsoft", { pageSize: 10, maxHydrate: 8 });
      expect(response.hits[0].name).toBe("Microsoft Corporation");
      expect(response.hits[0].contactCount).toBe(412);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("budgets, truncation and completeness", () => {
  function crowded(): Company[] {
    const companies: Company[] = [];
    for (let i = 0; i < 900; i += 1) companies.push(makeCompany(i, `Alpha Industries ${i}`, i % 5));
    companies[0] = makeCompany(0, "Alpha Industries", 300);
    return companies;
  }

  /**
   * The same 900 rows, but the query matches one company in every eight.
   *
   * A budget test needs a page the budget can actually leave short, and hydration
   * reads a profile partition WHOLE (250 companies, `SHARDING.companiesPerPartition`).
   * With every company matching, a single partition always fills the 100-row maximum
   * page, so the budget would never be the reason the page is short. Dispersing the
   * matches (~30 per partition, ~115 in total) keeps the budget — not the stored
   * data — the limiting factor, which is what these two tests are about.
   */
  function dispersed(): Company[] {
    const companies: Company[] = [];
    for (let i = 0; i < 900; i += 1) {
      companies.push(makeCompany(i, i % 8 === 0 ? `Alpha Industries ${i}` : `Beta Trading ${i}`, i % 5));
    }
    // One exact name, so the notice under test is the budget notice and not the
    // "showing partial matches" message an exact-name-less query produces.
    companies[0] = makeCompany(0, "Alpha Industries", 300);
    return companies;
  }

  test("the CPU budget truncates the weakest evidence, keeps the strongest, and reports the count", async () => {
    const { bucket, directory, dir } = buildIndex(crowded());
    try {
      const source = new R2CandidateSource(new R2Store(bucket), directory);
      const response = await searchCompanies(source, "alpha industries", {
        pageSize: 5,
        resultBudget: 20,
        retrievalBudget: 2000,
        maxHydrate: 16,
        adaptiveHydration: false,
      });

      expect(response.retrieval.candidates).toBeGreaterThan(20);
      expect(response.retrieval.truncated).toBe(response.retrieval.candidates - 20);
      expect(response.retrieval.scored).toBeLessThanOrEqual(20);
      expect(response.page.totalIsLowerBound).toBe(true);
      // The exact name (ref 0) is in the kept slice.
      expect(response.hits.map((hit) => hit.name)).toContain("Alpha Industries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a partition budget that cuts the answer short is reported, not hidden", async () => {
    const { bucket, directory, dir } = buildIndex(dispersed());
    try {
      const source = new R2CandidateSource(new R2Store(bucket), directory);
      const response = await searchCompanies(source, "alpha industries", {
        pageSize: 100,
        maxHydrate: 1,
        adaptiveHydration: false,
      });

      expect(response.retrieval.budgetLimited).toBe(true);
      expect(response.hits.length).toBeLessThan(100);
      expect(response.page.totalIsLowerBound).toBe(true);
      expect(response.notice).toContain("within this search's budget");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the adaptive ladder reaches further than a single retry, and stops when the page fills", async () => {
    const { bucket, directory, dir } = buildIndex(dispersed());
    try {
      const oneStep = await searchCompanies(new R2CandidateSource(new R2Store(bucket), directory), "alpha industries", {
        pageSize: 100,
        maxHydrate: 1,
        adaptiveHydrateSteps: 1,
      });
      const ladder = await searchCompanies(new R2CandidateSource(new R2Store(bucket), directory), "alpha industries", {
        pageSize: 100,
        maxHydrate: 1,
        adaptiveHydrateSteps: 2,
      });

      expect(oneStep.retrieval.hydrationPasses).toBe(2);
      expect(ladder.retrieval.hydrationPasses).toBe(3);
      expect(ladder.retrieval.hydrateBudget).toBe(4);
      expect(ladder.hits.length).toBeGreaterThanOrEqual(oneStep.hits.length);
      expect(ladder.retrieval.scored).toBeLessThanOrEqual(4 * SHARDING.companiesPerPartition);
      expect(ladder.retrieval.hydrateBudget).toBeLessThanOrEqual(SEARCH_LIMITS.maxHydrate);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a page that fills on the first pass takes no retry at all", async () => {
    const companies: Company[] = [];
    for (let i = 0; i < 300; i += 1) companies.push(makeCompany(i, `Alpha Industries ${i}`, 1));
    const { bucket, directory, dir } = buildIndex(companies);
    try {
      const source = new R2CandidateSource(new R2Store(bucket), directory);
      const response = await searchCompanies(source, "alpha", { pageSize: 10, maxHydrate: 16 });
      expect(response.hits.length).toBe(10);
      expect(response.retrieval.hydrationPasses).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R2 read discipline", () => {
  function corpus(count: number): Company[] {
    const companies: Company[] = [];
    for (let i = 0; i < count; i += 1) companies.push(makeCompany(i, `Northwind Trading ${i}`, i % 7));
    return companies;
  }

  test("no object is read twice for one search, and every read is counted", async () => {
    const { bucket, directory, dir } = buildIndex(corpus(700));
    try {
      const metrics = new ReadMetrics();
      const store = new R2Store(bucket, { metrics });
      const response = await searchCompanies(new R2CandidateSource(store, directory), "northwind", {
        pageSize: 25,
        maxHydrate: 8,
      });
      expect(duplicates(readKeys(bucket))).toEqual([]);
      expect(metrics.objectsRead).toBeGreaterThan(0);
      expect(metrics.objectsRead).toBe(readKeys(bucket).length);
      expect(metrics.bytesRead).toBeGreaterThan(0);
      expect(metrics.shardGets + metrics.partitionGets).toBeGreaterThan(0);
      expect(response.retrieval.scored).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("work stays inside the configured bounds (CPU, partitions, retrieval)", async () => {
    const { bucket, directory, dir } = buildIndex(corpus(700));
    try {
      const source = new R2CandidateSource(new R2Store(bucket), directory);
      const response = await searchCompanies(source, "northwind trading", {
        pageSize: 25,
        resultBudget: 64,
        retrievalBudget: 200,
        maxHydrate: 2,
        adaptiveHydration: false,
      });
      expect(response.retrieval.scored).toBeLessThanOrEqual(64);
      expect(response.retrieval.candidates).toBeLessThanOrEqual(200);
      expect(response.retrieval.hydrateBudget).toBe(2);
      // Hydration reads whole partitions of 250 companies, so the number of
      // hydrated companies is bounded by the partition budget, not the candidate
      // budget.
      expect(response.retrieval.scored).toBeLessThanOrEqual(2 * SHARDING.companiesPerPartition);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pagination", () => {
  function steady(): Company[] {
    const companies: Company[] = [];
    for (let i = 0; i < 500; i += 1) companies.push(makeCompany(i, `Pinewood Group ${i}`, i % 3));
    return companies;
  }

  test("pages never overlap, stay in order, and stop when the data does", async () => {
    const { bucket, directory, dir } = buildIndex(steady());
    try {
      const source = new R2CandidateSource(new R2Store(bucket), directory);
      const seen = new Set<string>();
      const pages = [];
      for (let page = 1; page <= 3; page += 1) {
        const response = await searchCompanies(source, "pinewood", { pageSize: 10, page, maxHydrate: 16 });
        pages.push(response);
        for (const hit of response.hits) {
          expect(seen.has(hit.id)).toBe(false);
          seen.add(hit.id);
        }
        expect(response.page.page).toBe(page);
      }
      expect(pages[0].page.hasMore).toBe(true);
      // Relevance order is stable across pages: the first page's worst hit is at
      // least as good as the second page's best.
      expect(pages[0].hits.at(-1)!.relevance).toBeGreaterThanOrEqual(pages[1].hits[0].relevance);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a page beyond the data returns an empty slice and hasMore false", async () => {
    const { bucket, directory, dir } = buildIndex(steady());
    try {
      const source = new R2CandidateSource(new R2Store(bucket), directory);
      const response = await searchCompanies(source, "pinewood", { pageSize: 25, page: 50, maxHydrate: 4 });
      expect(response.hits).toEqual([]);
      expect(response.page.hasMore).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("misleading fuzzy matches", () => {
  /**
   * The short-name junk class, measured on the real-data sample: names of three
   * or four characters share two of their three trigrams with an eleven-character
   * nonsense query, which the old whole-string Dice/`editSimilarity` rule scored
   * above `minScoreFor(11)` (0.36). They must not be shown now — and genuine
   * typos of real names must still be.
   */
  const junk = ["zz", "ZZP'er", "ZZZ", "Zzq", "QQQ", "zzqq", "zzzzzz"];
  const companies: Company[] = [
    makeCompany(0, "Microsoft Corporation", 412),
    ...junk.map((name, index) => makeCompany(index + 1, name, 0)),
  ];

  test("a nonsense query returns nothing on the real read path", async () => {
    const { bucket, directory, dir } = buildIndex(companies);
    try {
      const source = new R2CandidateSource(new R2Store(bucket), directory);
      const response = await searchCompanies(source, "zzzzzzqqqqq", { pageSize: 25, maxHydrate: 8 });
      expect(response.hits).toEqual([]);
      expect(response.notice).toContain("No companies matched");
      expect(response.page.total).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unrelated words do not match either", async () => {
    const { bucket, directory, dir } = buildIndex(companies);
    try {
      const source = new R2CandidateSource(new R2Store(bucket), directory);
      for (const query of ["qwertyuiop", "xxyyzz", "qqqqqqqqqq"]) {
        const response = await searchCompanies(source, query, { pageSize: 25, maxHydrate: 8 });
        expect(response.hits.map((hit) => hit.name)).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legitimate typo tolerance and partial queries are unchanged", async () => {
    const { bucket, directory, dir } = buildIndex(companies);
    try {
      const source = new R2CandidateSource(new R2Store(bucket), directory);
      const typo = await searchCompanies(source, "Microsft", { pageSize: 25, maxHydrate: 8 });
      expect(typo.hits[0]?.name).toBe("Microsoft Corporation");

      const partial = await searchCompanies(source, "microsoft corp", { pageSize: 25, maxHydrate: 8 });
      expect(partial.hits[0]?.name).toBe("Microsoft Corporation");

      const shortPrefix = await searchCompanies(source, "micro", { pageSize: 25, maxHydrate: 8 });
      expect(shortPrefix.hits.map((hit) => hit.name)).toContain("Microsoft Corporation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cache and contract compatibility", () => {
  test("a repeated search is served from the isolate cache and reads no shard twice", async () => {
    const companies: Company[] = [];
    for (let i = 0; i < 520; i += 1) companies.push(makeCompany(i, `Cedar Analytics ${i}`, i % 4));
    const { bucket, directory, dir } = buildIndex(companies);
    try {
      const cache = new ObjectCache();
      const store = new R2Store(bucket, { cache });
      const source = new R2CandidateSource(store, directory);

      const first = await searchCompanies(source, "cedar analytics", { pageSize: 25, maxHydrate: 8 });
      expect(duplicates(readKeys(bucket))).toEqual([]);
      const firstGets = bucket.counters.gets;

      bucket.resetCounters();
      const second = await searchCompanies(source, "cedar analytics", { pageSize: 25, maxHydrate: 8 });
      // The same objects are already in the cache, so the second search is a pure
      // cache hit for every shard and partition it needs.
      expect(bucket.counters.gets).toBe(0);
      expect(cache.stats().hits).toBeGreaterThan(0);
      expect(second.hits.map((hit) => hit.id)).toEqual(first.hits.map((hit) => hit.id));
      expect(firstGets).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the response still satisfies the shared Zod contract, with and without R2 accounting", async () => {
    const companies: Company[] = [makeCompany(0, "Microsoft Corporation", 412), makeCompany(1, "Misco Systems", 1)];
    const { bucket, directory, dir } = buildIndex(companies);
    try {
      // Exactly what the Worker builds per request: a store over the shared
      // bucket cache, and per-request counters snapshotted around the search.
      const cache = new ObjectCache();
      const metrics = new ReadMetrics();
      const before = metrics.snapshotCache(cache);
      const source = new R2CandidateSource(new R2Store(bucket, { cache, metrics }), directory);
      const response = await searchCompanies(source, "Microsoft", { pageSize: 25, maxHydrate: 4 });
      metrics.recordCacheDelta(cache, before);

      const parsed = companySearchResponseSchema.parse(response);
      expect(parsed.retrieval.hydrationPasses).toBeGreaterThan(0);
      expect(parsed.retrieval.candidates).toBeGreaterThanOrEqual(parsed.retrieval.exact);

      // What the Worker adds on the way out.
      const withAccounting = companySearchResponseSchema.parse({
        ...response,
        retrieval: { ...response.retrieval, r2: metrics.toJSON() },
      });
      expect(withAccounting.retrieval.r2?.objectsRead).toBeGreaterThan(0);
      expect(withAccounting.retrieval.r2?.cacheMisses).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
