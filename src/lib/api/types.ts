import type {
  ActivityEntry,
  CompanyDetailResponse,
  DatasetStats,
  CompanyFilters,
  CompanySearchResponse,
  CompanySortField,
  Contact,
  ContactFilters,
  ContactPageResponse,
  ContactSortField,
  DatasetSourcesResponse,
  DatasetStatusResponse,
  DatasetValidationResponse,
  ExportJob,
  LeadStatus,
  SavedLead,
  SavedSearch,
  SortOrder,
  UserSettings,
} from "@/shared/models";
import type { ExportRequestBody, SaveLeadRequest, SavedSearchRequest, SettingsRequest } from "@/shared/api-contract";

export interface CompanySearchParams {
  query: string;
  page?: number;
  pageSize?: number;
  sort?: CompanySortField;
  order?: SortOrder;
  fuzzy?: boolean;
  resultBudget?: number;
  filters?: CompanyFilters;
}

export interface ContactQueryParams {
  companyId?: string | null;
  companyIds?: string[];
  page?: number;
  pageSize?: number;
  sort?: ContactSortField;
  order?: SortOrder;
  filters?: ContactFilters;
}

export interface SaveLeadInput {
  kind: "company" | "contact";
  targetId: string;
  snapshot?: Record<string, string | number | null>;
  status?: LeadStatus;
  tags?: string[];
  datasetVersion: string;
}

export interface UpdateLeadInput {
  status?: LeadStatus;
  tags?: string[];
  addNote?: string;
  removeNoteAt?: string;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  mode: "local" | "worker";
  version: string;
  datasetVersion: string | null;
  time: string;
}

export interface LeadListResponse {
  leads: SavedLead[];
  total: number;
}

/**
 * The single interface every screen talks to.
 *
 * `WorkerApiClient` implements it against the Cloudflare Worker (production),
 * `LocalApiClient` implements it against a deterministic synthetic sample
 * dataset (clearly labelled preview only). The UI never branches on the mode
 * except to show the "sample data" banner.
 */
export interface ApiClient {
  readonly mode: "local" | "worker";

  health(): Promise<HealthResponse>;
  datasetStatus(): Promise<DatasetStatusResponse>;
  /** Bounded listing of the original files under `raw/` (Dataset page only). */
  datasetSources(): Promise<DatasetSourcesResponse>;
  /** Pre-computed dataset statistics, or null when none have been generated. */
  datasetStats(): Promise<DatasetStats | null>;
  validateDataset(version: string): Promise<DatasetValidationResponse>;
  activateDataset(version: string): Promise<{ activated: boolean; activeVersion: string }>;

  searchCompanies(params: CompanySearchParams): Promise<CompanySearchResponse>;
  getCompany(id: string): Promise<CompanyDetailResponse>;
  getCompanyContacts(companyId: string, params?: ContactQueryParams): Promise<ContactPageResponse>;
  listContacts(params?: ContactQueryParams): Promise<ContactPageResponse>;
  getContact(id: string): Promise<{ contact: Contact; companyName: string | null; companyId: string | null }>;

  listLeads(): Promise<LeadListResponse>;
  saveLead(input: SaveLeadInput): Promise<SavedLead>;
  updateLead(id: string, input: UpdateLeadInput): Promise<SavedLead>;
  deleteLead(id: string): Promise<void>;

  listSavedSearches(): Promise<SavedSearch[]>;
  createSavedSearch(input: SavedSearchRequest): Promise<SavedSearch>;
  deleteSavedSearch(id: string): Promise<void>;
  markSavedSearchRun(id: string): Promise<SavedSearch>;

  getSettings(): Promise<UserSettings>;
  updateSettings(input: SettingsRequest): Promise<UserSettings>;

  listActivity(): Promise<ActivityEntry[]>;
  recordActivity(entry: Omit<ActivityEntry, "id" | "at">): Promise<void>;

  listExports(): Promise<ExportJob[]>;
  createExport(body: ExportRequestBody): Promise<ExportJob>;
  getExport(id: string): Promise<ExportJob>;
  downloadExport(id: string): Promise<{ filename: string; csv: string; truncated: boolean; rowCount: number }>;
}

/**
 * Every `ApiClient` method, as a runtime list.
 *
 * Types vanish at runtime, so the adapters, the caching wrapper and the tests are
 * checked against this list instead of against the interface. The compile-time
 * proof below makes the list fail to typecheck the moment the interface gains or
 * loses a method, which is what turns "a page calls a method nobody implements"
 * from a runtime `is not a function` crash into a build error.
 */
