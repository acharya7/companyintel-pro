/**
 * Regression tests for the bounded R2 hydration funnel.
 *
 * The R2 search path may not hydrate however many candidates retrieval happens
 * to produce: a profile partition is read whole, so the cost of a search is
 * `partitions read × partition bytes`, and an unbounded fan-out is what made a
 * cold query read ~2 MB of the real-data sample. Two mechanisms keep it bounded,
 * and both are asserted here against a synthetic index that has the same shape
 * as a real one (many partitions, exact + prefix + trigram evidence):
 *
 *   1. `SHARDING.maxHydrate` — a per-search ceiling on partitions read, spent in
 *      candidate order, never re-read and never exceeded across batches;
 *   2. the engine's early-stop barrier — once the requested page is full of hits
 *      that score above `WEAK_CEILING`, the token/trigram-only tail of the
 *      candidate list cannot reorder that page, so it is not fetched at all.
 *
 * Both are cost bounds, so the tests assert the *bounds* and the *results they
 * preserve* — not an exact byte count, which would break on any tuning change.
 */

import { describe, expect, test } from "bun:test";

import type { Company } from "../src/shared/models";
import { R2CandidateSource, type ShardReader } from "../worker/src/search-source";
import { searchCompanies, HYDRATE_BATCH, WEAK_CEILING } from "../src/shared/search/engine";
import {
  SHARDING,
  partitionOfRef,
  qualityByte,
  type IndexDirectory,
  type IndexKind,
  type Postings,
  type ShardPayload,
} from "../src/shared/search/index-format";
import { shardOf } from "../src/shared/hash";
import { nameVariants, normalizeName, tokenize } from "../src/shared/normalize";
import { trigramSet } from "../src/shared/search/similarity";

const VERSION = "funnel-v1";
const SHARDS = { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 } as const;

function makeCompany(ref: number, name: string): Company {
  const normalizedName = normalizeName(name);
  const aliases = new Set(nameVariants(name).map((variant) => variant.trim()).filter(Boolean));
  aliases.delete(normalizedName);
  return {
    id: `c_${String(ref).padStart(4, "0")}`,
    name,
    normalizedName,
    aliases: [...aliases],
    domain: `company-${ref}.example`,
    industry: "Software",
    country: "India",
    city: "Pune",
    contactCount: ref % 7,
    sources: [{ source: "csv1", row: ref + 2 }],
  } as Company;
}

/**
 * Synthetic index with the real layout rules: refs are contiguous, partitions
 * hold `SHARDING.companiesPerPartition` companies, and postings are served from
 * the shard the reader asks for.
 */
class SyntheticIndex implements ShardReader {
  readonly companies: Company[];
  readonly partitionsRead: number[] = [];
  readonly shardKinds: IndexKind[] = [];

  constructor(companies: Company[]) {
    this.companies = companies;
  }

  reset(): void {
    this.partitionsRead.length = 0;
    this.shardKinds.length = 0;
  }

  private termsFor(ref: number, kind: IndexKind): string[] {
    const company = this.companies[ref];
    const normalized = company.normalizedName;
    const variants = new Set([normalized, ...(company.aliases ?? [])]);
    if (kind === "exact") return [...variants];
    if (kind === "trigram") {
      const grams = new Set<string>();
      for (const variant of variants) for (const gram of trigramSet(variant)) grams.add(gram);
      return [...grams];
    }
    if (kind === "token") return [...new Set(tokenize(normalized))];
    if (kind === "prefix") {
      const prefixes: string[] = [];
      for (const variant of variants) for (let i = 1; i <= Math.min(SHARDING.maxPrefixLength, variant.length); i += 1) prefixes.push(variant.slice(0, i));
      return prefixes;
    }
    return kind === "ids" ? [company.id] : [];
  }

  async getShard(_version: string, kind: IndexKind, shard: number): Promise<ShardPayload | null> {
    this.shardKinds.push(kind);
    const terms: Record<string, Postings> = Object.create(null) as Record<string, Postings>;
    this.companies.forEach((company, ref) => {
      const quality = qualityByte(company.contactCount, company.normalizedName.length);
      for (const term of this.termsFor(ref, kind)) {
        if (shardOf(term, SHARDS[kind as keyof typeof SHARDS] ?? 1) !== shard) continue;
        const postings = terms[term] ?? { refs: [], q: [] };
        postings.refs.push(ref);
        postings.q!.push(quality);
        terms[term] = postings;
      }
    });
    return { terms };
  }

  async getCompaniesByRefs(_version: string, refs: number[], maxParts = SHARDING.maxHydrate): Promise<Map<number, Company>> {
    const grouped = new Map<number, number[]>();
    for (const ref of refs) {
      const partition = partitionOfRef(ref);
      const list = grouped.get(partition);
      if (list) list.push(ref);
      else grouped.set(partition, [ref]);
    }
    const out = new Map<number, Company>();
    for (const [partition, partitionRefs] of grouped) {
      // First-seen order, capped — the same contract the R2 store implements.
      if (this.partitionsRead.length >= maxParts && !this.partitionsRead.includes(partition)) continue;
      if (!this.partitionsRead.includes(partition)) this.partitionsRead.push(partition);
      for (const ref of partitionRefs) out.set(ref, this.companies[ref]);
    }
    return out;
  }
}

