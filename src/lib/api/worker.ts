/**
 * Cloudflare Worker API adapter — production data path.
 *
 * Talks to the Hono API in `worker/src/index.ts` over same-origin fetch. Every
 * response is validated with the shared Zod schemas, so a Worker change that
 * breaks the contract fails loudly here instead of rendering broken UI.
 *
 * Authentication is handled by Cloudflare Access in front of the Worker: the
 * browser sends its Access cookie automatically (`credentials: "include"`), and
 * the Worker verifies the signed JWT server-side. The frontend never receives,
 * stores or forwards a token itself.
 */

import { z } from "zod";
import {
  activityEntrySchema,
  companyDetailResponseSchema,
  companySearchResponseSchema,
  contactDetailResponseSchema,
  contactPageResponseSchema,
  datasetSourcesResponseSchema,
  datasetStatusResponseSchema,
  datasetValidationResponseSchema,
  exportJobSchema,
  savedLeadSchema,
  savedSearchSchema,
  userSettingsSchema,
} from "@/shared/api-contract";
import { filtersToQuery } from "@/shared/api-contract";
import type { ActivityEntry, Contact, DatasetStats, ExportJob, SavedLead, SavedSearch, UserSettings } from "@/shared/models";
import type { ExportRequestBody, SavedSearchRequest, SettingsRequest } from "@/shared/api-contract";
import type {
  ApiClient,
  CompanySearchParams,
  ContactQueryParams,
  HealthResponse,
  LeadListResponse,
  SaveLeadInput,
  UpdateLeadInput,
} from "./types";
import { cacheMetrics } from "@/lib/cache/persistent-cache";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const facetBucketSchema = z.object({ value: z.string(), count: z.number().int() });

export const datasetStatsSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  companies: z.number().int(),
  contacts: z.number().int(),
  companiesByIndustry: z.array(facetBucketSchema),
  companiesByCountry: z.array(facetBucketSchema),
  companiesBySize: z.array(facetBucketSchema),
  contactsByDesignation: z.array(facetBucketSchema),
  contactsByDepartment: z.array(facetBucketSchema),
  contactsBySeniority: z.array(facetBucketSchema),
  contactCoverage: z.object({
    email: z.number().int(),
    linkedin: z.number().int(),
    phone: z.number().int(),
    neither: z.number().int(),
  }),
});

const healthSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  mode: z.literal("worker"),
  version: z.string(),
  datasetVersion: z.string().nullable(),
  time: z.string(),
});

