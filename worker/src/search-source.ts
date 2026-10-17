/**
 * R2-backed candidate source.
 *
 * This is the production retrieval path: it answers the engine's four retrieval
 * calls with a bounded number of small shard reads, and hydrates only the best
 * candidates from company profile objects.
 *
 * Cost control (all of it measured, none of it unbounded):
 *   1. shard keys are deduplicated, so querying "tata" and "tata consultancy"
 *      that land in the same shard costs one read;
 *   2. reads run with limited concurrency (8) to protect the Worker's
 *      subrequest budget;
 *   3. every candidate accumulates a *cheap* score during retrieval using the
 *      prominence byte stored in the postings — exact > alias/prefix > token >
 *      trigram — so hydration sorts by that instead of fetching everything;
 *   4. hydration reads at most `SHARDING.maxHydrate` profile objects for the
 *      whole search, chosen in candidate order and memoised across the engine's
 *      hydration batches, and never re-reads a partition.
 */

import type { Company } from "../../src/shared/models";

/**
 * The minimal R2 surface the search source needs.
 *
 * Declared as an interface (rather than depending on the concrete `R2Store`
 * class) so the indexer's output can be queried by tests without a network or a
 * Worker runtime — the same code path then runs in both places.
 */
export interface ShardReader {
  getShard(version: string, kind: IndexKind, shard: number): Promise<ShardPayload | null>;
  /** Partitions are taken in first-seen (candidate) order, up to `maxParts`. */
  getCompaniesByRefs(version: string, refs: number[], maxParts?: number): Promise<Map<number, Company>>;
}
import type { CandidateSource, DocRef } from "../../src/shared/search/engine";
import type { SearchDoc } from "../../src/shared/search/score";
import { toSearchDoc } from "../../src/shared/search/local-index";
import { SHARDING, partitionOfRef, postingsFor, type IndexDirectory, type IndexKind, type ShardPayload } from "../../src/shared/search/index-format";
import { shardOf } from "../../src/shared/hash";
import { R2Store, mapLimit } from "./store";

/**
 * Retrieval stages of the COMPANY index.
 *
 * Spelled out rather than `Exclude<IndexKind, "stats">` because `IndexKind` also
 * carries the contact name kinds, which index contact ids and are read by
 * `contact-search.ts` — a company source that accepted them would look postings up
 * in the wrong key space.
 */
type RetrievalKind = "exact" | "prefix" | "token" | "trigram" | "ids";

/** Stage weights: an exact hit always outranks a trigram hit. */
const STAGE_WEIGHT: Record<RetrievalKind, number> = {
  exact: 1000,
  ids: 900,
  prefix: 120,
  token: 3,
  trigram: 1,
};

export class R2CandidateSource implements CandidateSource {
  readonly kind = "r2" as const;
  private readonly cheap = new Map<DocRef, number>();
  /**
   * Strongest retrieval evidence seen for each candidate: the stage and the
   * exact index term that produced it.
   *
   * Recorded because a diagnostic has to be able to answer "why is THIS company
   * in the result set" — a question no amount of scoring can answer, since by
   * then the retrieval evidence is gone. The weakest stage wins the tie (a doc
   * found by the exact index and by a trigram is reported as exact), because the
   * strongest evidence is what justifies the match.
   */
  private readonly stageEvidence = new Map<DocRef, { kind: RetrievalKind; term: string }>();
  // Null-prototype: keys are query terms, and a term such as "constructor" must
  // not read through to `Object.prototype`.
  private readonly observedDf: Record<string, number> = Object.create(null) as Record<string, number>;
  /** Companies hydrated during the last search, keyed by id (for enrichment). */
  private readonly byId = new Map<string, Company>();
  /** Docs already hydrated during this search, keyed by ref (memo across batches). */
  private readonly hydratedDocs = new Map<DocRef, SearchDoc>();
  /**
   * Profile partitions already read during this search.
   *
   * This is the hard byte bound of a query: hydration stops adding partitions
   * once `SHARDING.maxHydrate` of them have been read, so one search can never
   * fetch more than `maxHydrate × partitionBytes` no matter how dispersed its
   * candidate set is (the engine may ask for up to 400 candidates in batches).
   */
  private readonly hydratedPartitions = new Set<number>();
  /**
   * Whether the partition cap ever dropped a candidate during this search.
   *
   * A short page has two very different causes: the budget ran out (more reads
   * would find more companies — see the engine's adaptive second pass) or the
   * stored partitions genuinely hold no record for the remaining candidates
   * (more reads would find nothing). Only this class can tell them apart, so it
   * records that distinction instead of leaving the engine to guess from counts.
   */
  private budgetHit = false;
  /**
   * Logical reads this search asked for, reset by `beginSearch`.
   *
   * These are *requests*, not R2 GETs: a shard or partition served from the
   * isolate cache is counted here but costs no R2 request. Reporting both is
   * what lets the API show what the cache saved for a query.
   */
  private shardRequests = 0;
  private partitionRequests = 0;

