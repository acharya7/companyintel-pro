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
 *   4. hydration is capped at `SHARDING.maxScored` docs and `SHARDING.maxHydrate`
 *      profile objects.
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
  getCompaniesByRefs(version: string, refs: number[], maxParts?: number): Promise<Map<number, Company>>;
}
import type { CandidateSource, DocRef } from "../../src/shared/search/engine";
import type { SearchDoc } from "../../src/shared/search/score";
import { toSearchDoc } from "../../src/shared/search/local-index";
import { SHARDING, postingsFor, type IndexDirectory, type IndexKind, type ShardPayload } from "../../src/shared/search/index-format";
import { shardOf } from "../../src/shared/hash";
import { R2Store, mapLimit } from "./store";

type RetrievalKind = Exclude<IndexKind, "stats">;

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
  // Null-prototype: keys are query terms, and a term such as "constructor" must
  // not read through to `Object.prototype`.
  private readonly observedDf: Record<string, number> = Object.create(null) as Record<string, number>;
  /** Companies hydrated during the last search, keyed by id (for enrichment). */
  private readonly byId = new Map<string, Company>();

  constructor(
    private readonly store: ShardReader,
    readonly directory: IndexDirectory,
  ) {}

  get datasetVersion(): string {
    return this.directory.version;
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

  private async hydrateRefs(refs: DocRef[]): Promise<SearchDoc[]> {
    const ordered = [...refs].sort((a, b) => (this.cheap.get(b) ?? 0) - (this.cheap.get(a) ?? 0)).slice(0, SHARDING.maxScored);
    const companies = await this.store.getCompaniesByRefs(this.datasetVersion, ordered);
    const docs: SearchDoc[] = [];
    for (const ref of ordered) {
      const company = companies.get(ref) as Company | undefined;
      if (!company) continue;
      this.byId.set(company.id, company);
      docs.push(toSearchDoc(company));
    }
    return docs;
  }

  docs(refs: DocRef[]): Promise<SearchDoc[]> {
    return this.hydrateRefs(refs);
  }

  async stats(): Promise<{ docCount: number; df: Record<string, number> }> {
    return { docCount: this.directory.counts.companies, df: this.observedDf };
  }
}

/** Load the directory for a version, or null when the index is missing. */
export async function loadDirectory(store: R2Store, version: string): Promise<IndexDirectory | null> {
  return store.getDirectory(version);
}
