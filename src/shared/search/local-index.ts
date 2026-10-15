/**
 * In-memory candidate source used by:
 *   - the browser preview adapter (synthetic sample dataset),
 *   - unit / relevance tests,
 *   - the indexer's self-validation step (it re-runs queries in-process).
 *
 * It implements exactly the same `CandidateSource` contract as the R2-backed
 * Worker source, so relevance behaviour cannot drift between them.
 */

import type { Company } from "../models";
import { compact, normalizeName, nameVariants, tokenize } from "../normalize";
import type { CandidateSource, DocRef } from "./engine";
import type { SearchDoc } from "./score";
import { trigramsOf } from "./similarity";

export interface IndexedCompany extends SearchDoc {
  company: Company;
}

/** Build the search view of a company record. */
export function toSearchDoc(company: Company): SearchDoc {
  const primary = company.normalizedName || normalizeName(company.name);
  const aliases = new Set<string>();
  for (const alias of company.aliases ?? []) aliases.add(alias);
  for (const variant of nameVariants(company.name)) if (variant !== primary) aliases.add(variant);
  aliases.delete(primary);
  return {
    id: company.id,
    name: company.name,
    normalizedName: primary,
    aliases: [...aliases],
    tokens: tokenize(primary),
    contactCount: company.contactCount,
    industry: company.industry,
    country: company.country,
    city: company.city,
    domain: company.domain,
    multiSource: new Set(company.sources.map((source) => source.source)).size > 1,
  };
}

export class LocalCandidateSource implements CandidateSource {
  readonly kind = "local" as const;
  readonly datasetVersion: string;

  private readonly companies: Company[];
  private readonly docByRef: SearchDoc[] = [];
  private readonly companyByRef: Company[] = [];
  private readonly refById = new Map<string, DocRef>();
  private readonly exactMap = new Map<string, DocRef[]>();
  private readonly prefixMap = new Map<string, DocRef[]>();
  private readonly tokenMap = new Map<string, DocRef[]>();
  private readonly trigramMap = new Map<string, DocRef[]>();
  private readonly df: Record<string, number> = {};

  /** Max prefix length indexed; longer prefixes fall back to the longest bucket. */
  static readonly MAX_PREFIX = 12;

  constructor(companies: Company[], datasetVersion: string) {
    this.companies = companies;
    this.datasetVersion = datasetVersion;

    companies.forEach((company, ref) => {
      const doc = toSearchDoc(company);
      this.docByRef[ref] = doc;
      this.companyByRef[ref] = company;
      this.refById.set(doc.id, ref);

      for (const key of new Set([doc.normalizedName, ...doc.aliases])) {
        push(this.exactMap, key, ref);
      }
      // Prefix index covers BOTH the spaced normalized name (tata consult...) and
      // the spaceless form (tatacons...), because users type both and a prefix
      // lookup must be able to answer without a trigram scan.
      for (const prefixSource of new Set([doc.normalizedName, compact(doc.normalizedName)])) {
        const maxPrefix = Math.min(LocalCandidateSource.MAX_PREFIX, prefixSource.length);
        for (let i = 1; i <= maxPrefix; i += 1) push(this.prefixMap, prefixSource.slice(0, i), ref);
      }

      for (const token of new Set(doc.tokens)) {
        push(this.tokenMap, token, ref);
        this.df[token] = (this.df[token] ?? 0) + 1;
      }
      for (const gram of new Set(trigramsOf(doc.normalizedName))) {
        push(this.trigramMap, gram, ref);
        this.df[gram] = (this.df[gram] ?? 0) + 1;
      }
    });
  }

  get size(): number {
    return this.companies.length;
  }

  companyAt(ref: DocRef): Company | undefined {
    return this.companyByRef[ref];
  }

  refOfCompanyId(id: string): DocRef | undefined {
    return this.refById.get(id);
  }

  /** All refs, used by the preview adapter for company-id lookups and facets. */
  allRefs(): DocRef[] {
    return this.docByRef.map((_, i) => i);
  }

  async exact(variants: string[], budget: number): Promise<DocRef[]> {
    const out: DocRef[] = [];
    for (const variant of variants) {
      const refs = this.exactMap.get(variant);
      if (!refs) continue;
      for (const r of refs) {
        out.push(r);
        if (out.length >= budget) return out;
      }
    }
    return out;
  }

  /**
   * Prefix lookup. Prefixes longer than MAX_PREFIX are truncated, which can
   * over-fetch but never under-fetch; scoring removes the extra rows.
   */
  async prefix(prefixes: string[], budget: number): Promise<DocRef[]> {
    const out: DocRef[] = [];
    for (const prefix of prefixes) {
      const key = prefix.slice(0, LocalCandidateSource.MAX_PREFIX);
      if (!key) continue;
      const refs = this.prefixMap.get(key);
      if (!refs) continue;
      for (const r of refs) {
        out.push(r);
        if (out.length >= budget) return out;
      }
    }
    return out;
  }

  async tokens(tokens: string[], budget: number): Promise<DocRef[]> {
    const counts = new Map<DocRef, number>();
    const wanted = Math.max(1, Math.ceil(tokens.length * 0.5));
    for (const token of tokens) {
      const refs = this.tokenMap.get(token);
      if (!refs) continue;
      for (const r of refs) counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    // Prefer docs matching more query tokens; fall back to single-token hits
    // only when nothing else exists (rare in practice, matters for 1-token queries).
    const strong: DocRef[] = [];
    const weak: DocRef[] = [];
    for (const [ref, count] of counts) (count >= wanted ? strong : weak).push(ref);
    return [...strong, ...weak].slice(0, budget);
  }

  async trigrams(grams: string[], budget: number): Promise<DocRef[]> {
    const counts = new Map<DocRef, number>();
    for (const gram of grams) {
      const refs = this.trigramMap.get(gram);
      if (!refs) continue;
      for (const r of refs) counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ref]) => ref);
    return ranked.slice(0, budget);
  }

  async docs(refs: DocRef[]): Promise<SearchDoc[]> {
    const out: SearchDoc[] = [];
    for (const ref of refs) {
      const doc = this.docByRef[ref];
      if (doc) out.push(doc);
    }
    return out;
  }

  async stats(): Promise<{ docCount: number; df: Record<string, number> }> {
    return { docCount: this.docByRef.length, df: this.df };
  }
}

function push(map: Map<string, DocRef[]>, key: string, ref: DocRef): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(ref);
  else map.set(key, [ref]);
}
