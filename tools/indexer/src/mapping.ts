/**
 * Canonical field mapping and conservative entity resolution.
 *
 * The two source CSVs have different column structures, so each file gets its
 * own mapping produced from the profiler output. Everything then flows through
 * one canonical model, and company identity is derived from strong evidence
 * only:
 *
 *   1. a source-provided company id             (strong, within one file)
 *      — scoped to its own source (`s:<source>:<id>`), never compared across
 *      files, because two unrelated datasets number their organizations
 *      independently and a bare id would merge them
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

/**
 * One source column, captured verbatim onto the record.
 *
 * Captured columns are what make "all available source fields" true rather than
 * aspirational: the canonical mapping covers the fields the app searches, filters
 * and ranks on, and EVERY column of the row — mapped or not — is carried alongside
 * the record so a detail page can show the complete original row (§ 11 of the
 * specification).
 *
 * Mapped columns are captured too, on purpose: the canonical field is normalised
 * (a company name is legal-suffix-stripped, a phone number is tidied), so without
 * the raw column the original value would be lost. `organization_name` and
 * `name` therefore coexist, and the raw one is authoritative for display.
 */
export interface CapturedColumn {
  /** Position in the source record. */
  index: number;
  /**
   * The file's own header text, verbatim — the reversible field mapping.
   *
   * A header that appears twice gets `#2`, `#3`, … appended to the second and
   * later occurrences, in file order, so a collision can never overwrite a value.
   */
  label: string;
}

/**
 * Every column of a record, keyed by the file's own header text.
 *
 * There is no column cap: the source schemas are 51 company and 39 contact
 * columns, and dropping one would lose a field the user asked to see. The values
 * are stored in full (see `captureAttributes`) — the measured longest values in
 * the real corpus are ~3.5 KB (`organization_all_possible_domains`) and ~3 KB
 * (`organization_short_description`), which a record can hold without any
 * truncation.
 *
 * `_map` is accepted for call-site compatibility: it used to decide which columns
 * were "already covered" by the canonical model. They are captured now as well.
 */
export function capturedColumns(headers: string[], _map?: Record<string, number>): CapturedColumn[] {
  // Kept for call-site compatibility only; see the doc comment above.
  void _map;
  const out: CapturedColumn[] = [];
  const occurrences = new Map<string, number>();
  for (let index = 0; index < headers.length; index += 1) {
    const header = (headers[index] ?? "").trim();
    if (!header) continue;
    const seen = (occurrences.get(header) ?? 0) + 1;
    occurrences.set(header, seen);
    out.push({ index, label: seen === 1 ? header : `${header}#${seen}` });
  }
  return out;
}

/**
 * Values of every captured column of one row, verbatim and unbounded.
 *
 * Empty cells are omitted rather than stored as `""` — a TSV cannot distinguish
 * "this cell is empty" from "this row stopped early", and storing 51 empty strings
 * on every record would cost more than the data. What IS preserved is every value
 * the source actually carried, at full length: no ellipsis, no character cap.
 */
export function captureAttributes(record: string[], columns: CapturedColumn[]): Record<string, string> | undefined {
  if (!columns.length) return undefined;
  const attributes: Record<string, string> = {};
  for (const column of columns) {
    const raw = record[column.index];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    attributes[column.label] = value;
  }
  return Object.keys(attributes).length ? attributes : undefined;
}

/**
 * Union two captured attribute maps without losing either side.
 *
 * A company can be built from rows of BOTH source files, and the two files use
 * different header names — but where they do collide (or two rows of one file
 * carry different values for the same column) one of the two values must not be
 * dropped. The existing value stays under its own header, and the conflicting one
 * is kept under `<header> (source <id>)`, which is deterministic and traceable.
 */
export function mergeAttributes(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
  sourceId: string,
): Record<string, string> | undefined {
  if (!incoming) return existing;
  if (!existing) return { ...incoming };
  const merged = { ...existing };
  for (const [label, value] of Object.entries(incoming)) {
    if (!(label in merged)) {
      merged[label] = value;
      continue;
    }
    if (merged[label] === value) continue;
    const suffixed = `${label} (source ${sourceId})`;
    merged[suffixed] = value;
  }
  return merged;
}

