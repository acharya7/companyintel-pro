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
 *
 *   score = max(nameScore, fuzzyScore, wholeScore)
 *           - 0.06 * (matched query tokens that are generic business words, capped 0.18)
 *           * 0.60 when EVERY query token is generic (a query such as
 *             "solutions" must not look like a confident company match)
 *         clamped to 0..1 and rounded to 3 decimals.
 */

import type { MatchCategory } from "../models";
import { GENERIC_TOKENS, compact, normalizeName } from "../normalize";
import {
  commonPrefixLength,
  diceCoefficient,
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

export interface ScoreResult {
  score: number;
  category: MatchCategory;
  /** Company-side terms that matched, used for highlighting. */
  matchedTerms: string[];
  possibleMatch: boolean;
  driver: "exact" | "alias" | "compact" | "prefix" | "token" | "trigram" | "edit";
  /** Diagnostic detail (asserted by tests). */
  detail: { nameScore: number; fuzzyScore: number; wholeScore: number; genericPenalty: number };
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

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Score one hydrated company document against a query. */
export function scoreDoc(doc: SearchDoc, input: ScoreInput): ScoreResult | null {
  const q = input.normalizedQuery;
  if (!q) return null;

  const nameNorm = doc.normalizedName || normalizeName(doc.name);
  const variantSet = new Set([...input.variants, q]);
  const queryTokens = [...new Set(input.queryTokens.filter(Boolean))];
  const genericQuery = queryTokens.length > 0 && queryTokens.every((t) => GENERIC_TOKENS.has(t));

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
    const dice = diceCoefficient(input.queryTrigrams ?? trigramSet(q), docTrigrams(doc));
    wholeScore = Math.max(wholeScore, 0.85 * dice);
    if (Math.abs(q.length - nameNorm.length) <= editBudgetFor(q) + 2) {
      wholeScore = Math.max(wholeScore, 0.9 * editSimilarity(q, nameNorm, editBudgetFor(q)));
    }
  }

  /* ------------------------------ combination ------------------------------ */
  const top = Math.max(nameScore, fuzzyScore, wholeScore);
  if (top <= 0) return null;

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
    detail: { nameScore: round3(nameScore), fuzzyScore: round3(fuzzyScore), wholeScore: round3(wholeScore), genericPenalty: round3(genericPenalty) },
  };
}
