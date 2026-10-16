/**
 * Relevance scoring for company search.
 *
 * Relevance is a product decision, so the formula lives here, explicitly, with
 * one job per term. It is intentionally cheap: no per-candidate string scans
 * over the whole collection, and edit distance is always bounded.
 *
 *   nameScore   whole-string identity signals
 *                 1.00  exact normalized equality (legal suffix / case / accent
 *                       / punctuation / whitespace differences are already gone)
 *                 0.95  alias equality (abbreviation-expanded, unstripped form)
 *                 0.90  compact (spaceless) equality
 *                 0..0.80  prefix tier: query is a full prefix of the name,
 *                          scaled by how much of the name it covers
 *
 *   fuzzyScore  token-level fuzzy coverage — the workhorse for typos,
 *               missing/extra letters and word-order variation:
 *                 per query token: 1.00 when the token exists, otherwise
 *                 `0.95 - 0.12 * (distance / budget)` when a company token is
 *                 within the length-aware edit budget, otherwise 0.
 *                 fuzzyScore = 0.95 * mean(per-token score)
 *
 *   wholeScore  whole-string fuzzy signals, used when the query is a single
 *               token or when token coverage is thin:
 *                 0.85 * trigram Dice similarity
 *                 0.90 * bounded edit similarity
 *               ... but only for a name that could plausibly be the same entity
 *               (see `MIN_FUZZY_NAME_LENGTH_RATIO` and `MIN_QUERY_TRIGRAM_COVERAGE`
 *               below). Without that gate the Dice ratio is dominated by the
 *               *shorter* of the two strings: a 3-letter name shares 2 of its 3
 *               trigrams with an 11-character nonsense query, which is a Dice of
 *               0.44 — above `minScoreFor(11)` — even though only a third of the
 *               query is accounted for. Measured on the real-data benchmark, that
 *               is what made the query `zzzzzzqqqqq` return seven "possible"
 *               matches instead of none (see docs/search-quality.md).
 *
 *   score = max(nameScore, fuzzyScore, wholeScore)
 *           - 0.06 * (matched query tokens that are generic business words, capped 0.18)
 *           * 0.60 when EVERY query token is generic (a query such as
 *             "solutions" must not look like a confident company match)
 *         clamped to 0..1 and rounded to 3 decimals.
 *
 *   identityEvidence  whole-name evidence that is *not* part of the name, so it
 *               can only confirm a match, never manufacture one: the company's
 *               domain label (2 = the query IS that label, 1 = one query token
 *               is, 0 = no domain evidence). It is reported in `detail` and used
 *               by the engine as a ranking tie-break inside a relevance band — a
 *               company whose own domain answers the query outranks one that
 *               merely shares the band, whether or not the latter has more
 *               contacts. It never changes the score, so it cannot promote a
 *               name-only guess above a real match.
 */

import type { MatchCategory } from "../models";
import { GENERIC_TOKENS, compact, normalizeName } from "../normalize";
import {
  commonPrefixLength,
  editBudgetFor,
  editSimilarity,
  boundedLevenshtein,
  trigramSet,
} from "./similarity";

export interface SearchDoc {
  id: string;
  name: string;
  /** Primary normalized name (equals `normalizeName(name)`). */
  normalizedName: string;
  /** Normalized alias forms: abbreviation-expanded, unstripped, compact. */
  aliases: string[];
  /** Normalized token stream of the name. */
  tokens: string[];
  contactCount: number;
  industry?: string;
  country?: string;
  city?: string;
  domain?: string;
  /** True when rows from more than one source file were merged into this company. */
  multiSource?: boolean;
}

export interface ScoreInput {
  /** Raw query as typed. */
  query: string;
  /** `normalizeName(query)`. */
  normalizedQuery: string;
  /** Query tokens (from the normalized query). */
  queryTokens: string[];
  /** All normalized search forms that should count as an exact/alias match. */
  variants: string[];
  /** When false only exact / alias / prefix matches are accepted. */
  fuzzy: boolean;
  /**
   * Trigrams of the normalized query. Computed once per search by the caller
   * (`engine.ts`) and reused for every candidate, because rebuilding the same
   * set a few hundred times per query is pure CPU waste.
   */
  queryTrigrams?: Set<string>;
}

/**
 * Per-document trigram set cache. Candidates are scored repeatedly across
 * searches in the same isolate, so this turns a per-query allocation into a
 * one-off cost. Keyed weakly, so it never pins a document in memory.
 */
const docTrigramCache = new WeakMap<SearchDoc, Set<string>>();

function docTrigrams(doc: SearchDoc): Set<string> {
  const cached = docTrigramCache.get(doc);
  if (cached) return cached;
  const computed = trigramSet(doc.normalizedName || normalizeName(doc.name));
  docTrigramCache.set(doc, computed);
  return computed;
}

