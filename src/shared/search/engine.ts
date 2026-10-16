/**
 * Two-stage fuzzy company search engine.
 *
 * Stage 1 — candidate retrieval (bounded, index-only, never scans CSV data):
 *   normalize query -> exact index -> prefix index -> token inverted index ->
 *   character-trigram index -> dedupe -> strict candidate budget.
 *
 * Stage 2 — ranking:
 *   hydrate only the budgeted candidates, score each with `score.ts`, apply
 *   filters/sorting, then paginate.
 *
 * The same code powers:
 *   - the browser preview adapter (in-memory `LocalCandidateSource`),
 *   - the Cloudflare Worker (R2-backed `R2CandidateSource`),
 * so relevance behaviour is identical everywhere.
 */

import type {
  CompanyFilters,
  CompanySearchHit,
  CompanySearchResponse,
  CompanySortField,
  MatchCategory,
  PageInfo,
  SortOrder,
} from "../models";
import { NORMALIZER_VERSION, compact, nameVariants, normalizeName, tokenize } from "../normalize";
import { minScoreFor, scoreDoc, type SearchDoc } from "./score";
import { trigramSet, trigramsOf } from "./similarity";

/** Candidate document references are 32-bit offsets into the doc table. */
export type DocRef = number;

export interface CandidateSource {
  readonly kind: "local" | "r2";
  readonly datasetVersion: string;
  /** Docs whose normalized name/alias exactly equals any variant. */
  exact(variants: string[], budget: number): Promise<DocRef[]>;
  /** Docs under a prefix (first-token aware; used for short queries too). */
  prefix(prefixes: string[], budget: number): Promise<DocRef[]>;
  /** Docs sharing at least one of the given tokens. */
  tokens(tokens: string[], budget: number): Promise<DocRef[]>;
  /** Docs sharing trigrams — the fuzzy workhorse. */
  trigrams(grams: string[], budget: number): Promise<DocRef[]>;
  /**
   * Hydrate candidate metadata. Called once per hydration batch (see
   * `HYDRATE_BATCH`), in candidate order.
   *
   * `maxPartitions` is the byte bound for the whole search (see
   * `SearchOptions.maxHydrate`); a source that reads whole profile partitions
   * spends it across every batch it is called with, and one that reads records
   * individually can ignore it.
   */
  docs(refs: DocRef[], options?: { maxPartitions?: number }): Promise<SearchDoc[]>;
  /**
   * Retrieval strength of one candidate, when the source can tell.
   *
   * "strong" — the candidate matched a whole-name signal (exact index, alias or
   *            prefix), so it can score up to 1.0;
   * "weak"   — it matched token/trigram evidence only, so it can never exceed
   *            `WEAK_CEILING` (see score.ts). That bound is what lets the engine
   *            skip the fuzzy tail of a query that already has confident hits.
   *
   * A source that cannot tell leaves this undefined; the engine then hydrates
   * the whole candidate budget, exactly as it always did.
   */
  tierOf?(ref: DocRef): "strong" | "weak";
  /**
   * Whether the partition budget — not the candidate list — was what stopped the
   * most recent `docs()` calls during this search.
   *
   * This is the difference between "more budget would find more companies" and
   * "there are no more companies to find". Only the source can tell them apart:
   * it is the one that knows a ref was dropped because its partition was past
   * the cap (true) rather than because the stored object simply has no record
   * for it (false). The engine uses it to decide whether a second, larger
   * budget is worth spending; a source that cannot tell leaves it undefined and
   * gets the single-pass behaviour.
   */
  hydrationBudgetHit?(): boolean;
  /**
   * Optional notification that a new search is starting on this source.
   *
   * A source may be reused for several searches (tests do, and an isolate could);
   * retrieval evidence and hydration memos belong to one search, so a source
   * that keeps them must reset them here. Called once per `searchCompanies`,
   * before the first retrieval stage.
   */
  beginSearch?(): void;
  /** Optional df stats so rare trigrams/tokens are queried first. */
  stats?(): Promise<{ docCount: number; df: Record<string, number> }>;
}

