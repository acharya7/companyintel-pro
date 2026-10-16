/**
 * API access for the React app.
 *
 * Cache layer 1 lives here: TanStack Query holds in-memory results, dedupes
 * concurrent requests for the same key, and keeps stale data visible while a
 * page changes (no layout flicker while paginating). Persistent caching
 * (layer 2) already happened inside the API client before the query ran.
 */

import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import { createApiClient, apiMode, apiBaseUrl, configurePersistentCache, persistentCache, invalidateCacheForVersion } from "@/lib/api/client";
import { datasetModeInfo } from "@/lib/api/types";
import type { CompanyFilters, ContactFilters, CompanySortField, ContactSortField, LeadStatus, SortOrder } from "@/shared/models";
import type { ExportRequestBody, SavedSearchRequest, SettingsRequest } from "@/shared/api-contract";

export const api = createApiClient();
export { apiMode, apiBaseUrl, persistentCache, invalidateCacheForVersion };

export const queryKeys = {
  health: ["health"] as const,
  datasetStatus: ["dataset", "status"] as const,
  datasetSources: ["dataset", "sources"] as const,
  datasetStats: ["dataset", "stats"] as const,
  search: (params: unknown) => ["company-search", params] as const,
  company: (id: string) => ["company", id] as const,
  companyContacts: (id: string, params: unknown) => ["company-contacts", id, params] as const,
  contacts: (params: unknown) => ["contacts", params] as const,
  contact: (id: string) => ["contact", id] as const,
  leads: ["leads"] as const,
  savedSearches: ["saved-searches"] as const,
  settings: ["settings"] as const,
  exports: ["exports"] as const,
  activity: ["activity"] as const,
};

/* ------------------------------ dataset ---------------------------------- */

export function useHealth() {
  return useQuery({ queryKey: queryKeys.health, queryFn: () => api.health(), staleTime: 60_000, retry: 0 });
}