/**
 * The registrable label of a company domain: `tcs.com` → `tcs`,
 * `meridian-logistics.example` → `meridianlogistics`. Null when there is no
 * usable domain. Used only to *confirm* a match (see `identityEvidence`).
 */
export function domainLabel(domain?: string | null): string | null {
  if (!domain) return null;
  const host = String(domain).trim().toLowerCase().replace(/^www\./, "");
  const first = host.split(".")[0];
  const label = first.replace(/[^a-z0-9]/g, "");
  return label.length >= 2 ? label : null;
}

/**
 * How strongly the query is answered by the company's own domain.
 *
 * 2 — the query's compact form IS the domain label (`tcs` vs `tcs.com`);
 * 1 — one query token is the label (`tcs india` vs `tcs.com`);
 * 0 — no domain evidence.
 *
 * A domain is identity evidence that the name index does not contain, so it can
 * only ever confirm a candidate that retrieval has already produced. It is
 * deliberately *not* added to the relevance score: the score is a claim about how
 * well the name matches, and a domain label is a different claim.
 */
export function identityEvidenceFor(doc: SearchDoc, queryTokens: string[], compactQuery: string): number {
  const label = domainLabel(doc.domain);
  if (!label) return 0;
  if (compactQuery && compactQuery === label) return 2;
  for (const token of queryTokens) if (token === label) return 1;
  return 0;
}

export interface ScoreResult {
  score: number;
  category: MatchCategory;
  /** Company-side terms that matched, used for highlighting. */
  matchedTerms: string[];
  possibleMatch: boolean;
  driver: "exact" | "alias" | "compact" | "prefix" | "token" | "trigram" | "edit";
  /** Diagnostic detail (asserted by tests). */
  detail: {
    nameScore: number;
    fuzzyScore: number;
    wholeScore: number;
    genericPenalty: number;
    /** Share of the query's trigrams found in the name (0..1). */
    trigramCoverage: number;
    /** Why a whole-string fuzzy score was withheld, when it was. */
    fuzzyGate: "ok" | "short-name" | "low-coverage" | "not-fuzzy";
    /** 0 = none, 1 = a query token is the domain label, 2 = the query IS the label. */
    identityEvidence: number;
  };
}

/** Minimum accepted score, by normalized query length. Short queries are strict. */
export function minScoreFor(queryLength: number): number {
  if (queryLength <= 2) return 0.5;
  if (queryLength <= 5) return 0.45;
  if (queryLength <= 9) return 0.4;
  return 0.36;
}

/** Below this, the UI must hedge with "Possible match". */
const CONFIDENT_SCORE = 0.72;

/**
 * A whole-string fuzzy match requires the company name to be at least this
 * fraction of the query's length.
 *
 * Edit similarity and Dice similarity are both normalized by length, which makes
 * them generous exactly when one side is tiny: "zzq" is one edit from any
 * 3-character query and shares two trigrams with an 11-character nonsense string.
 * A real company name that a user typed a long query for cannot be a third of
 * its length, so this gate only ever removes matches that were never plausible.
 * It is deliberately generous (half) and applies only to the whole-string fuzzy
 * terms — an exact, alias, compact or prefix match never passes through it, and
 * token-level fuzzy matching (which is per-token and therefore length-aware) is
 * unaffected.
 */
export const MIN_FUZZY_NAME_LENGTH_RATIO = 0.5;

/** Share of the QUERY's trigrams that must appear in the name for a whole-string
 * fuzzy match. The Dice ratio is symmetric and can be carried by a handful of
 * trigrams in a very short name; requiring half of the query's trigrams keeps a
 * genuine typo ("microsft" covers 5 of 8) while rejecting noise ("zzzzzzqqqqq"
 * covers 2 of 6 in "zzzzzzz"). */
export const MIN_QUERY_TRIGRAM_COVERAGE = 0.5;

/** Absolute floor on shared trigrams, so a 3-character query cannot pass the
 * coverage ratio with a single shared gram. */
