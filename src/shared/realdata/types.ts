/**
 * REAL DATA provenance, coverage and direct-scan contracts.
 *
 * Shared by the Worker, the container scan command and the browser. Nothing here
 * knows how to read R2: it only names the objects and the shapes, so the API, the
 * scan job and the UI cannot drift apart.
 *
 * Two rules are encoded in these types rather than left to the UI:
 *
 *   1. coverage is always explicit. A response that came from an index says how
 *      many companies/contacts it holds and what fraction of the original source
 *      bytes produced them; a response from a direct scan says how many bytes that
 *      scan actually read. Neither can be mistaken for "the whole 64 GB".
 *   2. a scan result is never a "not found" verdict. `state` is only `complete`
 *      when the job's own bounded scope finished, and every payload carries the
 *      scanned byte counts so the browser can say "searched X MB — more may exist".
 */

/** Where a result came from. Every search response states one of these. */
export type RealDataOrigin = "cache" | "index" | "scan" | "sample";

/** Coverage record written next to a dataset version by the early-access build. */
export interface RealDataSourceCoverage {
  id: string;
  key: string;
  sizeBytes: number;
  bytesCovered: number;
  recordsRead: number;
  coveragePercent: number;
  method: string;
}

export interface RealDataCoverage {
  format: number;
  version: string;
  label: string;
  partial: boolean;
  dataOrigin: RealDataOrigin;
  generatedAt: string;
  sources: RealDataSourceCoverage[];
  totals: {
    sourceBytesCovered: number;
    sourceBytesTotal: number;
    coveragePercent: number;
  };
  /**
   * Searchable record counts. Filled by the Worker from the active manifest (the
   * coverage object is written before activation and must not be trusted as a
   * count source); kept optional so an older record stays readable.
   */
  companies?: number;
  contacts?: number;
  lastRefreshAt?: string;
  note?: string;
}

/** What `GET /api/realdata/coverage` returns. */
export interface RealDataCoverageResponse {
  /** Active dataset version, or null when nothing is activated. */
  version: string | null;
  dataOrigin: "r2" | "none";
  /** The human label the dashboard shows: REAL DATA — PARTIAL COVERAGE, etc. */
  label: string;
  partial: boolean;
  companies: number;
  contacts: number;
  coverage: RealDataCoverage | null;
  /** Direct-scan budget the deployment enforces, in MiB per source. */
  scanBudgetMb: number;
  /** True when the container binding exists, so a direct scan can be started. */
  scanAvailable: boolean;
  /** Whether a completed direct scan can answer for the uncovered tail. */
  directScan: boolean;
  checkedAt: string;
  message: string;
}

export type RealDataScanKind = "companies" | "contacts" | "both";

export type RealDataScanState = "queued" | "running" | "complete" | "cancelled" | "failed";

export interface RealDataScanSourceProgress {
  id: string;
  key: string;
  sizeBytes: number;
  bytesScanned: number;
  recordsRead: number;
  complete: boolean;
}

export interface RealDataScanStatus {
  format: number;
  jobId: string;
  query: string;
  normalizedQuery: string;
  kind: RealDataScanKind;
  state: RealDataScanState;
  startedAt: string;
  updatedAt: string;
  heartbeatAt?: string;
  /** Per-source scan progress; a job resumes from these offsets. */
  sources: RealDataScanSourceProgress[];
  totals: {
    bytesScanned: number;
    bytesTotal: number;
    coveragePercent: number;
    recordsScanned: number;
    companies: number;
    contacts: number;
    /** Results dropped because `limit` was reached (never silent). */
    dropped: number;
  };
  limit: number;
  /** MiB per source this job is allowed to read. */
  maxMbPerSource: number;
  datasetVersion: string;
  /** True only when every source reached its allowed bound (not the file end). */
  complete: boolean;
  reason?: string;
  error?: string;
  cacheKey?: string;
}

export interface ScannedCompany {
  id: string;
  name: string;
  normalizedName: string;
  domain?: string;
  website?: string;
  linkedinUrl?: string;
  industry?: string;
  companySize?: string;
  revenue?: string;
  country?: string;
  state?: string;
  city?: string;
  /** Contacts found in the same scanned window whose employer matches this name. */
  contacts: ScannedContact[];
  source: { id: string; row: number };
  attributes: Record<string, string>;
}

export interface ScannedContact {
  id: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  designation?: string;
  seniority?: string;
  department?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  additionalPhones?: string[];
  linkedinUrl?: string;
  companyName?: string;
  companyId?: string | null;
  country?: string;
  state?: string;
  city?: string;
  source: { id: string; row: number };
  attributes: Record<string, string>;
}

export interface RealDataScanResults {
  format: number;
  jobId: string;
  generatedAt: string;
  companies: ScannedCompany[];
  contacts: ScannedContact[];
  /** Some matches were not returned because the result limit was reached. */
  truncated: boolean;
}

/** `GET /api/realdata/scan/:id` — the polling payload. */
export interface RealDataScanResponse {
  jobId: string;
  status: RealDataScanStatus;
  results: RealDataScanResults | null;
  /** True when this payload came from the completed-scan cache. */
  cacheHit: boolean;
  datasetVersion: string;
  tookMs: number;
}

export interface RealDataScanStartRequest {
  q: string;
  kind?: RealDataScanKind;
  /** MiB per source, clamped to the deployment budget. */
  maxMb?: number;
  /** Return the cached/complete result instead of reusing a finished job. */
  force?: boolean;
}

export interface RealDataScanStartResponse {
  jobId: string;
  state: RealDataScanState;
  cacheHit: boolean;
  cached: RealDataScanResponse | null;
  message: string;
}

/** Cache entries are version-scoped; a new activation changes the key prefix. */
export interface RealDataScanCacheEntry {
  format: number;
  jobId: string;
  datasetVersion: string;
  query: string;
  normalizedQuery: string;
  kind: RealDataScanKind;
  createdAt: string;
  status: RealDataScanStatus;
  results: RealDataScanResults;
}

/* ------------------------------- limits ---------------------------------- */

export const REALDATA_LIMITS = {
  /** Longest query the API accepts. */
  maxQueryLength: 120,
  /** Result rows returned per kind by one scan. */
  defaultLimit: 50,
  maxLimit: 100,
  /** Default MiB per source; the deployment may lower (never raise) this. */
  defaultScanMb: 48,
  maxScanMb: 256,
  /** Polling: a job whose heartbeat is older than this is reported stale. */
  staleMs: 5 * 60 * 1000,
} as const;

/* --------------------------------- keys ---------------------------------- */

const JOB_ID = /^scan-[a-z0-9-]{6,64}$/;

export function isScanJobId(value: string): boolean {
  return JOB_ID.test(value);
}

export const realDataKeys = {
  coverage: (version: string) => `realdata/${version}/coverage.json`,
  scan: (jobId: string) => `realdata/scans/${jobId}`,
  scanRequest: (jobId: string) => `realdata/scans/${jobId}/request.json`,
  scanStatus: (jobId: string) => `realdata/scans/${jobId}/status.json`,
  scanResults: (jobId: string) => `realdata/scans/${jobId}/results.json`,
  scanCancel: (jobId: string) => `realdata/scans/${jobId}/cancel.json`,
  cache: (version: string, key: string) => `realdata/cache/${version}/${key}.json`,
  activeScan: (emailHash: string) => `realdata/scans/active/${emailHash}.json`,
} as const;

/** A cache key is a filename component: lowercase hex only. */
export function isCacheKey(value: string): boolean {
  return /^[a-f0-9]{16,64}$/.test(value);
}