export interface SearchOptions {
  page?: number;
  pageSize?: number;
  sort?: CompanySortField;
  order?: SortOrder;
  filters?: CompanyFilters;
  fuzzy?: boolean;
  /** Max candidates that may be scored (hard CPU bound). */
  resultBudget?: number;
  /** Max candidates retrieved per retrieval stage. */
  retrievalBudget?: number;
  /**
   * Byte bound on hydration, in profile partitions read per search.
   *
   * Whole partitions are what an R2 read fetches, so this is the single number
   * that caps a query's transfer and decompression cost regardless of how many
   * candidates retrieval produced. Raising it buys deeper pages for broad fuzzy
   * queries and costs bytes; lowering it is safe for name lookups, whose
   * candidates cluster tightly. Operators can tune it with the
   * `SEARCH_MAX_HYDRATE` Worker variable; the engine clamps it either way.
   */
  maxHydrate?: number;
  /**
   * When the page is still short *and the partition budget was what cut the
   * candidate list short*, spend a second (doubled) budget to fill it. Default
   * true; set false to measure or to hold a hard byte ceiling for every query.
   * See `ADAPTIVE_HYDRATE_FACTOR`. A source that cannot report
   * `hydrationBudgetHit` never takes the second pass.
   */
  adaptiveHydration?: boolean;
}

/** Relevance values inside the same band are treated as equal for ordering. */
export const RELEVANCE_BAND = 0.05;

/**
 * Candidate docs hydrated per call to `CandidateSource.docs`.
 *
 * Batches (rather than one 400-candidate hydration) are what make the early
 * stop below possible: a query whose page is already full of confident hits
 * never pays for the fuzzy tail of its candidate list.
 */
export const HYDRATE_BATCH = 32;

/**
 * Highest relevance a token/trigram-only ("weak") candidate can reach.
 *
 * `fuzzyScore` tops out at 0.95 (full token coverage) and `wholeScore` at 0.9
 * (perfect trigram/edit similarity); the generic-word penalty only lowers them
 * (see score.ts). Alias equality (0.95) and exact equality (1.0) are whole-name
 * signals, so those candidates are retrieved from the exact index and are
 * "strong" — which makes this a valid ceiling, not an estimate. The barrier
 * compares strictly above it, so a weak candidate can never tie a displayed hit
 * inside the same relevance band and reorder the page.
 */
export const WEAK_CEILING = 0.95;

/**
 * How much the hydration budget is raised for a second pass when the requested
 * page is still short (`maxHydrate` → `2 × maxHydrate`, capped by
 * `SEARCH_LIMITS.maxHydrate`).
 *
 * This is the completeness dial: broad, low-precision queries are exactly the
 * ones whose matches are spread over more partitions than the first budget
 * covers, and they are also the ones with a page to fill. It never applies when
 * the first pass already filled the page, so precise queries keep their latency;
 * and it never applies when the first pass had budget left over, so a query with
 * genuinely few matches (an exact name, a prefix with two hits) does not pay for
 * a second round of reads that could not find anything. Both cases are measured
 * in `scripts/benchmark-hydration.mjs` against a real-data index.
 */
export const ADAPTIVE_HYDRATE_FACTOR = 2;