export class WorkerApiClient implements ApiClient {
  readonly mode = "worker" as const;
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private url(path: string, query?: Record<string, unknown>): string {
    const base = this.baseUrl.replace(/\/$/, "");
    const search = filtersToQuery(query);
    return `${base}${path}${search ? `?${search}` : ""}`;
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit & { query?: Record<string, unknown> }): Promise<T> {
    const response = await fetch(this.url(path, init?.query), {
      ...init,
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      let code = "internal";
      let message = `Request failed with status ${response.status}`;
      let requestId: string | undefined;
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string; requestId?: string } };
        if (body?.error) {
          code = body.error.code ?? code;
          message = body.error.message ?? message;
          requestId = body.error.requestId;
        }
      } catch {
        // Non-JSON error body (e.g. an Access HTML block page).
      }
      if (response.status === 401 || response.status === 403) {
        message = `${message} — this application is protected by Cloudflare Access. Sign in with the approved identity and try again.`;
      }
      throw new ApiRequestError(response.status, code, message, requestId);
    }

    const payload = await response.json();
    return schema.parse(payload);
  }

  health(): Promise<HealthResponse> {
    return this.request("/api/health", healthSchema);
  }

  datasetStatus() {
    return this.request("/api/dataset/status", datasetStatusResponseSchema);
  }

  datasetSources() {
    return this.request("/api/dataset/sources", datasetSourcesResponseSchema);
  }

  /**
   * Statistics are optional: a dataset version may exist without them (an older
   * index, or one still being generated), which is a normal empty state for the
   * dashboard rather than an error.
   */
  async datasetStats(): Promise<DatasetStats | null> {
    try {
      return await this.request("/api/dataset/stats", datasetStatsSchema);
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 503)) return null;
      throw error;
    }
  }

  validateDataset(version: string) {
    return this.request("/api/dataset/validate", datasetValidationResponseSchema, {
      method: "POST",
      body: JSON.stringify({ version }),
    });
  }

  activateDataset(version: string) {
    return this.request(
      "/api/dataset/activate",
      z.object({ activated: z.boolean(), activeVersion: z.string() }),
      { method: "POST", body: JSON.stringify({ version, confirm: true }) },
    );
  }

  searchCompanies(params: CompanySearchParams) {
    return this.request("/api/companies/search", companySearchResponseSchema, {
      query: {
        q: params.query,
        page: params.page,
        pageSize: params.pageSize,
        sort: params.sort,
        order: params.order,
        fuzzy: params.fuzzy,
        resultBudget: params.resultBudget,
        ...(params.filters ?? {}),
      },
    });
  }

  getCompany(id: string) {
    return this.request(`/api/companies/${encodeURIComponent(id)}`, companyDetailResponseSchema);
  }

  getCompanyContacts(companyId: string, params: ContactQueryParams = {}) {
    return this.request(`/api/companies/${encodeURIComponent(companyId)}/contacts`, contactPageResponseSchema, {
      query: {
        page: params.page,
        pageSize: params.pageSize,
        sort: params.sort,
        order: params.order,
        ...(params.filters ?? {}),
      },
    });
  }

  listContacts(params: ContactQueryParams = {}) {
    return this.request("/api/contacts", contactPageResponseSchema, {
      query: {
        page: params.page,
        pageSize: params.pageSize,
        sort: params.sort,
        order: params.order,
        companyIds: params.companyIds?.join(","),
        ...(params.filters ?? {}),
      },
    });
  }

  async getContact(id: string): Promise<{ contact: Contact; companyName: string | null; companyId: string | null }> {
    const parsed = await this.request(`/api/contacts/${encodeURIComponent(id)}`, contactDetailResponseSchema);
    return { contact: parsed.contact, companyName: parsed.company?.name ?? null, companyId: parsed.company?.id ?? null };
  }

  listLeads(): Promise<LeadListResponse> {
    return this.request("/api/leads", z.object({ leads: z.array(savedLeadSchema), total: z.number() }));
  }

  saveLead(input: SaveLeadInput): Promise<SavedLead> {
    return this.request("/api/leads", savedLeadSchema, {
      method: "POST",
      body: JSON.stringify({
        kind: input.kind,
        targetId: input.targetId,
        snapshot: input.snapshot,
        status: input.status ?? "new",
        tags: input.tags ?? [],
        datasetVersion: input.datasetVersion,
      }),
    });
  }

  updateLead(id: string, input: UpdateLeadInput): Promise<SavedLead> {
    return this.request(`/api/leads/${encodeURIComponent(id)}`, savedLeadSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async deleteLead(id: string): Promise<void> {
    await this.request(`/api/leads/${encodeURIComponent(id)}`, z.object({ deleted: z.boolean() }), { method: "DELETE" });
  }

  async listSavedSearches(): Promise<SavedSearch[]> {
    return this.request("/api/saved-searches", z.array(savedSearchSchema));
  }

  createSavedSearch(input: SavedSearchRequest): Promise<SavedSearch> {
    return this.request("/api/saved-searches", savedSearchSchema, { method: "POST", body: JSON.stringify(input) });
  }

  async deleteSavedSearch(id: string): Promise<void> {
    await this.request(`/api/saved-searches/${encodeURIComponent(id)}`, z.object({ deleted: z.boolean() }), { method: "DELETE" });
  }

  markSavedSearchRun(id: string): Promise<SavedSearch> {
    return this.request(`/api/saved-searches/${encodeURIComponent(id)}/run`, savedSearchSchema, { method: "POST" });
  }

  getSettings(): Promise<UserSettings> {
    return this.request("/api/settings", userSettingsSchema);
  }

  updateSettings(input: SettingsRequest): Promise<UserSettings> {
    return this.request("/api/settings", userSettingsSchema, { method: "PUT", body: JSON.stringify(input) });
  }

  async listActivity(): Promise<ActivityEntry[]> {
    return this.request("/api/activity", z.array(activityEntrySchema));
  }

  async recordActivity(entry: Omit<ActivityEntry, "id" | "at">): Promise<void> {
    await this.request("/api/activity", z.object({ recorded: z.boolean() }), {
      method: "POST",
      body: JSON.stringify(entry),
    });
  }

  async listExports(): Promise<ExportJob[]> {
    return this.request("/api/exports", z.array(exportJobSchema));
  }

  createExport(body: ExportRequestBody): Promise<ExportJob> {
    return this.request("/api/exports", exportJobSchema, { method: "POST", body: JSON.stringify(body) });
  }

  getExport(id: string): Promise<ExportJob> {
    return this.request(`/api/exports/${encodeURIComponent(id)}`, exportJobSchema);
  }

  async downloadExport(id: string): Promise<{ filename: string; csv: string; truncated: boolean; rowCount: number }> {
    const response = await fetch(this.url(`/api/exports/${encodeURIComponent(id)}/download`), { credentials: "include" });
    if (!response.ok) {
      throw new ApiRequestError(response.status, "internal", `Export download failed (${response.status})`);
    }
    const csv = await response.text();
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="?([^";]+)"?/);
    const job = await this.getExport(id);
    return {
      filename: match?.[1] ?? job.filename,
      csv,
      truncated: job.truncated,
      rowCount: job.rowCount,
    };
  }
}

export function noteCacheHit(): void {
  cacheMetrics.hits += 1;
}