export const MIN_SHARED_TRIGRAMS = 2;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Score one hydrated company document against a query. */
export function scoreDoc(doc: SearchDoc, input: ScoreInput): ScoreResult | null {
  const q = input.normalizedQuery;
  if (!q) return null;

  const nameNorm = doc.normalizedName || normalizeName(doc.name);
  const variantSet = new Set([...input.variants, q]);
  const queryTokens = [...new Set(input.queryTokens.filter(Boolean))];
  const genericQuery = queryTokens.length > 0 && queryTokens.every((t) => GENERIC_TOKENS.has(t));
  // Computed once per candidate and reused below: the whole-string fuzzy gate
  // needs the shared trigrams anyway, and the caller reuses `identityEvidence` as
  // a tie-break inside a relevance band.
  const identityEvidence = identityEvidenceFor(doc, queryTokens, compact(q));
  let trigramCoverage = 0;
  let fuzzyGate: ScoreResult["detail"]["fuzzyGate"] = input.fuzzy ? "ok" : "not-fuzzy";

  /* ---------------------------- whole-string tiers ------------------------- */
  let nameScore = 0;
  let category: MatchCategory | null = null;
  let driver: ScoreResult["driver"] = "trigram";

  if (variantSet.has(nameNorm)) {
    nameScore = 1;
    category = "exact";
    driver = "exact";
  } else if (doc.aliases.some((a) => variantSet.has(a))) {
    nameScore = 0.95;
    category = "alias";
    driver = "alias";
  } else if (variantSet.has(compact(nameNorm)) || compact(q) === compact(nameNorm) || doc.aliases.includes(compact(q))) {
    nameScore = 0.9;
    category = "alias";
    driver = "compact";
  }

  if (nameScore < 0.95 && q.length >= 3) {
    const cp = commonPrefixLength(q, nameNorm);
    const compactQ = compact(q);
    const compactName = compact(nameNorm);
    const compactCp = commonPrefixLength(compactQ, compactName);
    const spacedPrefix = cp === q.length && cp < nameNorm.length;
    const compactPrefix = compactCp === compactQ.length && compactCp < compactName.length;
    if (spacedPrefix || compactPrefix) {
      const coverage = spacedPrefix ? q.length / nameNorm.length : compactQ.length / compactName.length;
      const score = 0.8 * (0.5 + 0.5 * coverage);
      if (score > nameScore) {
        nameScore = score;
        category = "prefix";
        driver = "prefix";
      }
    }
  }

  /* ------------------------------- fast paths ------------------------------ */
  // Normalized-name equality cannot be beaten, and its token coverage is 1 by
  // construction (same string ⇒ same tokens), so the token and whole-string
  // fuzzy passes are skipped entirely. Exact lookups are the most common query
  // shape, so this is the difference between ~1 ms and ~25 ms per search.
  if (nameScore === 1) {
    const lengthFitExact = Math.min(1, (queryTokens.length + 0.5) / Math.max(1, doc.tokens.length));
    const genericMatchedExact = queryTokens.filter((t) => GENERIC_TOKENS.has(t)).length;
    const genericPenaltyExact = Math.min(0.18, genericMatchedExact * 0.06);
    let exactScore = 1 - genericPenaltyExact;
    if (genericQuery) exactScore *= 0.6;
    exactScore = Math.max(0, Math.min(1, round3(exactScore)));
    return {
      score: exactScore,
      category: "exact",
      matchedTerms: queryTokens,
      possibleMatch: exactScore < CONFIDENT_SCORE || (genericQuery && exactScore < 0.8),
      driver: "exact",
      detail: {
        nameScore: 1,
        fuzzyScore: round3(input.fuzzy ? 0.95 * (0.85 + 0.15 * lengthFitExact) : 0),
        wholeScore: 0,
        genericPenalty: round3(genericPenaltyExact),
        // An exact name match does not need (and is not re-scored with) trigram
        // evidence — reporting 1.0 is the honest value of "the whole query is in
        // this name", and it keeps the diagnostics comparable across categories.
        trigramCoverage: 1,
        fuzzyGate: "ok",
        identityEvidence,
      },
    };
  }

  /* ------------------------- token-level fuzzy coverage -------------------- */
  const docTokens = new Set(doc.tokens);
  const matchedTerms: string[] = [];
  let tokenTotal = 0;
  for (const qt of queryTokens) {
    if (docTokens.has(qt)) {
      tokenTotal += 1;
      matchedTerms.push(qt);
      continue;
    }
    const budget = editBudgetFor(qt);
    if (!budget) continue;
    let best = 0;
    let bestToken: string | null = null;
    for (const dt of doc.tokens) {
      if (Math.abs(dt.length - qt.length) > budget) continue;
      const dist = boundedLevenshtein(qt, dt, budget);
      if (dist > budget) continue;
      const credit = 0.95 - 0.12 * (dist / budget);
      if (credit > best) {
        best = credit;
        bestToken = dt;
      }
    }
    if (best > 0) {
      tokenTotal += best;
      if (bestToken) matchedTerms.push(bestToken);
    }
  }
  const tokenCoverage = queryTokens.length ? tokenTotal / queryTokens.length : 0;
  // Coverage alone is not enough: "Tata" covers 100% of "Tata Steel"'s first
  // token but describes only half of that company. The length fit keeps a
  // one-word query from out-ranking a genuine full-name match, while tolerating
  // one extra descriptive token ("Goldman Sachs" vs "Goldman Sachs Group").
  const lengthFit = Math.min(1, (queryTokens.length + 0.5) / Math.max(1, doc.tokens.length));
  // The length fit is only a gentle nudge (15%), never a veto: a query like
  // "IBM" legitimately matches "IBM India Private Limited", and the engine's
  // tie-break on contact coverage is what keeps the parent company on top.
  const fuzzyScore = input.fuzzy ? 0.95 * tokenCoverage * (0.85 + 0.15 * lengthFit) : 0;

  /* -------------------------- whole-string fuzzy --------------------------- */
  // An alias / compact-equality match already scores ≥ 0.9, which is above
  // anything these two terms can contribute, so they are skipped.
  let wholeScore = 0;
  if (input.fuzzy && nameScore < 0.9) {
    const queryGrams = input.queryTrigrams ?? trigramSet(q);
    const nameGrams = docTrigrams(doc);
    let shared = 0;
    const [small, large] = queryGrams.size <= nameGrams.size ? [queryGrams, nameGrams] : [nameGrams, queryGrams];
    for (const gram of small) if (large.has(gram)) shared += 1;
    const total = queryGrams.size + nameGrams.size;
    trigramCoverage = queryGrams.size ? shared / queryGrams.size : 0;

    // Gate 1 — relative length. A name that is a small fraction of the query
    // cannot be the entity the user typed; both similarity measures below are
    // normalized by length and would otherwise reward a tiny name.
    const longEnough = nameNorm.length >= Math.max(3, Math.ceil(q.length * MIN_FUZZY_NAME_LENGTH_RATIO));
    // Gate 2 — how much of the QUERY the name accounts for. This is the sound
    // half of the Dice ratio (which is dominated by the shorter side).
    const coveredEnough = shared >= MIN_SHARED_TRIGRAMS && trigramCoverage >= MIN_QUERY_TRIGRAM_COVERAGE;
    if (!longEnough) fuzzyGate = "short-name";
    else if (!coveredEnough) fuzzyGate = "low-coverage";
    else {
      const dice = total ? (2 * shared) / total : 0;
      wholeScore = Math.max(wholeScore, 0.85 * dice);
      if (Math.abs(q.length - nameNorm.length) <= editBudgetFor(q) + 2) {
        wholeScore = Math.max(wholeScore, 0.9 * editSimilarity(q, nameNorm, editBudgetFor(q)));
      }
    }
  }

  /* ------------------------------ combination ------------------------------ */
  const top = Math.max(nameScore, fuzzyScore, wholeScore);
  if (top <= 0) {
    // Nothing scored — but when the only reason is that the fuzzy gate withheld
    // trigram evidence, say so instead of reporting "no opinion". The result is a
    // *negative* with a reason: score 0 can never pass `minScoreFor`, so the
    // engine's threshold rejects it exactly as it rejected `null`, while a
    // diagnostic (`scripts/explain-query.mjs`) can now answer "why is this
    // company not shown" with the gate and the coverage rather than a dash.
    if (fuzzyGate === "short-name" || fuzzyGate === "low-coverage") {
      return {
        score: 0,
        category: "similar",
        matchedTerms: [...new Set(matchedTerms)],
        possibleMatch: true,
        driver: "trigram",
        detail: {
          nameScore: round3(nameScore),
          fuzzyScore: round3(fuzzyScore),
          wholeScore: 0,
          genericPenalty: 0,
          trigramCoverage: round3(trigramCoverage),
          fuzzyGate,
          identityEvidence,
        },
      };
    }
    return null;
  }

  if (!category) {
    // A fuzzy match is a "typo" when at least one query token needed correction,
    // otherwise it is a weaker partial ("similar") match.
    const fuzzyTokenMatched = matchedTerms.some((t) => !queryTokens.includes(t));
    category = fuzzyTokenMatched ? "typo" : "similar";
    driver = fuzzyTokenMatched ? "token" : "trigram";
  }

  const genericMatched = matchedTerms.filter((t) => GENERIC_TOKENS.has(t)).length;
  const genericPenalty = Math.min(0.18, genericMatched * 0.06);
  let score = top - genericPenalty;
  if (genericQuery) score *= 0.6;

  score = Math.max(0, Math.min(1, round3(score)));

  const possibleMatch =
    score < CONFIDENT_SCORE || category === "similar" || (genericQuery && score < 0.8);

  return {
    score,
    category,
    matchedTerms: [...new Set(matchedTerms)],
    possibleMatch,
    driver,
    detail: {
      nameScore: round3(nameScore),
      fuzzyScore: round3(fuzzyScore),
      wholeScore: round3(wholeScore),
      genericPenalty: round3(genericPenalty),
      trigramCoverage: round3(trigramCoverage),
      fuzzyGate,
      identityEvidence,
    },
  };
}