export const API_CLIENT_METHODS = [
  "health",
  "datasetStatus",
  "datasetSources",
  "datasetStats",
  "validateDataset",
  "activateDataset",
  "searchCompanies",
  "getCompany",
  "getCompanyContacts",
  "listContacts",
  "getContact",
  "listLeads",
  "saveLead",
  "updateLead",
  "deleteLead",
  "listSavedSearches",
  "createSavedSearch",
  "deleteSavedSearch",
  "markSavedSearchRun",
  "getSettings",
  "updateSettings",
  "listActivity",
  "recordActivity",
  "listExports",
  "createExport",
  "getExport",
  "downloadExport",
] as const;

/** Method-valued keys of `ApiClient` (everything except `mode`). */
type ApiClientMethod = {
  [K in keyof ApiClient]: ApiClient[K] extends (...args: never[]) => unknown ? K : never;
}[keyof ApiClient];

type MissingApiMethods = Exclude<ApiClientMethod, (typeof API_CLIENT_METHODS)[number]>;
type ExtraApiMethods = Exclude<(typeof API_CLIENT_METHODS)[number], ApiClientMethod>;

/**
 * `true` only while the list above matches the interface exactly. If this stops
 * compiling, read the reported `missing`/`extra` names and fix the list.
 */
export type ApiClientMethodsExhaustive =
  [MissingApiMethods, ExtraApiMethods] extends [never, never]
    ? true
    : { missing: MissingApiMethods; extra: ExtraApiMethods };

export const API_CLIENT_METHODS_ARE_EXHAUSTIVE: ApiClientMethodsExhaustive = true;

/* ----------------------------- application modes -------------------------- */

/**
 * The three states the application can legitimately be in.
 *
 *  - `demo`       — the bundled synthetic dataset is serving the interface. It is
 *                   never presented as your data, and no R2 read is claimed.
 *  - `real`       — the deployed Worker is serving a **published** index version.
 *  - `no-dataset` — no active manifest (a Worker that can reach R2 but has nothing
 *                   published is this state, not `real`). Screens say so plainly
 *                   instead of showing invented numbers or synthetic rows.
 *
 * The mode is derived from a published manifest, never from the presence of R2
 * credentials or a reachable bucket: `bucketOk` alone does not make data real.
 */
export type DatasetMode = "demo" | "real" | "no-dataset";

export interface DatasetModeInfo {
  mode: DatasetMode;
  /** Short label for pills and footers. */
  label: string;
  /** One sentence describing what is actually being served. */
  description: string;
  /** True when rows on screen come from the bundled synthetic dataset. */
  synthetic: boolean;
}

type StatusLike =
  | Pick<DatasetStatusResponse, "indexed" | "activeVersion" | "dataOrigin">
  | null
  | undefined;

/** Derive the mode from a dataset status. Pure, so it is directly testable. */
export function datasetModeOf(status: StatusLike): DatasetMode {
  if (!status) return "no-dataset";
  if (status.dataOrigin === "sample") return "demo";
  return status.indexed && status.activeVersion ? "real" : "no-dataset";
}

/** Label + explanation for a status, used by every banner and status pill. */
export function datasetModeInfo(status: StatusLike): DatasetModeInfo {
  const mode = datasetModeOf(status);
  if (mode === "demo") {
    return {
      mode,
      label: "Demo data",
      description:
        "This preview is serving the bundled synthetic dataset. Nothing here is read from your Cloudflare R2 bucket.",
      synthetic: true,
    };
  }
  if (mode === "real") {
    return {
      mode,
      label: `Live dataset ${status?.activeVersion}`,
      description: `Search results come from the published index version ${status?.activeVersion} in company-intel-data.`,
      synthetic: false,
    };
  }
  return {
    mode,
    label: "No dataset indexed",
    description:
      "No validated index version has been published to R2, so there are no real records to search yet. " +
      "Index locally, then publish a version.",
    synthetic: false,
  };
}

/** Runtime names of every method on a client-like object (prototype chain included). */
export function apiClientMethodNames(value: object): string[] {
  const names = new Set<string>();
  for (
    let current: object | null = value;
    current && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === "constructor") continue;
      if (typeof (value as unknown as Record<string, unknown>)[key] === "function") names.add(key);
    }
  }
  return [...names];
}

/** Columns that exist in the indexed dataset; drives the export column picker. */
export const CONTACT_EXPORT_FIELDS = [
  "fullName",
  "title",
  "designation",
  "seniority",
  "department",
  "email",
  "phone",
  "linkedinUrl",
  "companyName",
  "country",
  "city",
  "sourceFile",
] as const;

export const COMPANY_EXPORT_FIELDS = [
  "name",
  "domain",
  "website",
  "industry",
  "country",
  "city",
  "companySize",
  "contactCount",
] as const;
