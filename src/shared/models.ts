/**
 * CompanyIntel — canonical data model.
 *
 * This module is the single source of truth for the shapes shared by the three
 * runtimes in the system:
 *
 *   - the React frontend  (`apps/web` equivalent: `src/`)
 *   - the Cloudflare Worker API (`worker/`)
 *   - the local streaming indexer (`tools/indexer/`)
 *
 * Nothing in here may import a database, an ORM or a Node-only module: the
 * Worker bundles this file, so it must stay runtime-neutral.
 */

import type { AssociationCategory, AssociationRecord } from "./association";

/** Where a record came from. Keeps every derived row traceable to its source. */
export interface SourceRef {
  /** Logical source id, e.g. `csv1` / `csv2` (never a local absolute path). */
  source: string;
  /** 1-based line number of the first line of the record in the source file. */
  row: number;
}

/** Lifecycle of a dataset version. Only `active` versions are ever served. */
export type DatasetState = "indexing" | "staging" | "validated" | "active" | "retired";

/**
 * A canonical company record.
 *
 * Identity is derived from strong signals only (domain, canonical LinkedIn URL,
 * source-provided id). Name similarity is used for *search*, never for merging.
 */
export interface Company {
  /** Stable internal id: `c_` + 16 hex chars of the identity hash. */
  id: string;
  /** Original company name exactly as it appeared in the source file. */
  name: string;
  /** Output of the versioned normalizer (`normalizeName`). */
  normalizedName: string;
  /** Additional normalized names (legal-suffix-stripped, abbreviation-expanded). */
  aliases?: string[];
  domain?: string;
  website?: string;
  linkedinUrl?: string;
  industry?: string;
  subIndustry?: string;
  country?: string;
  state?: string;
  city?: string;
  companySize?: string;
  revenue?: string;
  /** Verified number of contact rows associated with this company. */
  contactCount: number;
  /** Which source files contributed rows to this company. */
  sources: SourceRef[];
  /** True when identity evidence was ambiguous and the record was kept separate. */
  ambiguous?: boolean;
  /**
   * How this company's attached contacts split by association category.
   *
   * Written by the indexer after Stage B decided every contact, so a company
   * profile can say "412 contacts, 380 with verified evidence" without reading a
   * single contact row. Absent on format-v2 indexes, which predate the split.
   */
  associations?: AssociationCounts;
  /**
   * Pre-computed contact attribute counts, written by the indexer.
   * Lets the company detail page build its filter sidebar from one stored
   * object instead of reading every contact row for the company.
   */
  facets?: CompanyFacets;
}

/** Attached-contact split by association category (see `association.ts`). */
export interface AssociationCounts {
  highConfidence: number;
  plausible: number;
  conflicting: number;
  /** Attached contacts in total (`highConfidence + plausible + conflicting`). */
  total: number;
}

export interface CompanyFacets {
  designations: FacetBucket[];
  departments: FacetBucket[];
  seniority: FacetBucket[];
  countries: FacetBucket[];
  cities: FacetBucket[];
  emailAvailable: number;
  linkedinAvailable: number;
}

/** A canonical contact (person) record, always attached to one company. */
export interface Contact {
  /** Stable internal id: `p_` + 16 hex chars. */
  id: string;
  companyId: string;
  fullName: string;
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
  source: SourceRef;
  /**
   * Why this contact is attached to `companyId`, with the evidence behind it.
   *
   * Absent on format-v2 indexes (built before Stage B existed); the interface
   * treats a missing category as "not classified" rather than as verified.
   */
  association?: AssociationRecord;
}

/**
 * A contact whose employer could not be resolved, preserved under the name it
 * claimed (Section 6: contacts must not disappear because they are uncertain).
 *
 * `companyId` is the empty string and the contact is not attached to any
 * company record: it is reachable through the company profile whose name it
 * claimed, and through the association audit.
 */
export interface UnassignedContact extends Contact {
  /** Company name exactly as the source row carried it. */
  claimedCompanyName: string;
  /** Normalized form of that name — the key the review endpoint looks up. */
  claimedNormalizedName: string;
  association: AssociationRecord;
}

/** Contact fields that can be filtered server-side (must match index metadata). */
export interface ContactFilters {
  designation?: string;
  department?: string;
  seniority?: string;
  country?: string;
  city?: string;
  hasEmail?: boolean;
  hasLinkedin?: boolean;
  /** Association categories to include; empty/absent means every category. */
  association?: AssociationCategory[];
}

