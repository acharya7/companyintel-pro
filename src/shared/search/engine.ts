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
  /** Hydrate candidate metadata. Called once, for the budgeted set only. */
  docs(refs: DocRef[]): Promise<SearchDoc[]>;
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
}

/** Relevance values inside the same band are treated as equal for ordering. */
export const RELEVANCE_BAND = 0.05;

/** Hard ceilings — also enforced server-side in the Worker. */
export const SEARCH_LIMITS = {
  maxPageSize: 100,
  defaultPageSize: 25,
  maxResultBudget: 2000,
  defaultResultBudget: 400,
  defaultRetrievalBudget: 3000,
  maxTrigrams: 14,
  maxPrefixQueries: 6,
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

  const docs = await source.docs(budgetedRefs);
  retrieval.scored = docs.length;

  const minScore = minScoreFor(normalizedQuery.length);
  // Computed once and reused for every candidate (see score.ts).
  const queryTrigrams = trigramSet(normalizedQuery);
  const scored: { doc: SearchDoc; hit: Omit<CompanySearchHit, "id" | "name"> & { id: string; name: string } }[] = [];

  for (const doc of docs) {
    if (!matchesFilters(doc, options.filters)) continue;
    const result = scoreDoc(doc, { query, normalizedQuery, queryTokens, variants, fuzzy, queryTrigrams });
    if (!result) continue;
    // Short queries must not be answered with loose fuzzy noise.
    if (normalizedQuery.length < 3 && !(result.category === "exact" || result.category === "alias" || result.category === "prefix")) {
      continue;
    }
    if (result.score < minScore) continue;
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
  }

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
    totalIsLowerBound: candidates.size >= retrievalBudget,
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
