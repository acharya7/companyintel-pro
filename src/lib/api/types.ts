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