/** Company search filters (applied on indexed attributes only). */
export interface CompanyFilters {
  industry?: string;
  country?: string;
  city?: string;
  companySize?: string;
  hasContacts?: boolean;
  hasDomain?: boolean;
}

export type CompanySortField = "relevance" | "name" | "contactCount";
export type ContactSortField = "name" | "title" | "country";
export type SortOrder = "asc" | "desc";

/**
 * Classification of how a company matched the query. The UI shows this so a
 * user can tell a verified spelling-corrected hit from a loose suggestion.
 */
export type MatchCategory = "exact" | "alias" | "prefix" | "typo" | "similar";

/** One ranked company search hit. */
export interface CompanySearchHit {
  id: string;
  name: string;
  matchCategory: MatchCategory;
  /** Deterministic 0..1 relevance score. See `search/score.ts`. */
  relevance: number;
  /** True when confidence is low enough that the UI must hedge ("possible match"). */
  possibleMatch: boolean;
  /** Query tokens that actually contributed to the match (for highlighting). */
  matchedTerms: string[];
  domain?: string;
  website?: string;
  linkedinUrl?: string;
  industry?: string;
  country?: string;
  state?: string;
  city?: string;
  companySize?: string;
  revenue?: string;
  contactCount: number;
  /** True when strong identity evidence merged rows from more than one file. */
  multiSource: boolean;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  /** Total hits considered when known; `null` when the engine only counts a budget. */
  total: number | null;
  totalIsLowerBound: boolean;
  hasMore: boolean;
}

export interface CompanySearchResponse {
  query: string;
  /** Normalized form of the query actually used for retrieval. */
  normalizedQuery: string;
  /** Spelling-corrected query when the raw query produced no strong hits. */
  correctedQuery: string | null;
  /** Human message such as `Showing similar results for "Microsft"`. */
  notice: string | null;
  hits: CompanySearchHit[];
  page: PageInfo;
  datasetVersion: string;
  tookMs: number;
  /**
   * Which retrieval stages produced candidates, and what the search budget did —
   * useful for debugging relevance and for reasoning about R2 cost.
   */
  retrieval: {
    exact: number;
    prefix: number;
    token: number;
    trigram: number;
    scored: number;
    cached: boolean;
    /** Unique candidates the four stages produced, before the CPU budget. */
    candidates: number;
    /** Candidates dropped by the CPU (`resultBudget`) cut. */
    truncated: number;
    /** Hydration sweeps run (1, plus one per adaptive retry). */
    hydrationPasses: number;
    /** Partition budget the final sweep used. */
    hydrateBudget: number;
    /** True when a partition cap dropped a candidate the index actually holds. */
    budgetLimited: boolean;
    /** True when the token/trigram stages were skipped (whole-name evidence sufficed). */
    fuzzyDeferred: boolean;
    /** True when those deferred stages had to run after all. */
    fuzzyRecovered: boolean;
    /**
     * R2 object accounting for this search. Present only when the caller's
     * data layer reports it (the Worker does; the in-browser preview does not).
     */
    r2?: {
      /** Objects fetched from R2 while answering this search. */
      objectsRead: number;
      /** Object bytes transferred (the stored, still-compressed size). */
      bytesRead: number;
      /** Index shard objects fetched from R2 (the directory is not counted). */
      shardGets: number;
      /** Company profile partitions fetched from R2. */
      partitionGets: number;
      /** Shard objects the search asked for, cache-served or fetched. */
      shardRequests: number;
      /** Company partitions the search asked for, cache-served or fetched. */
      partitionRequests: number;
      /** Reads served from the per-isolate cache instead of R2. */
      cacheHits: number;
      /** Reads that had to go to R2 (the cache's misses). */
      cacheMisses: number;
    };
  };
}

export interface CompanyDetailResponse {
  company: Company;
  /** Contact attribute facets + counts, used to build the filter sidebar. */
  facets: {
    designations: FacetBucket[];
    departments: FacetBucket[];
    seniority: FacetBucket[];
    countries: FacetBucket[];
    cities: FacetBucket[];
    emailAvailable: number;
    linkedinAvailable: number;
  };
  datasetVersion: string;
}

export interface FacetBucket {
  value: string;
  count: number;
}

export interface ContactPageResponse {
  companyId: string | null;
  contacts: Contact[];
  page: PageInfo;
  datasetVersion: string;
  /**
   * Attached-contact split by category, when the dataset records it. Lets the
   * page say "of 412 contacts, 380 have verified evidence" next to the list.
   */
  associations?: AssociationCounts | null;
}