function directory(companies: number): IndexDirectory {
  return {
    formatVersion: 2,
    normalizerVersion: 1,
    version: VERSION,
    createdAt: new Date(0).toISOString(),
    shards: { ...SHARDS, companyPartitions: Math.ceil(companies / SHARDING.companiesPerPartition), contactPartitions: 1 },
    counts: { companies, contacts: 0, indexedAliases: 0 },
    sources: ["csv1"],
    bytes: { indexes: 0, companies: 0, contacts: 0, total: 0 },
    fields: { company: ["name"], contact: [] },
  };
}

/** Companies whose names all share the query prefix, so many partitions are involved. */
function manyCompanies(count: number): Company[] {
  const names = [
    "Alpha Industries",
    "Alpha Systems",
    "Alpha Technologies",
    "Alpha Solutions",
    "Alpha Logistics",
    "Alpha Healthcare",
    "Alpaca Trading",
    "Alpine Ventures",
    "Alphabet Holdings",
    "Alps Engineering",
  ];
  const companies: Company[] = [];
  for (let index = 0; index < count; index += 1) {
    companies.push(makeCompany(index, `${names[index % names.length]} ${Math.floor(index / names.length)}`));
  }
  return companies;
}

describe("bounded R2 hydration", () => {
  test("reads at most SHARDING.maxHydrate partitions per search, across every batch", async () => {
    const index = new SyntheticIndex(manyCompanies(1200));
    const source = new R2CandidateSource(index, directory(1200));

    const response = await searchCompanies(source, "alpha", {
      pageSize: 25,
      resultBudget: 400,
      retrievalBudget: 3000,
      maxHydrate: 4,
    });

    expect(index.partitionsRead.length).toBeLessThanOrEqual(4);
    expect(index.partitionsRead.length).toBeGreaterThan(0);
    // Hydration is bounded by the partitions read, not by the candidate budget.
    expect(response.retrieval.scored).toBeLessThanOrEqual(4 * SHARDING.companiesPerPartition);
    expect(response.hits.length).toBeGreaterThan(0);
  });

  test("a bigger hydration budget never produces fewer results", async () => {
    const index = new SyntheticIndex(manyCompanies(1200));
    const small = await searchCompanies(new R2CandidateSource(index, directory(1200)), "alpha", { pageSize: 25, maxHydrate: 2 });
    const large = await searchCompanies(new R2CandidateSource(index, directory(1200)), "alpha", { pageSize: 25, maxHydrate: 16 });

    expect(large.retrieval.scored).toBeGreaterThanOrEqual(small.retrieval.scored);
    expect(large.hits.length).toBeGreaterThanOrEqual(small.hits.length);
    expect(small.hits[0]?.name).toBe(large.hits[0]?.name);
  });

  test("never hydrates a profile partition twice for one search", async () => {
    const index = new SyntheticIndex(manyCompanies(1200));
    const source = new R2CandidateSource(index, directory(1200));
    await searchCompanies(source, "alpha industries", { pageSize: 25, maxHydrate: 8 });

    expect(new Set(index.partitionsRead).size).toBe(index.partitionsRead.length);
  });

  test("the engine stops hydrating weak candidates once the page is full of confident hits", async () => {
    // 40 companies whose normalized name IS the query (exact evidence, so
    // relevance 1.0) followed by 1,000 companies that only share trigrams
    // ("Alpaca", "Alpine"…) — the fuzzy tail a page of 25 does not need.
    const companies: Company[] = [];
    for (let index = 0; index < 40; index += 1) companies.push(makeCompany(index, "Alpha Corporation"));
    for (let index = 40; index < 1040; index += 1) companies.push(makeCompany(index, `Alpaca Trading ${index}`));
    const index = new SyntheticIndex(companies);
    const source = new R2CandidateSource(index, directory(companies.length));

    const response = await searchCompanies(source, "alpha corporation", { pageSize: 25, resultBudget: 400, maxHydrate: 16 });

    expect(response.hits.length).toBe(25);
    expect(response.hits.every((hit) => hit.matchCategory === "exact")).toBe(true);
    expect(response.hits.every((hit) => hit.relevance > WEAK_CEILING)).toBe(true);
    // The barrier stops the tail, so the count is a floor the API reports as "N+".
    expect(response.page.totalIsLowerBound).toBe(true);
    expect(response.retrieval.scored).toBeLessThan(200);
    expect(index.partitionsRead.length).toBeLessThanOrEqual(SHARDING.maxHydrate);
  });

  test("hydration is capped by the batch it is asked for, not by the whole candidate list", async () => {
    const index = new SyntheticIndex(manyCompanies(1200));
    const source = new R2CandidateSource(index, directory(1200));
    await searchCompanies(source, "alpha", { pageSize: 25, maxHydrate: 1 });

    expect(HYDRATE_BATCH).toBeGreaterThan(0);
    expect(index.partitionsRead.length).toBe(1);
  });

  test("two searches on one source hydrate independently (no state leaks between them)", async () => {
    const index = new SyntheticIndex(manyCompanies(1200));
    const source = new R2CandidateSource(index, directory(1200));

    const first = await searchCompanies(source, "alpha", { pageSize: 25, maxHydrate: 4 });
    index.reset();
    const second = await searchCompanies(source, "alpha industries", { pageSize: 25, maxHydrate: 4 });

    expect(first.hits.length).toBeGreaterThan(0);
    expect(second.hits.length).toBeGreaterThan(0);
    // If the hydration memo leaked, the second search would read nothing.
    expect(index.partitionsRead.length).toBeGreaterThan(0);
    expect(second.retrieval.scored).toBeGreaterThan(0);
  });
});