  constructor(
    private readonly store: ShardReader,
    readonly directory: IndexDirectory,
  ) {}

  get datasetVersion(): string {
    return this.directory.version;
  }

  /**
   * Reset the per-search state (retrieval evidence + hydration memory).
   *
   * The Worker builds one source per request, but tests and any future
   * isolate-level reuse share one across searches — and both the tier lookup and
   * the hydration memo would otherwise leak from the previous search.
   */
  beginSearch(): void {
    this.cheap.clear();
    this.hydratedDocs.clear();
    this.hydratedPartitions.clear();
    this.byId.clear();
    this.budgetHit = false;
    this.shardRequests = 0;
    this.partitionRequests = 0;
    this.stageEvidence.clear();
  }

  /** Stage + term that retrieved a candidate during the most recent search. */
  stageEvidenceOf(ref: DocRef): { kind: RetrievalKind; term: string } | undefined {
    return this.stageEvidence.get(ref);
  }

  /** Shard objects this search asked for (cache-served or R2). */
  get shardReads(): number {
    return this.shardRequests;
  }

  /** Company partitions this search asked for (cache-served or R2). */
  get partitionReads(): number {
    return this.partitionRequests;
  }

  /** True once the per-search partition cap has dropped at least one candidate. */
  hydrationBudgetHit(): boolean {
    return this.budgetHit;
  }

  /** Fetch one shard per distinct term and merge the postings. */
  private async retrieve(kind: RetrievalKind, terms: string[], budget: number, merge: "union" | "majority"): Promise<DocRef[]> {
    const unique = [...new Set(terms.filter(Boolean))];
    if (!unique.length) return [];

    const shardCount = this.directory.shards[kind] ?? 1;
    const byShard = new Map<number, string[]>();
    for (const term of unique) {
      const shard = shardOf(term, shardCount);
      const list = byShard.get(shard);
      if (list) list.push(term);
      else byShard.set(shard, [term]);
    }

    const counts = new Map<DocRef, { matches: number; quality: number }>();
    const shardEntries = [...byShard.entries()];
    // One request per distinct shard, counted before the read so a cache hit
    // still shows up as a request that did not become an R2 GET.
    this.shardRequests += shardEntries.length;
    await mapLimit(shardEntries, 8, async ([shard, shardTerms]) => {
      const payload = await this.store.getShard(this.datasetVersion, kind, shard);
      if (!payload) return;
      for (const term of shardTerms) {
        const postings = postingsFor(payload, term);
        if (!postings) continue;
        if (typeof postings.df === "number") this.observedDf[term] = postings.df;
        const refs = postings.refs;
        const quality = postings.q;
        for (let i = 0; i < refs.length; i += 1) {
          const ref = refs[i];
          const q = quality ? (quality[i] ?? 0) / 255 : 0.5;
          const entry = counts.get(ref) ?? { matches: 0, quality: 0 };
          entry.matches += 1;
          entry.quality += q;
          counts.set(ref, entry);
          // Keep the strongest stage that mentioned this ref, so a later (weaker)
          // stage cannot downgrade the evidence a diagnostic reports.
          const previous = this.stageEvidence.get(ref);
          if (!previous || STAGE_WEIGHT[kind] > STAGE_WEIGHT[previous.kind]) {
            this.stageEvidence.set(ref, { kind, term });
          }
        }
      }
    });

    const required = merge === "majority" ? Math.max(1, Math.ceil(unique.length / 2)) : 1;
    const scored: { ref: DocRef; score: number }[] = [];
    for (const [ref, entry] of counts) {
      if (entry.matches < required) continue;
      const score = STAGE_WEIGHT[kind] * entry.matches + entry.quality * 10;
      scored.push({ ref, score });
    }
    scored.sort((a, b) => b.score - a.score);

    const out: DocRef[] = [];
    for (const { ref, score } of scored) {
      if (out.length >= budget) break;
      this.cheap.set(ref, (this.cheap.get(ref) ?? 0) + score);
      out.push(ref);
    }
    return out;
  }

  exact(variants: string[], budget: number): Promise<DocRef[]> {
    return this.retrieve("exact", variants, budget, "union");
  }

  prefix(prefixes: string[], budget: number): Promise<DocRef[]> {
    return this.retrieve(
      "prefix",
      prefixes.map((prefix) => prefix.slice(0, SHARDING.maxPrefixLength)).filter(Boolean),
      budget,
      "union",
    );
  }

  tokens(tokens: string[], budget: number): Promise<DocRef[]> {
    return this.retrieve("token", tokens, budget, tokens.length > 1 ? "majority" : "union");
  }

  trigrams(grams: string[], budget: number): Promise<DocRef[]> {
    return this.retrieve("trigram", grams, budget, "union");
  }

