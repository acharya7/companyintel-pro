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
   * Pre-computed contact attribute counts, written by the indexer.
   * Lets the company detail page build its filter sidebar from one stored
   * object instead of reading every contact row for the company.
   */
  facets?: CompanyFacets;
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
  /** Which retrieval stages produced candidates — useful for debugging relevance. */
  retrieval: {
    exact: number;
    prefix: number;
    token: number;
    trigram: number;
    scored: number;
    cached: boolean;
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
  /** Object key inside the R2 bucket, e.g. `raw/companies_part1.csv`. */
  key: string;
  /** Bytes reported by R2, or null when the object could not be read. */
  sizeBytes: number | null;
  lastModified: string | null;
  /** True only when the object was actually verified to exist in R2. */
  verified: boolean;
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
