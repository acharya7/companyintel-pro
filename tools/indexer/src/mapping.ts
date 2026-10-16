/**
 * Canonical field mapping and conservative entity resolution.
 *
 * The two source CSVs have different column structures, so each file gets its
 * own mapping produced from the profiler output. Everything then flows through
 * one canonical model, and company identity is derived from strong evidence
 * only:
 *
 *   1. a source-provided company id             (strong, within one file)
 *   2. a canonical LinkedIn company URL         (strong, cross-file)
 *   3. a normalized verified domain             (strong, cross-file)
 *   4. the normalized company name              (weak: used only when no strong
 *      signal exists on either side, and never to merge two rows that both
 *      carry *different* strong evidence)
 *
 * Two similarly named companies therefore stay separate records, marked
 * `ambiguous` so the interface can say so.
 */

import type { Company, CompanyFacets, Contact, FacetBucket, SourceRef } from "../../../src/shared/models";
import { companyId, contactId, shardOf } from "../../../src/shared/hash";
import {
  normalizeAttribute,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
  normalizeName,
  normalizePhone,
  nameVariants,
} from "../../../src/shared/normalize";
// The canonical field list, the header aliases and the header→field mapping are
// shared with the read-only R2 probe and the browser bundle, so they live in
// `src/shared/headers.ts` and are re-exported here to keep every existing
// `from "./mapping"` import (cli.ts, build.ts, tests) working.
export {
  CANONICAL_COMPANY_FIELDS,
  CANONICAL_CONTACT_FIELDS,
  ALL_CANONICAL_FIELDS,
  HEADER_ALIASES,
  normalizeHeader,
  buildColumnMap,
} from "../../../src/shared/headers";

export interface RawCompanyInput {
  name: string;
  domain?: string;
  website?: string;
  linkedinUrl?: string;
  sourceId?: string;
  industry?: string;
  subIndustry?: string;
  country?: string;
  state?: string;
  city?: string;
  companySize?: string;
  revenue?: string;
}

export interface RawContactInput {
  name?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  designation?: string;
  seniority?: string;
  department?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  country?: string;
  state?: string;
  city?: string;
}

/** Extract the canonical company input from one CSV row. */
export function extractCompanyInput(record: string[], map: Record<string, number>): RawCompanyInput | null {
  const pick = (field: string) => {
    const index = map[field];
    if (index === undefined) return undefined;
    return record[index];
  };
  const name = normalizeAttribute(pick("companyname"));
  if (!name) return null;
  return {
    name,
    domain: pick("companydomain"),
    website: pick("companywebsite"),
    linkedinUrl: pick("companylinkedin"),
    sourceId: pick("companyid"),
    industry: pick("industry"),
    subIndustry: pick("subindustry"),
    country: pick("companycountry"),
    state: pick("companystate"),
    city: pick("companycity"),
    companySize: pick("companysize"),
    revenue: pick("companyrevenue"),
  };
}