/**
 * Contacts preserved without an employer, looked up by the name they claimed.
 *
 * `candidateCompanyIds` on each contact lists the companies that remained
 * possible, so a reviewer can follow the ambiguity instead of guessing.
 */
export interface UnassignedContactsResponse {
  companyId: string;
  companyName: string | null;
  contacts: UnassignedContact[];
  page: PageInfo;
  datasetVersion: string;
  /** Counts across the whole name family, not just this page. */
  totals: { unresolved: number; conflicting: number };
}

export interface ContactDetailResponse {
  contact: Contact;
  company: Company | null;
  datasetVersion: string;
}

/* -------------------------------------------------------------------------- */
/* Dataset metadata                                                           */
/* -------------------------------------------------------------------------- */

export interface SourceFileStatus {
  /** Logical id used in manifests, e.g. `csv1`. */
  id: string;
  /** Object key inside the R2 bucket, e.g. `raw/file1.csv`. */
  key: string;
  /** What the object holds, when that is known: `organizations` or `people`. */
  role?: "organizations" | "people";
  /** Bytes reported by R2, or null when the object could not be read. */
  sizeBytes: number | null;
  lastModified: string | null;
  /** True only when the object was actually verified to exist in R2. */
  verified: boolean;
  error?: string;
}

/**
 * One object under `raw/`, read with a bounded LIST.
 *
 * Only the Dataset Management page requests this: the search path never lists
 * the bucket, and the exact CSV object names are chosen by whoever uploaded
 * them, so they cannot be derived from a configuration file.
 */
export interface RawObjectInfo {
  key: string;
  sizeBytes: number | null;
  lastModified: string | null;
}

export interface DatasetSourcesResponse {
  bucket: string;
  objects: RawObjectInfo[];
  /** True when more objects exist under `raw/` than were returned. */
  truncated: boolean;
  checkedAt: string;
  /** Set when the listing itself failed (bucket unreachable, no binding). */
  error?: string;
}

export interface IndexingCounters {
  rowsRead: number;
  rowsRejected: number;
  uniqueCompanies: number;
  uniqueContacts: number;
  duplicateRowsResolved: number;
  duplicateCompaniesResolved: number;
  ambiguousCompanies: number;
  recordsMissingCompanyId: number;
  /** Contacts attached to a company with independent evidence. */
  contactsHighConfidence?: number;
  /** Contacts attached to a company on evidence that favours but does not verify it. */
  contactsPlausible?: number;
  /** Contacts attached to the company they claimed, with contradicting evidence. */
  contactsConflicting?: number;
  /** Contacts preserved without an employer (`unassigned/…` objects). */
  contactsUnresolved?: number;
  /** Contacts attached to a different company of the same name than they claimed. */
  contactsMoved?: number;
  /** Identifier keys a later row tried to claim while another company owned them. */
  identifierConflicts?: number;
  /** `unassigned/…` objects written (0 when every contact was resolvable). */
  unassignedObjects?: number;
  /** Per-source breakdown, keyed by source id (`csv1`, `csv2`). */
  perSource: Record<string, { rowsRead: number; rowsRejected: number; companies: number; contacts: number }>;
}

export type IndexingStage =
  | "idle"
  | "profiling"
  | "pass1-partition"
  | "pass2-merge"
  | "indexing"
  | "validating"
  | "uploading"
  | "completed"
  | "failed";

export interface DatasetVersionSummary {
  version: string;
  state: DatasetState;
  createdAt: string;
  completedAt?: string;
  normalizerVersion: number;
  indexFormatVersion: number;
  counters: IndexingCounters;
  /** Total size of every generated object in this version. */
  bytes: number;
  objectCount: number;
  validationPassed: boolean;
  notes?: string;
}

export interface DatasetStatusResponse {
  /** `true` only when an active, validated version exists in R2. */
  indexed: boolean;
  activeVersion: string | null;
  previousVersion: string | null;
  /** Status text shown on the dashboard when no dataset is active. */
  message: string;
  bucket: string;
  bucketOk: boolean;
  bucketError?: string;
  sources: SourceFileStatus[];
  versions: DatasetVersionSummary[];
  lastIndexedAt: string | null;
  indexing: IndexingProgress | null;
  /** Never fabricated: `sample` is used by the local preview adapter only. */
  dataOrigin: "r2" | "sample";
}

/**
 * Aggregate dataset statistics.
 *
 * Computed once by the local indexer (never at request time) and stored as one
 * small object per dataset version. This is what the dashboard charts read, so
 * no chart ever needs to aggregate millions of rows in a Worker.
 */