export function useDatasetStatus() {
  return useQuery({
    queryKey: queryKeys.datasetStatus,
    queryFn: () => api.datasetStatus(),
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * The application's mode, derived from the dataset status — never from whether a
 * bucket happens to be reachable.
 *
 * Every screen reads the mode through this hook so "demo", "live" and "nothing
 * published" stay consistent, and a failed status request falls back to
 * `no-dataset` (the honest default) instead of pretending data exists.
 */
export function useDatasetMode() {
  const status = useDatasetStatus();
  const info = datasetModeInfo(status.data);
  return {
    ...info,
    status: status.data,
    isLoading: status.isLoading,
    error: status.error,
    refetch: status.refetch,
  };
}

/**
 * Bounded `raw/` listing, fetched only by the Dataset Management page (a LIST is
 * a Class A operation, so it must not run from the app shell on every page).
 */
export function useDatasetSources() {
  return useQuery({
    queryKey: queryKeys.datasetSources,
    queryFn: () => api.datasetSources(),
    staleTime: 60_000,
    retry: 0,
  });
}

/** Statistics are optional; `null` is a normal "not generated yet" state. */
export function useDatasetStats(enabled = true) {
  return useQuery({
    queryKey: queryKeys.datasetStats,
    queryFn: () => api.datasetStats(),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useValidateDataset() {
  return useMutation({
    mutationFn: (version: string) => api.validateDataset(version),
    onSuccess: (result) => {
      toast[result.passed ? "success" : "warning"](
        result.passed ? `Version ${result.version} passed validation.` : `Version ${result.version} reported problems.`,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useActivateDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: string) => api.activateDataset(version),
    onSuccess: async (result) => {
      toast.success(`Active dataset is now ${result.activeVersion}.`);
      await invalidateCacheForVersion(result.activeVersion);
      await queryClient.invalidateQueries();
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------- search ---------------------------------- */

export interface CompanySearchQuery {
  query: string;
  page: number;
  pageSize: number;
  sort: CompanySortField;
  order: SortOrder;
  fuzzy: boolean;
  resultBudget: number;
  filters: CompanyFilters;
}

export function useCompanySearch(params: CompanySearchQuery) {
  return useQuery({
    queryKey: queryKeys.search(params),
    queryFn: () =>
      api.searchCompanies({
        query: params.query,
        page: params.page,
        pageSize: params.pageSize,
        sort: params.sort,
        order: params.order,
        fuzzy: params.fuzzy,
        resultBudget: params.resultBudget,
        filters: params.filters,
      }),
    enabled: params.query.trim().length > 0,
    // Keep the previous page visible while the next one loads.
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

export function useCompany(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.company(id ?? ""),
    queryFn: () => api.getCompany(id!),
    enabled: Boolean(id),
    staleTime: 10 * 60_000,
    retry: 1,
  });
}

export function useCompanyContacts(
  companyId: string | undefined,
  params: { page: number; pageSize: number; sort: ContactSortField; order: SortOrder; filters: ContactFilters },
) {
  return useQuery({
    queryKey: queryKeys.companyContacts(companyId ?? "", params),
    queryFn: () => api.getCompanyContacts(companyId!, params),
    enabled: Boolean(companyId),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

export function useContacts(
  params: { companyIds?: string[]; page: number; pageSize: number; sort: ContactSortField; order: SortOrder; filters: ContactFilters },
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.contacts(params),
    queryFn: () => api.listContacts(params),
    enabled: enabled && Boolean(params.companyIds?.length),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

export function useContact(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.contact(id ?? ""),
    queryFn: () => api.getContact(id!),
    enabled: Boolean(id),
    staleTime: 10 * 60_000,
  });
}

/* -------------------------------- leads ---------------------------------- */

export function useLeads() {
  return useQuery({ queryKey: queryKeys.leads, queryFn: () => api.listLeads(), staleTime: 30_000 });
}

export function useSaveLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.saveLead>[0]) => api.saveLead(input),
    onSuccess: (lead) => {
      toast.success(`Saved ${lead.kind === "company" ? lead.name : lead.fullName} to leads.`);
      queryClient.invalidateQueries({ queryKey: queryKeys.leads });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; status?: LeadStatus; tags?: string[]; addNote?: string; removeNoteAt?: string }) =>
      api.updateLead(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.leads });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteLead(id),
    onSuccess: () => {
      toast.success("Lead removed.");
      queryClient.invalidateQueries({ queryKey: queryKeys.leads });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ---------------------------- saved searches ----------------------------- */

export function useSavedSearches() {
  return useQuery({ queryKey: queryKeys.savedSearches, queryFn: () => api.listSavedSearches(), staleTime: 60_000 });
}

export function useCreateSavedSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SavedSearchRequest) => api.createSavedSearch(input),
    onSuccess: (search) => {
      toast.success(`Saved search "${search.name}" created.`);
      queryClient.invalidateQueries({ queryKey: queryKeys.savedSearches });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteSavedSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSavedSearch(id),
    onSuccess: () => {
      toast.success("Saved search deleted.");
      queryClient.invalidateQueries({ queryKey: queryKeys.savedSearches });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useMarkSavedSearchRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markSavedSearchRun(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.savedSearches }),
  });
}

/* ------------------------------- settings -------------------------------- */

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: async () => {
      const settings = await api.getSettings();
      // Keep the IndexedDB layer aligned with the user's privacy preferences.
      configurePersistentCache({
        enabled: settings.cacheEnabled,
        ttlMinutes: settings.cacheTtlMinutes,
        maxEntries: settings.cacheMaxEntries,
        redactContacts: !settings.retainContactFieldsInCache,
      });
      return settings;
    },
    staleTime: 5 * 60_000,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SettingsRequest) => api.updateSettings(input),
    onSuccess: (settings) => {
      configurePersistentCache({
        enabled: settings.cacheEnabled,
        ttlMinutes: settings.cacheTtlMinutes,
        maxEntries: settings.cacheMaxEntries,
        redactContacts: !settings.retainContactFieldsInCache,
      });
      queryClient.setQueryData(queryKeys.settings, settings);
      toast.success("Settings saved.");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* -------------------------------- exports -------------------------------- */

export function useExports() {
  return useQuery({ queryKey: queryKeys.exports, queryFn: () => api.listExports(), staleTime: 30_000 });
}

export function useCreateExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ExportRequestBody) => api.createExport(body),
    onSuccess: (job) => {
      toast.success(`Export ready: ${job.rowCount} rows.`);
      queryClient.invalidateQueries({ queryKey: queryKeys.exports });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------- activity -------------------------------- */

export function useActivity() {
  return useQuery({ queryKey: queryKeys.activity, queryFn: () => api.listActivity(), staleTime: 60_000 });
}

/**
 * Activity is written at most once per 15s per label, so typing in the search
 * box never turns into an R2 write per keystroke.
 */
const recentActivity = new Map<string, number>();
export function recordActivity(entry: { kind: "search" | "company-view" | "lead-saved" | "export" | "dataset"; label: string; detail?: string; href?: string }) {
  const key = `${entry.kind}:${entry.label}`;
  const now = Date.now();
  const last = recentActivity.get(key) ?? 0;
  if (now - last < 15_000) return;
  recentActivity.set(key, now);
  void api.recordActivity(entry).catch(() => {
    // Activity is a convenience feed; never surface its failure to the user.
  });
}

/** Trigger a browser download for a generated export. */
export async function downloadExportFile(id: string): Promise<void> {
  const { filename, csv, truncated } = await api.downloadExport(id);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  if (truncated) {
    toast.warning("Export was truncated at the row safety limit.");
  } else {
    toast.success(`Downloaded ${filename}`);
  }
}