export interface RawCompanyInput {
  name: string;
  /** Unmapped source columns of this row, kept verbatim for the detail view. */
  attributes?: Record<string, string>;
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
  /** Unmapped source columns of this row, kept verbatim for the detail view. */
  attributes?: Record<string, string>;
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
export function extractCompanyInput(
  record: string[],
  map: Record<string, number>,
  captured: CapturedColumn[] = [],
): RawCompanyInput | null {
  const pick = (field: string) => {
    const index = map[field];
    if (index === undefined) return undefined;
    return record[index];
  };
  const name = normalizeAttribute(pick("companyname"));
  if (!name) return null;
  return {
    name,
    attributes: captureAttributes(record, captured),
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
export function extractContactInput(
  record: string[],
  map: Record<string, number>,
  captured: CapturedColumn[] = [],
): RawContactInput | null {
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
    attributes: captureAttributes(record, captured),
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
  /**
   * True when at least one of this row's non-name identifiers is owned by the
   * returned record — i.e. the record the row resolved to really does carry the
   * employer identity the row itself provided.
   *
   * Stage B needs this distinction: a row that names its own employer (a domain,
   * a source organization id, a company LinkedIn page) is evidence about THAT
   * row, whereas a row that only contributed a name is not. A row whose strong
   * keys were all already owned elsewhere reports `false`, so the association
   * decision cannot treat a stolen claim as its own evidence.
   */
  identityClaimed: boolean;
}

/** One strong identifier two different company records both laid claim to. */
export interface ResolverKeyConflict {
  /** The identifier itself (`d:`, `l:` or `s:` prefixed — never `n:`, see `claim`). */
  key: string;
  /** Ref that owned it first — the owner never changes. */
  ownerRef: number;
  /** Ref of the record whose row tried to claim it afterwards. */
  claimantRef: number;
}

/** Bounded resolver diagnostics, reported by the run and the audit. */
export interface ResolverStats {
  entities: number;
  keys: number;
  /** Total refused claims (may exceed the stored sample). */
  conflicts: number;
  /** Fingerprint-style samples of refused claims, ids only, never a value. */
  samples: ResolverKeyConflict[];
}

/** How many refused claims the resolver keeps for reporting. */
export const RESOLVER_CONFLICT_SAMPLE_LIMIT = 32;

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
 *
 * ## Identifier ownership is immutable (Section 3 / Section 4, rule 7)
 *
 * Registration used to be `this.index.set(key, entry)` for every key of every
 * row. Nothing checked who already owned the key, so a later row could *steal* an
 * identifier from the record that carried it: after that point every row holding
 * the key resolved to the new record, so which company a domain pointed at
 * depended on the order of the input file (and a real domain could change owner
 * between one company and another). Claims are now first-owner-wins: a key that
 * is already owned is never reassigned, the refused claim is counted and sampled
 * for the run report, and the resolver reports whether the row's own identity
 * actually ended up owned by the record it resolved to.
 *
 * ## Bounded records for self-contradicting rows
 *
 * When a row's keys point at two different records, a separate record is created
 * for that evidence pattern (as before) and remembered by signature, so every
 * later row with the same pattern joins it. Without the signature, a row whose
 * keys are all owned elsewhere would create a fresh record on every occurrence —
 * an unbounded number of empty companies on a real file.
 */
export class CompanyResolver {
  private readonly index = new Map<string, IdentityEntry>();
  private readonly byName = new Map<string, number[]>();
  private readonly byRef = new Map<number, IdentityEntry>();
  /**
   * Evidence pattern → record, for rows whose identifiers contradict each other.
   * The signature is the normalized name plus the row's sorted strong keys, so it
   * describes the *evidence*, never a position in the file.
   */
  private readonly bySignature = new Map<string, number>();
  private nextRef = 0;
  private conflictCount = 0;
  private readonly conflictSamples: ResolverKeyConflict[] = [];

  get size(): number {
    return this.nextRef;
  }

  refs(): number[] {
    return [...this.byRef.keys()];
  }

  entry(ref: number): IdentityEntry | undefined {
    return this.byRef.get(ref);
  }

  /** Diagnostics for the run counters and the association audit. */
  stats(): ResolverStats {
    return { entities: this.byRef.size, keys: this.index.size, conflicts: this.conflictCount, samples: [...this.conflictSamples] };
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
      return { ref, created: false, ambiguous: this.byRef.get(ref)?.ambiguous ?? false, identityClaimed: this.ownsIdentity(keys, ref) };
    }

    if (!keys.strong && matches.size === 0 && sameNameRefs.length === 1) {
      const candidate = this.byRef.get(sameNameRefs[0]);
      if (candidate && !candidate.strong) {
        this.register(keys, candidate.ref, false);
        return { ref: candidate.ref, created: false, ambiguous: candidate.ambiguous, identityClaimed: false };
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

    const signature = evidenceSignature(keys);
    const known = contradictory ? this.bySignature.get(signature) : undefined;
    if (known !== undefined) {
      const entry = this.byRef.get(known);
      for (const ref of sameNameRefs) {
        const other = this.byRef.get(ref);
        if (other) other.ambiguous = true;
      }
      if (entry) entry.ambiguous = true;
      this.register(keys, known, true);
      return { ref: known, created: false, ambiguous: true, identityClaimed: this.ownsIdentity(keys, known) };
    }

    const ref = this.nextRef;
    this.nextRef += 1;
    if (contradictory) this.bySignature.set(signature, ref);
    this.register(keys, ref, contradictory);
    return { ref, created: true, ambiguous: contradictory, identityClaimed: this.ownsIdentity(keys, ref) };
  }

  /**
   * True when the row's own strong identity is owned by `ref`.
   *
   * Only meaningful after the row has been registered: a key that was refused
   * (owned by another record) must never be reported as this record's evidence.
   */
  private ownsIdentity(keys: CompanyKeys, ref: number): boolean {
    return keys.all.some((key) => !key.startsWith("n:") && this.index.get(key)?.ref === ref);
  }

  private register(keys: CompanyKeys, ref: number, ambiguous: boolean): void {
    const existing = this.byRef.get(ref);
    const entry: IdentityEntry = existing ?? {
      ref,
      // Pending: `strong` is set below from what this record actually OWNS, not
      // from what the row carried. A row whose every identifier was already owned
      // elsewhere owns no identity, and a record with no identity must never be
      // treated as one (that is how a contradicting row used to look verified).
      strong: false,
      normalizedName: keys.normalizedName,
      ambiguous,
    };
    if (ambiguous) entry.ambiguous = true;
    this.byRef.set(ref, entry);
    for (const key of keys.all) this.claim(key, entry);
    if (this.ownsIdentity(keys, ref)) entry.strong = true;
    const list = this.byName.get(keys.normalizedName) ?? [];
    if (!list.includes(ref)) list.push(ref);
    this.byName.set(keys.normalizedName, list);
  }

  /**
   * Claim one identifier for `entry`, or record that someone else already owns it.
   *
   * The owner never changes. That is the whole fix: ownership is a fact about the
   * first record that carried the identifier, not about whichever row happened to
   * be read last.
   */
  private claim(key: string, entry: IdentityEntry): boolean {
    const owner = this.index.get(key);
    if (owner) {
      /*
       * Only a STRONG key refused for another record is a conflict.
       *
       * `n:<normalized name>` is shared by every company of that name on purpose —
       * that is what a name family is — so counting each later namesake's name key
       * as a refused claim would drown the signal in tens of thousands of entries
       * that mean nothing (`identifierConflicts` is the number an operator reads to
       * spot a domain changing hands). Ownership is still first-owner-wins for the
       * name key; it is simply not reported as a conflict.
       */
      if (owner.ref !== entry.ref && !key.startsWith("n:")) {
        this.conflictCount += 1;
        if (this.conflictSamples.length < RESOLVER_CONFLICT_SAMPLE_LIMIT) {
          this.conflictSamples.push({ key, ownerRef: owner.ref, claimantRef: entry.ref });
        }
      }
      return false;
    }
    this.index.set(key, entry);
    return true;
  }

  /** Ref that owns a given identifier, if any. */
  refFor(key: string): number | undefined {
    return this.index.get(key)?.ref;
  }

  /** Every refused claim so far (bounded sample plus the total). */
  conflicts(): ResolverStats {
    return this.stats();
  }
}

/** Evidence pattern of a row: its normalized name plus its sorted strong keys. */
function evidenceSignature(keys: CompanyKeys): string {
  const strong = keys.all.filter((key) => !key.startsWith("n:")).sort();
  return `${keys.normalizedName}\u0000${strong.join("\u0001")}`;
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
    attributes: params.input.attributes,
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
    attributes: params.input.attributes,
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