export interface DatasetStats {
  version: string;
  generatedAt: string;
  companies: number;
  contacts: number;
  companiesByIndustry: FacetBucket[];
  companiesByCountry: FacetBucket[];
  companiesBySize: FacetBucket[];
  contactsByDesignation: FacetBucket[];
  contactsByDepartment: FacetBucket[];
  contactsBySeniority: FacetBucket[];
  /** Contact coverage across the whole dataset. */
  contactCoverage: { email: number; linkedin: number; phone: number; neither: number };
}

export interface IndexingProgress {
  version: string;
  stage: IndexingStage;
  startedAt: string;
  updatedAt: string;
  /** 0..1, or null when the stage has no measurable total. */
  progress: number | null;
  rowsRead: number;
  rowsPerSecond: number | null;
  etaSeconds: number | null;
  message: string;
  host: string;
}

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  count?: number;
}

export interface DatasetValidationResponse {
  version: string;
  passed: boolean;
  checkedAt: string;
  issues: ValidationIssue[];
  /** Object keys that were verified (existence + size + checksum where known). */
  verifiedObjects: number;
  missingObjects: string[];
}

/* -------------------------------------------------------------------------- */
/* Application data (persisted in R2 under `app-data/`)                       */
/* -------------------------------------------------------------------------- */

export type LeadStatus =
  | "new"
  | "researching"
  | "contacted"
  | "follow-up"
  | "qualified"
  | "not-interested";

export const LEAD_STATUSES: LeadStatus[] = [
  "new",
  "researching",
  "contacted",
  "follow-up",
  "qualified",
  "not-interested",
];

export interface LeadNote {
  at: string;
  text: string;
}

export interface SavedCompanyLead {
  id: string;
  kind: "company";
  companyId: string;
  /** Snapshot for offline display; never authoritative for search. */
  name: string;
  industry?: string;
  country?: string;
  contactCount: number;
  status: LeadStatus;
  tags: string[];
  notes: LeadNote[];
  savedAt: string;
  updatedAt: string;
  datasetVersion: string;
}

export interface SavedContactLead {
  id: string;
  kind: "contact";
  contactId: string;
  companyId: string;
  companyName: string;
  fullName: string;
  title?: string;
  email?: string;
  linkedinUrl?: string;
  status: LeadStatus;
  tags: string[];
  notes: LeadNote[];
  savedAt: string;
  updatedAt: string;
  datasetVersion: string;
}

export type SavedLead = SavedCompanyLead | SavedContactLead;

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters: CompanyFilters;
  sort: CompanySortField;
  order: SortOrder;
  createdAt: string;
  lastRunAt: string | null;
  runCount: number;
}

export interface UserSettings {
  theme: "light" | "dark" | "system";
  pageSize: number;
  fuzzySearch: boolean;
  defaultSort: CompanySortField;
  defaultOrder: SortOrder;
  resultBudget: number;
  cacheEnabled: boolean;
  cacheMaxEntries: number;
  cacheTtlMinutes: number;
  edgeCacheEnabled: boolean;
  retainContactFieldsInCache: boolean;
  updatedAt: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "system",
  pageSize: 25,
  fuzzySearch: true,
  defaultSort: "relevance",
  defaultOrder: "desc",
  resultBudget: 800,
  cacheEnabled: true,
  cacheMaxEntries: 300,
  cacheTtlMinutes: 30,
  edgeCacheEnabled: false,
  retainContactFieldsInCache: false,
  updatedAt: new Date(0).toISOString(),
};

export interface ExportRequest {
  kind: "contacts" | "companies" | "leads";
  companyId?: string;
  contactIds?: string[];
  companyIds?: string[];
  leadIds?: string[];
  /** Column ids; validated against the fields that actually exist in the index. */
  columns: string[];
  /** Only fields present in the source data may be exported. */
  filters?: ContactFilters;
}

export interface ExportJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  rowCount: number;
  bytes: number;
  /** R2 object key of the finished CSV (in `app-data/exports/`). */
  objectKey?: string;
  downloadUrl?: string;
  filename: string;
  error?: string;
  truncated: boolean;
}

/** Activity feed entries. Written rarely, never per keystroke. */
export interface ActivityEntry {
  id: string;
  at: string;
  kind: "search" | "company-view" | "lead-saved" | "export" | "dataset";
  label: string;
  detail?: string;
  href?: string;
}