/** Hard ceilings — also enforced server-side in the Worker. */
export const SEARCH_LIMITS = {
  maxPageSize: 100,
  defaultPageSize: 25,
  maxResultBudget: 2000,
  defaultResultBudget: 400,
  defaultRetrievalBudget: 3000,
  maxTrigrams: 14,
  maxPrefixQueries: 6,
  /** Ceiling for `SearchOptions.maxHydrate` (partitions read per search). */
  maxHydrate: 64,
  defaultHydrate: 16,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function uniqueInOrder<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function matchesFilters(doc: SearchDoc, filters?: CompanyFilters): boolean {
  if (!filters) return true;
  if (filters.industry && (doc.industry ?? "").toLowerCase() !== filters.industry.toLowerCase()) return false;
  if (filters.country && (doc.country ?? "").toLowerCase() !== filters.country.toLowerCase()) return false;
  if (filters.city && (doc.city ?? "").toLowerCase() !== filters.city.toLowerCase()) return false;
  if (filters.hasContacts && doc.contactCount <= 0) return false;
  if (filters.hasDomain && !doc.domain) return false;
  if (filters.companySize) return true; // size is not in doc metadata; handled separately
  return true;
}

/**
 * Full-text-preparation of a query: the normalized form, its variants and the
 * token stream. Exported so the Worker, indexer and tests share one definition.
 */
export function prepareQuery(rawQuery: string) {
  const query = rawQuery.trim();
  const normalizedQuery = normalizeName(query);
  const variants = uniqueInOrder(nameVariants(query).map((v) => v.trim()).filter(Boolean));
  const queryTokens = uniqueInOrder(tokenize(normalizedQuery));
  const grams = trigramsOf(normalizedQuery);
  return { query, normalizedQuery, variants, queryTokens, grams };
}

/** Prefer rare grams/tokens when the source can report document frequencies. */
function rarestFirst(values: string[], df: Record<string, number> | null, limit: number): string[] {
  const unique = uniqueInOrder(values);
  if (!df) return unique.slice(0, limit);
  return unique
    // Own-property lookup: `df` comes from a candidate source (or from parsed
    // JSON), so an inherited member must never be read as a document frequency.
    .map((v) => ({ v, freq: Object.prototype.hasOwnProperty.call(df, v) ? df[v] : 0 }))
    .sort((a, b) => a.freq - b.freq)
    .slice(0, limit)
    .map((x) => x.v);
}

/**
 * Run a company search.
 *
 * Nothing here performs a full-collection scan: every retrieval call is given a
 * budget and returns index postings only.
 */
export async function searchCompanies(
  source: CandidateSource,
  rawQuery: string,
  options: SearchOptions = {},
): Promise<CompanySearchResponse> {
  const startedAt = Date.now();
  const pageSize = clamp(Math.floor(options.pageSize ?? SEARCH_LIMITS.defaultPageSize), 1, SEARCH_LIMITS.maxPageSize);
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const sort = options.sort ?? "relevance";
  const order = options.order ?? (sort === "relevance" ? "desc" : "asc");
  const fuzzy = options.fuzzy ?? true;
  const resultBudget = clamp(Math.floor(options.resultBudget ?? SEARCH_LIMITS.defaultResultBudget), 1, SEARCH_LIMITS.maxResultBudget);
  const retrievalBudget = clamp(Math.floor(options.retrievalBudget ?? SEARCH_LIMITS.defaultRetrievalBudget), 1, resultBudget * 4);
  const maxHydrate = clamp(Math.floor(options.maxHydrate ?? SEARCH_LIMITS.defaultHydrate), 1, SEARCH_LIMITS.maxHydrate);

  const { query, normalizedQuery, variants, queryTokens, grams } = prepareQuery(rawQuery);
  const retrieval = { exact: 0, prefix: 0, token: 0, trigram: 0, scored: 0, cached: false };

  const empty = (message: string): CompanySearchResponse => ({
    query,
    normalizedQuery,
    correctedQuery: null,
    notice: message,
    hits: [],
    page: { page, pageSize, total: 0, totalIsLowerBound: false, hasMore: false },
    datasetVersion: source.datasetVersion,
    tookMs: Date.now() - startedAt,
    retrieval,
  });

  if (!query) return empty("Enter a company name to search.");
  if (!normalizedQuery || (!queryTokens.length && variants.length === 0)) {
    return empty("That query contains no searchable characters.");
  }

  const stats = source.stats ? await source.stats().catch(() => null) : null;
  const df = stats?.df ?? null;

  /* --------------------------- Stage 1: retrieval -------------------------- */

  const candidates = new Set<DocRef>();
  const add = (refs: DocRef[]) => {
    for (const r of refs) {
      if (candidates.size >= retrievalBudget) return;
      candidates.add(r);
    }
  };

  source.beginSearch?.();

  const exactRefs = await source.exact(variants, retrievalBudget);
  retrieval.exact = exactRefs.length;
  add(exactRefs);

  // Prefix retrieval also covers short queries, where trigrams are useless.
  const prefixQueries = uniqueInOrder([normalizedQuery, compact(normalizedQuery), ...variants])
    .filter((v) => v.length >= 1)
    .slice(0, SEARCH_LIMITS.maxPrefixQueries);
  if (prefixQueries.length) {
    const prefixRefs = await source.prefix(prefixQueries, retrievalBudget);
    retrieval.prefix = prefixRefs.length;
    add(prefixRefs);
  }

  if (queryTokens.length && normalizedQuery.length >= 3) {
    const tokenQueries = rarestFirst(queryTokens, df, 10);
    const tokenRefs = await source.tokens(tokenQueries, retrievalBudget);
    retrieval.token = tokenRefs.length;
    add(tokenRefs);
  }

  if (fuzzy && normalizedQuery.length >= 3) {
    const gramQueries = rarestFirst(grams, df, SEARCH_LIMITS.maxTrigrams);
    const trigramRefs = await source.trigrams(gramQueries, retrievalBudget);
    retrieval.trigram = trigramRefs.length;
    add(trigramRefs);
  }

  const budgetedRefs = [...candidates].slice(0, resultBudget);

  /* ---------------------------- Stage 2: ranking --------------------------- */

  const minScore = minScoreFor(normalizedQuery.length);
  // Computed once and reused for every candidate (see score.ts).
  const queryTrigrams = trigramSet(normalizedQuery);
  const scored: { doc: SearchDoc; hit: Omit<CompanySearchHit, "id" | "name"> & { id: string; name: string } }[] = [];
  /** Lowest relevance accepted so far — drives the early-stop barrier. */
  let worstRelevance = Infinity;
  let hydrated = 0;
  let stoppedEarly = false;

  const accept = (doc: SearchDoc) => {
    if (!matchesFilters(doc, options.filters)) return;
    const result = scoreDoc(doc, { query, normalizedQuery, queryTokens, variants, fuzzy, queryTrigrams });
    if (!result) return;
    // Short queries must not be answered with loose fuzzy noise.
    if (normalizedQuery.length < 3 && !(result.category === "exact" || result.category === "alias" || result.category === "prefix")) {
      return;
    }
    if (result.score < minScore) return;
    if (result.score < worstRelevance) worstRelevance = result.score;
    scored.push({
      doc,
      hit: {
        id: doc.id,
        name: doc.name,
        matchCategory: result.category,
        relevance: result.score,
        possibleMatch: result.possibleMatch,
        matchedTerms: result.matchedTerms,
        domain: doc.domain,
        contactCount: doc.contactCount,
        multiSource: doc.multiSource ?? false,
      },
    });
  };

  // Candidates arrive best-first, grouped by retrieval strength. Hydrate one
  // run of candidates per tier so the barrier below can be tested on a whole
  // tier instead of a mixed batch.
  // `start` (below) is the first row of the requested page; one extra row is
  // needed to know whether another page exists.
  const rowsToFillPage = (page - 1) * pageSize + pageSize + 1;
  const pageFull = () => scored.length >= rowsToFillPage;

  /** Documents already hydrated, so a second pass can never score one twice. */
  const hydratedIds = new Set<string>();

  /**
   * Hydrate the candidate list best-first with the given partition budget.
   *
   * Candidates arrive grouped by retrieval strength, and one run of candidates
   * per tier is hydrated at a time so the barrier can be tested on a whole tier
   * rather than on a mixed batch.
   */
  const hydrateCandidates = async (maxPartitions: number): Promise<void> => {
    let cursor = 0;
    while (cursor < budgetedRefs.length) {
      const tier = source.tierOf ? source.tierOf(budgetedRefs[cursor]) : "strong";
      let end = cursor + 1;
      if (source.tierOf) {
        while (end < budgetedRefs.length && source.tierOf(budgetedRefs[end]) === tier) end += 1;
      } else {
        // A source without tier knowledge keeps the original single-pass contract.
        end = budgetedRefs.length;
      }

      // Early stop: every hit found so far scores strictly above what a
      // token/trigram-only candidate can reach, and the page is already full — so
      // the rest of the candidate list can neither reorder this page nor add a
      // row to it. The result count then becomes a lower bound
      // (`totalIsLowerBound`), which the API and the UI already report as "N+".
      if (tier === "weak" && pageFull() && worstRelevance > WEAK_CEILING) {
        stoppedEarly = true;
        return;
      }

      for (let from = cursor; from < end; from += HYDRATE_BATCH) {
        const batch = budgetedRefs.slice(from, Math.min(end, from + HYDRATE_BATCH));
        if (!batch.length) continue;
        /*
         * The whole run is asked for again on a retry pass, deliberately: the
         * previous pass may have been cut short by the partition budget, and
         * only the source knows which of these refs it has already stored. A
         * ref it has memorised costs a map lookup, not a read, so re-asking is
         * cheap and is the only way a larger budget can actually reach the
         * candidates the smaller one could not. `hydratedIds` keeps the result
         * set — and the total — free of duplicates.
         */
        const docs = await source.docs(batch, { maxPartitions });
        for (const doc of docs) {
          if (hydratedIds.has(doc.id)) continue;
          hydratedIds.add(doc.id);
          hydrated += 1;
          accept(doc);
        }
      }
      cursor = end;
    }
  };

  await hydrateCandidates(maxHydrate);

  // Adaptive second pass: a page that is still short is the one case where more
  // bytes are worth spending, because the user is looking at an incomplete
  // result list. It re-walks the same candidate order with a doubled partition
  // budget and costs nothing at all for the common case where the first pass
  // already filled the page, or where the first pass had budget to spare (then
  // more reads could not have found anything — `hydrationBudgetHit`).
  //
  // Measured on the real-data sample (`scripts/benchmark-hydration.mjs`): this
  // recovers every row the fixed 16-partition budget lost on broad queries
  // (20 of 20 here) and pays for it only on short pages — ~2× the reads of that
  // query, once, never more than `SEARCH_LIMITS.maxHydrate` partitions. A
  // query whose true match count is below the page size pays it on every
  // search; the only way to avoid that is to know the count before reading,
  // which is a v3 format question, not a tuning one.
  const adaptiveCeiling = Math.min(maxHydrate * ADAPTIVE_HYDRATE_FACTOR, SEARCH_LIMITS.maxHydrate);
  const adaptive = options.adaptiveHydration ?? true;
  const budgetWasTheLimit = source.hydrationBudgetHit?.() ?? false;
  if (adaptive && budgetWasTheLimit && !pageFull() && hydrated < budgetedRefs.length && adaptiveCeiling > maxHydrate) {
    await hydrateCandidates(adaptiveCeiling);
  }

  retrieval.scored = hydrated;

  scored.sort((a, b) => {
    if (sort === "relevance") {
      // Relevance bands: scores within 0.05 are treated as equally good, and
      // inside a band the company with more indexed contacts wins. Without this,
      // a one-word query such as "tata" ranks the shortest name first (Tata
      // Motors) instead of the most prominent company (Tata Consultancy
      // Services). Deterministic: band, then contact count, then name.
      const bandA = Math.round(a.hit.relevance / RELEVANCE_BAND);
      const bandB = Math.round(b.hit.relevance / RELEVANCE_BAND);
      const bandDelta = order === "desc" ? bandB - bandA : bandA - bandB;
      if (bandDelta !== 0) return bandDelta;
      if (b.doc.contactCount !== a.doc.contactCount) return b.doc.contactCount - a.doc.contactCount;
      return a.doc.name.localeCompare(b.doc.name);
    }
    if (sort === "name") {
      const delta = a.doc.name.localeCompare(b.doc.name);
      return order === "asc" ? delta : -delta;
    }
    const delta = a.doc.contactCount - b.doc.contactCount;
    if (delta !== 0) return order === "asc" ? delta : -delta;
    return a.doc.name.localeCompare(b.doc.name);
  });

  const total = scored.length;
  const start = (page - 1) * pageSize;
  const pageSlice = scored.slice(start, start + pageSize);

  const hits: CompanySearchHit[] = pageSlice.map(({ doc, hit }) => ({
    ...hit,
    name: doc.name,
    industry: doc.industry,
    country: doc.country,
    city: doc.city,
  }));

  /* ------------------------------ Presentation ----------------------------- */

  const best = scored[0];
  let correctedQuery: string | null = null;
  let notice: string | null = null;
  if (query.length && !exactRefs.length && best) {
    const cat: MatchCategory = best.hit.matchCategory;
    if (cat === "typo" || cat === "similar") {
      correctedQuery = best.doc.name;
      notice = `Showing similar results for "${query}".`;
    } else if (cat === "prefix") {
      notice = `Showing partial matches for "${query}".`;
    }
  } else if (!scored.length) {
    notice = `No companies matched "${query}".`;
  }

  const pageInfo: PageInfo = {
    page,
    pageSize,
    total,
    // Three reasons the count is a floor rather than an exact number: retrieval
    // was budget-bounded, the early-stop barrier skipped candidates that provably
    // cannot enter this page, or the hydration budget ran out before every
    // candidate it asked for came back.
    totalIsLowerBound: candidates.size >= retrievalBudget || stoppedEarly || hydrated < budgetedRefs.length,
    hasMore: start + pageSize < total,
  };

  return {
    query,
    normalizedQuery,
    correctedQuery,
    notice,
    hits,
    page: pageInfo,
    datasetVersion: source.datasetVersion,
    tookMs: Date.now() - startedAt,
    retrieval,
  };
}

/**
 * Cache key for one search request (layer 1/2/3 all use this).
 *
 * Equivalent queries reuse caches: case, punctuation and whitespace
 * differences normalize away, and repeated *misspellings* hit the same key.
 */
export function buildSearchCacheKey(input: {
  datasetVersion: string;
  query: string;
  fuzzy: boolean;
  sort: CompanySortField;
  order: SortOrder;
  page: number;
  pageSize: number;
  resultBudget: number;
  filters?: CompanyFilters;
}): string {
  const filters = input.filters ?? {};
  const filterKey = Object.keys(filters)
    .sort()
    .map((k) => `${k}=${String((filters as Record<string, unknown>)[k] ?? "")}`)
    .join("&");
  return [
    "s",
    `n${NORMALIZER_VERSION}`,
    input.datasetVersion,
    normalizeName(input.query) || "~",
    input.fuzzy ? "f1" : "f0",
    input.sort,
    input.order,
    `p${input.page}`,
    `z${input.pageSize}`,
    `b${input.resultBudget}`,
    filterKey || "-",
  ].join("|");
}

/** Contact-list cache key (company contacts + filters + page). */
export function buildContactCacheKey(input: {
  datasetVersion: string;
  companyId: string | null;
  page: number;
  pageSize: number;
  sort: string;
  order: SortOrder;
  filters?: Record<string, unknown>;
}): string {
  const filterKey = Object.keys(input.filters ?? {})
    .sort()
    .map((k) => `${k}=${String((input.filters as Record<string, unknown>)[k] ?? "")}`)
    .join("&");
  return [
    "c",
    input.datasetVersion,
    input.companyId ?? "*",
    `${input.sort}:${input.order}`,
    `p${input.page}`,
    `z${input.pageSize}`,
    filterKey || "-",
  ].join("|");
}