/** Extract the canonical contact input from one CSV row. */
export function extractContactInput(record: string[], map: Record<string, number>): RawContactInput | null {
  const pick = (field: string) => {
    const index = map[field];
    if (index === undefined) return undefined;
    return record[index];
  };
  const firstName = normalizeAttribute(pick("firstname"));
  const lastName = normalizeAttribute(pick("lastname"));
  const full = normalizeAttribute(pick("contactname")) ?? [firstName, lastName].filter(Boolean).join(" ");
  if (!full && !pick("email")) return null;
  return {
    name: full || undefined,
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
    title: pick("jobtitle"),
    designation: pick("designation"),
    seniority: pick("seniority"),
    department: pick("department"),
    email: pick("email"),
    phone: pick("phone"),
    linkedinUrl: pick("linkedin"),
    country: normalizeAttribute(pick("contactcountry")) ?? normalizeAttribute(pick("companycountry")) ?? undefined,
    state: normalizeAttribute(pick("contactstate")) ?? normalizeAttribute(pick("companystate")) ?? undefined,
    city: normalizeAttribute(pick("contactcity")) ?? normalizeAttribute(pick("companycity")) ?? undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Entity resolution                                                          */
/* -------------------------------------------------------------------------- */

export interface CompanyKeys {
  /** Every identifier this row carries, strongest first. */
  all: string[];
  /** Strongest identifier of this row (domain → LinkedIn → source id → name). */
  bucket: string;
  /**
   * Spool partition key — deliberately the NORMALIZED NAME, not the strongest
   * identifier.
   *
   * Two rows can only be merged into one company when they are resolved in the
   * same partition, and a row is resolved against the companies that share its
   * partition. Partitioning by the strongest identifier works when both sources
   * describe companies the same way, but this dataset does not: one file is
   * organizations (name + domain + organization id) and the other is individual
   * people whose only company signal is a sanitized company NAME. Partitioning
   * organizations by domain and people by name would put every company and every
   * contact in different partitions, so no contact would ever attach to its
   * company — the exact association failure the specification requires us to
   * avoid.
   *
   * The normalized name is the one signal both files can compute, so it is the
   * join key. The full identifier set still travels with the row, so inside a
   * partition domain / LinkedIn / source-id evidence is used exactly as before
   * (and contradictory evidence still forces separate, flagged records).
   *
   * Known trade-off: two rows for one company whose names normalize differently
   * (e.g. a rebrand) but share a domain now land in different partitions and stay
   * separate records. That is visible and fixable later; silently attaching
   * millions of people to the wrong companies is not.
   */
  partitionKey: string;
  strong: boolean;
  normalizedName: string;
}

/**
 * Collect every identifier a company row carries.
 *
 * A row can legitimately carry several (a domain *and* a LinkedIn page *and* a
 * source id), and two rows for the same company rarely carry the same subset.
 * Treating a difference in *kinds* as a conflict would split real companies
 * apart, so identifiers are unioned instead and only contradictory values of
 * the same kind stay separate.
 */
export function companyKeysFromInput(input: RawCompanyInput, sourceId: string): CompanyKeys {
  const domain = normalizeDomain(input.domain ?? input.website);
  const linkedin = normalizeLinkedin(input.linkedinUrl, "company");
  const provided = normalizeAttribute(input.sourceId);
  const normalizedName = normalizeName(input.name);
  const all: string[] = [];
  if (domain) all.push(`d:${domain}`);
  if (linkedin) all.push(`l:${linkedin}`);
  if (provided) all.push(`s:${sourceId}:${provided.toLowerCase()}`);
  all.push(`n:${normalizedName}`);
  return {
    all,
    bucket: all[0],
    partitionKey: `n:${normalizedName}`,
    strong: all.length > 1,
    normalizedName,
  };
}

/**
 * Canonical identity for a merged company record.
 *
 * Preference order (most to least stable across files and re-runs):
 *   verified domain → canonical LinkedIn page → source-provided id → name.
 * Using the strongest available identifier keeps company ids identical between
 * a sample run and the full run.
 */
export function pickCanonicalKey(keys: Iterable<string>): string {
  const list = [...keys];
  const byPrefix = (prefix: string) => list.filter((key) => key.startsWith(prefix)).sort()[0];
  return byPrefix("d:") ?? byPrefix("l:") ?? byPrefix("s:") ?? byPrefix("n:") ?? "n:unknown";
}

export interface ResolutionDecision {
  /** Document ref assigned to the company. */
  ref: number;
  /** True when this row created the company record. */
  created: boolean;
  /** True when a strong-evidence conflict forced a separate record. */
  ambiguous: boolean;
}

/**
 * Resolve a company row against the identities already seen in this partition.
 *
 * Rules (deliberately conservative):
 *  - every identifier of the row is looked up; exactly one matching record means
 *    the row belongs to it, and the row's remaining identifiers are registered
 *    against that record so later rows can match through any of them;
 *  - two *different* records matching the row means the evidence contradicts
 *    itself (e.g. two unrelated domains); a separate record is created and the
 *    name-collision rule marks the family ambiguous;
 *  - a name-only row attaches to an existing name-only record, never to a record
 *    that already has strong identifiers — that is the case where a fuzzy name
 *    could silently attach unrelated rows to a real company.
 */
interface IdentityEntry {
  ref: number;
  strong: boolean;
  normalizedName: string;
  ambiguous: boolean;
}

/**
 * Per-partition entity resolver.
 *
 * One resolver handles a single hash partition, so the identity maps stay small
 * enough to live in memory no matter how large the full dataset is.
 */
export class CompanyResolver {
  private readonly index = new Map<string, IdentityEntry>();
  private readonly byName = new Map<string, number[]>();
  private readonly byRef = new Map<number, IdentityEntry>();
  private nextRef = 0;

  get size(): number {
    return this.nextRef;
  }

  refs(): number[] {
    return [...this.byRef.keys()];
  }

  entry(ref: number): IdentityEntry | undefined {
    return this.byRef.get(ref);
  }

  resolve(keys: CompanyKeys): ResolutionDecision {
    const strongKeys = keys.all.filter((key) => !key.startsWith("n:"));
    const matches = new Set<number>();
    for (const key of keys.all) {
      const entry = this.index.get(key);
      if (entry) matches.add(entry.ref);
    }
    const strongMatch = strongKeys.some((key) => this.index.has(key));
    const sameNameRefs = this.byName.get(keys.normalizedName) ?? [];

    if (matches.size === 1 && (!keys.strong || strongMatch)) {
      const [ref] = [...matches];
      this.register(keys, ref, false);
      return { ref, created: false, ambiguous: this.byRef.get(ref)?.ambiguous ?? false };
    }

    if (!keys.strong && matches.size === 0 && sameNameRefs.length === 1) {
      const candidate = this.byRef.get(sameNameRefs[0]);
      if (candidate && !candidate.strong) {
        this.register(keys, candidate.ref, false);
        return { ref: candidate.ref, created: false, ambiguous: candidate.ambiguous };
      }
    }

    // Either no evidence, contradictory evidence, or a name that only *looks*
    // like an existing company: create a separate record. A row that carries a
    // domain or LinkedIn page is never merged on a name match alone, and any
    // same-name family is flagged so the interface can say the records were kept
    // apart rather than silently combined.
    const contradictory = matches.size > 1 || (keys.strong && !strongMatch && sameNameRefs.length > 0);
    if (sameNameRefs.length > 0) {
      for (const ref of sameNameRefs) {
        const entry = this.byRef.get(ref);
        if (entry) entry.ambiguous = true;
      }
    }
    const ref = this.nextRef;
    this.nextRef += 1;
    this.register(keys, ref, contradictory);
    return { ref, created: true, ambiguous: contradictory };
  }

  private register(keys: CompanyKeys, ref: number, ambiguous: boolean): void {
    const existing = this.byRef.get(ref);
    const entry: IdentityEntry = existing ?? {
      ref,
      strong: keys.strong,
      normalizedName: keys.normalizedName,
      ambiguous,
    };
    if (ambiguous) entry.ambiguous = true;
    if (keys.strong) entry.strong = true;
    this.byRef.set(ref, entry);
    for (const key of keys.all) this.index.set(key, entry);
    const list = this.byName.get(keys.normalizedName) ?? [];
    if (!list.includes(ref)) list.push(ref);
    this.byName.set(keys.normalizedName, list);
  }

  /** Ref that owns a given identifier, if any. */
  refFor(key: string): number | undefined {
    return this.index.get(key)?.ref;
  }
}

/* -------------------------------------------------------------------------- */
/* Record builders                                                            */
/* -------------------------------------------------------------------------- */

export interface MappedRecord {
  company: Company;
  /** Synthetic contact id before deduplication. */
  contact: Contact | null;
  companyKey: string;
  contactKey: string | null;
}

export interface CanonicalCompanyKey {
  /** Strongest identifier available: `d:` domain, `l:` LinkedIn, `s:` source id, `n:` name. */
  key: string;
  strong: boolean;
  normalizedName: string;
  display?: string;
}

export function buildCompany(params: {
  ref: number;
  input: RawCompanyInput;
  key: CanonicalCompanyKey;
  sources: SourceRef[];
  ambiguous: boolean;
}): Company {
  const normalizedName = params.key.normalizedName;
  const domain = normalizeDomain(params.input.domain ?? params.input.website);
  const variants = nameVariants(params.input.name).filter((variant) => variant !== normalizedName);
  return {
    id: companyId(params.key.key),
    name: params.input.name,
    normalizedName,
    aliases: variants.length ? variants : undefined,
    domain: domain ?? undefined,
    website: domain ? `https://${domain}` : normalizeAttribute(params.input.website) ?? undefined,
    linkedinUrl: params.input.linkedinUrl ? `https://${normalizeLinkedin(params.input.linkedinUrl, "company")}` : undefined,
    industry: normalizeAttribute(params.input.industry) ?? undefined,
    subIndustry: normalizeAttribute(params.input.subIndustry) ?? undefined,
    country: normalizeAttribute(params.input.country) ?? undefined,
    state: normalizeAttribute(params.input.state) ?? undefined,
    city: normalizeAttribute(params.input.city) ?? undefined,
    companySize: normalizeAttribute(params.input.companySize) ?? undefined,
    revenue: normalizeAttribute(params.input.revenue) ?? undefined,
    contactCount: 0,
    sources: params.sources,
    ambiguous: params.ambiguous || undefined,
    facets: emptyFacets(),
  };
}

export function emptyFacets(): CompanyFacets {
  return {
    designations: [],
    departments: [],
    seniority: [],
    countries: [],
    cities: [],
    emailAvailable: 0,
    linkedinAvailable: 0,
  };
}

export function buildContact(params: {
  input: RawContactInput;
  company: Company;
  source: SourceRef;
  rowFingerprint: string;
}): Contact {
  const email = normalizeEmail(params.input.email);
  const linkedin = normalizeLinkedin(params.input.linkedinUrl, "in");
  const name = params.input.name ?? [params.input.firstName, params.input.lastName].filter(Boolean).join(" ");
  return {
    id: contactId(`${params.company.id}|${params.rowFingerprint}`),
    companyId: params.company.id,
    fullName: name || email || "Unknown contact",
    firstName: normalizeAttribute(params.input.firstName) ?? undefined,
    lastName: normalizeAttribute(params.input.lastName) ?? undefined,
    title: normalizeAttribute(params.input.title) ?? undefined,
    designation: normalizeAttribute(params.input.designation) ?? undefined,
    seniority: normalizeAttribute(params.input.seniority) ?? undefined,
    department: normalizeAttribute(params.input.department) ?? undefined,
    email: email ?? undefined,
    phone: normalizePhone(params.input.phone) ?? undefined,
    linkedinUrl: linkedin ? `https://${linkedin}` : undefined,
    country: normalizeAttribute(params.input.country) ?? undefined,
    state: normalizeAttribute(params.input.state) ?? undefined,
    city: normalizeAttribute(params.input.city) ?? undefined,
    source: params.source,
  };
}

/** Stable fingerprint used to deduplicate contacts without merging distinct people. */
export function contactFingerprint(contact: Contact): string | null {
  if (contact.email) return `e:${contact.email}`;
  if (contact.linkedinUrl) return `l:${contact.linkedinUrl.replace(/^https?:\/\//, "")}`;
  // Same person name at the same company with the same title is treated as a
  // duplicate row; a different title stays a separate contact.
  if (contact.fullName) {
    return `n:${contact.companyId}|${contact.fullName.toLowerCase()}|${(contact.title ?? "").toLowerCase()}`;
  }
  return null;
}

/** Accumulate facets for one company as contacts are added. */
export function accumulateFacets(facets: CompanyFacets, contact: Contact): void {
  pushBucket(facets.designations, contact.designation);
  pushBucket(facets.departments, contact.department);
  pushBucket(facets.seniority, contact.seniority);
  pushBucket(facets.countries, contact.country);
  pushBucket(facets.cities, contact.city);
  if (contact.email) facets.emailAvailable += 1;
  if (contact.linkedinUrl) facets.linkedinAvailable += 1;
}

function pushBucket(buckets: FacetBucket[], value?: string): void {
  if (!value) return;
  const existing = buckets.find((bucket) => bucket.value === value);
  if (existing) existing.count += 1;
  else buckets.push({ value, count: 1 });
}

export function finalizeFacets(facets: CompanyFacets, topN = 40): CompanyFacets {
  const trim = (buckets: FacetBucket[]) =>
    [...buckets].sort((a, b) => b.count - a.count).slice(0, topN);
  return {
    designations: trim(facets.designations),
    departments: trim(facets.departments),
    seniority: trim(facets.seniority),
    countries: trim(facets.countries),
    cities: trim(facets.cities),
    emailAvailable: facets.emailAvailable,
    linkedinAvailable: facets.linkedinAvailable,
  };
}

/**
 * Deterministic partition for a company key (disk-backed grouping).
 *
 * Deliberately the same function the index shards use, because a spool partition
 * number is a fact recorded in `spool-manifest.json`: the mapping must not move, or
 * an existing Pass 1 spool becomes unreadable by the build that wrote it.
 */
export function partitionFor(key: string, partitions: number): number {
  return shardOf(key, partitions);
}