  /**
   * Id → document ref lookup.
   *
   * The `ids` shards hold both company ids and contact ids, each pointing at the
   * company document ref that owns the record, so company and contact detail
   * pages resolve with a single bounded shard read and never scan.
   */
  async refForId(id: string): Promise<number | null> {
    const shard = shardOf(id, this.directory.shards.ids ?? SHARDING.idShards);
    const payload = await this.store.getShard(this.datasetVersion, "ids", shard);
    const value = postingsFor(payload, id);
    return value?.refs?.[0] ?? null;
  }

  refForCompanyId(id: string): Promise<number | null> {
    return this.refForId(id);
  }

  refForContactId(id: string): Promise<number | null> {
    return this.refForId(id);
  }

  /** Company record for a hit produced by the most recent hydration pass. */
  companyForId(id: string): Company | undefined {
    return this.byId.get(id);
  }

  /**
   * Hydrate refs and keep the ref each document came from.
   *
   * `docs()` throws the mapping away (the engine scores documents, not refs), but
   * a diagnostic needs to say "candidate ref 12345 came from the trigram index on
   * term `zzq` and resolved to this company", and hydration returns documents in
   * its own score order rather than the caller's. Keeping the pair here is what
   * lets `scripts/explain-query.mjs` attribute a result to retrieval evidence
   * instead of guessing.
   */
  private async hydrateRefsWithRefs(
    refs: DocRef[],
    maxPartitions: number = SHARDING.maxHydrate,
  ): Promise<{ ref: DocRef; doc: SearchDoc }[]> {
    const ordered = [...refs].sort((a, b) => (this.cheap.get(b) ?? 0) - (this.cheap.get(a) ?? 0)).slice(0, SHARDING.maxScored);

    const found = new Map<DocRef, SearchDoc>();
    const missing: DocRef[] = [];
    for (const ref of ordered) {
      const memo = this.hydratedDocs.get(ref);
      if (memo) found.set(ref, memo);
      else missing.push(ref);
    }

    // Read only partitions this search has not read yet, chosen in candidate
    // order (best retrieval score first), and only up to the per-search cap.
    const read: DocRef[] = [];
    const fresh = new Set<number>();
    for (const ref of missing) {
      const partition = partitionOfRef(ref);
      // Already read: the ref simply is not in the stored object.
      if (this.hydratedPartitions.has(partition)) continue;
      if (!fresh.has(partition)) {
        if (this.hydratedPartitions.size + fresh.size >= maxPartitions) {
          this.budgetHit = true;
          continue;
        }
        fresh.add(partition);
      }
      read.push(ref);
    }

    if (read.length) {
      // Count the partitions this call is about to ask for (the store caps the
      // number it actually fetches, and reports back through `budgetHit`).
      const asked = new Set<number>();
      for (const ref of read) asked.add(partitionOfRef(ref));
      this.partitionRequests += asked.size;
      const companies = await this.store.getCompaniesByRefs(this.datasetVersion, read, maxPartitions);
      for (const partition of fresh) this.hydratedPartitions.add(partition);
      for (const ref of read) {
        const company = companies.get(ref) as Company | undefined;
        if (!company) continue;
        this.byId.set(company.id, company);
        const doc = toSearchDoc(company);
        this.hydratedDocs.set(ref, doc);
        found.set(ref, doc);
      }
    }

    const pairs: { ref: DocRef; doc: SearchDoc }[] = [];
    for (const ref of ordered) {
      const doc = found.get(ref);
      if (doc) pairs.push({ ref, doc });
    }
    return pairs;
  }

  /**
   * Retrieval strength of a candidate, from the evidence that retrieved it.
   *
   * A candidate is "strong" when it matched a whole-name signal — the exact
   * index (which also holds aliases) or the prefix index — and "weak" when only
   * token/trigram postings mentioned it. The engine uses this to stop hydrating
   * once its page is full of confident hits (see `WEAK_CEILING` in engine.ts).
   */
  tierOf(ref: DocRef): "strong" | "weak" {
    return (this.cheap.get(ref) ?? 0) >= STAGE_WEIGHT.prefix ? "strong" : "weak";
  }

  async docs(refs: DocRef[], options?: { maxPartitions?: number }): Promise<SearchDoc[]> {
    const pairs = await this.hydrateRefsWithRefs(refs, options?.maxPartitions ?? SHARDING.maxHydrate);
    return pairs.map((pair) => pair.doc);
  }

  /** Same hydration, with the document ref kept next to each document. */
  docsWithRefs(refs: DocRef[], options?: { maxPartitions?: number }): Promise<{ ref: DocRef; doc: SearchDoc }[]> {
    return this.hydrateRefsWithRefs(refs, options?.maxPartitions ?? SHARDING.maxHydrate);
  }

  async stats(): Promise<{ docCount: number; df: Record<string, number> }> {
    return { docCount: this.directory.counts.companies, df: this.observedDf };
  }
}

/** Load the directory for a version, or null when the index is missing. */
export async function loadDirectory(store: R2Store, version: string): Promise<IndexDirectory | null> {
  return store.getDirectory(version);
}
