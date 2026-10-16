/**
 * API client selection + cache layer 2 wiring.
 *
 *   VITE_API_MODE=worker  → Cloudflare Worker API (production behaviour)
 *   VITE_API_MODE=local   → synthetic sample dataset (preview only)
 *
 * The mode is explicit configuration, never an accidental fallback: if the
 * Worker is unreachable the app reports the error instead of silently
 * switching to sample data.
 */

import type { CompanyDetailResponse, CompanySearchResponse, ContactPageResponse, DatasetStatusResponse } from "@/shared/models";
import { SEARCH_LIMITS, buildContactCacheKey, buildSearchCacheKey } from "@/shared/search/engine";
import { persistentCache, type PersistentCacheOptions } from "@/lib/cache/persistent-cache";
import { LocalApiClient } from "./local";
import { WorkerApiClient } from "./worker";
import { API_CLIENT_METHODS, apiClientMethodNames, type ApiClient, type CompanySearchParams, type ContactQueryParams } from "./types";

interface ViteEnv {
  VITE_API_MODE?: string;
  VITE_API_BASE_URL?: string;
}

const env = (import.meta as unknown as { env?: ViteEnv }).env ?? {};
const configuredMode = env.VITE_API_MODE?.trim();
const configuredBaseUrl = env.VITE_API_BASE_URL?.trim();

export const apiMode: "local" | "worker" =
  configuredMode === "local"
    ? "local"
    : configuredMode === "worker"
      ? "worker"
      : configuredBaseUrl
        ? "worker"
        : "local";

export const apiBaseUrl = configuredBaseUrl ?? "";

let client: ApiClient | null = null;

/** The raw (uncached) client for the configured mode. */
export function getApiClient(): ApiClient {
  if (!client) {
    client = apiMode === "worker" ? new WorkerApiClient(apiBaseUrl) : new LocalApiClient();
  }
  return client;
}

/* ----------------------------- cache layer 2 ------------------------------ */

let cacheOptions: PersistentCacheOptions = {
  enabled: true,
  ttlMinutes: 30,
  maxEntries: 300,
  redactContacts: true,
};

/** Called by the settings screen whenever the user changes cache preferences. */
export function configurePersistentCache(options: Partial<PersistentCacheOptions>): void {
  cacheOptions = { ...cacheOptions, ...options };
}

export function getPersistentCacheOptions(): PersistentCacheOptions {
  return cacheOptions;
}

/**
 * Wrap the client so search / company detail / contact pages consult IndexedDB
 * before touching the network. Keys include the dataset version, so publishing
 * a new dataset version invalidates everything automatically.
 */
export function withPersistentCache(base: ApiClient): ApiClient {
  const cached = async <T>(key: string, datasetVersion: string, produce: () => Promise<T>): Promise<T> => {
    const hit = await persistentCache.get<T>(key, cacheOptions);
    if (hit !== null) return hit;
    const value = await produce();
    await persistentCache.set(key, value, datasetVersion, cacheOptions);
    return value;
  };

  const resolveVersion = async (): Promise<string> => {
    const status = (await base.datasetStatus()) as DatasetStatusResponse;
    return status.activeVersion ?? (status.dataOrigin === "sample" ? "sample-v1" : "unindexed");
  };

  /*
   * Forward EVERY method the underlying client really has.
   *
   * This used to be an object spread of `base` plus four cached overrides. That
   * looks like it copies the client and it typechecks — but spread copies only *own
   * enumerable* properties, and class methods live on the prototype. The result
   * was a client object with `mode` and four methods and nothing else, which is
   * exactly the runtime failure the preview showed:
   *
   *     Request failed — api.datasetStatus is not a function
   *
   * while every typecheck passed. Walking the prototype chain instead means a
   * method added to `ApiClient` later is forwarded automatically, and the guard
   * below turns any real gap into a loud error instead of a broken page.
   */
  const wrapper: Record<string, unknown> = {};
  for (const name of apiClientMethodNames(base)) {
    const fn = (base as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    wrapper[name] = (...args: unknown[]) => fn.apply(base, args);
  }
  const missing = API_CLIENT_METHODS.filter((name) => typeof wrapper[name] !== "function");
  if (missing.length) {
    throw new Error(
      `The ${base.mode} API client does not implement: ${missing.join(", ")}. ` +
        "Every method of ApiClient must exist at runtime — see src/lib/api/types.ts.",
    );
  }
  wrapper.mode = base.mode;

  return {
    ...(wrapper as unknown as ApiClient),

    async searchCompanies(params: CompanySearchParams): Promise<CompanySearchResponse> {
      const datasetVersion = await resolveVersion().catch(() => "unknown");
      const key = buildSearchCacheKey({
        datasetVersion,
        query: params.query,
        fuzzy: params.fuzzy ?? true,
        sort: params.sort ?? "relevance",
        order: params.order ?? "desc",
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 25,
        resultBudget: params.resultBudget ?? SEARCH_LIMITS.defaultResultBudget,
        filters: params.filters,
      });
      return cached(key, datasetVersion, () => base.searchCompanies(params));
    },

    async getCompany(id: string): Promise<CompanyDetailResponse> {
      const datasetVersion = await resolveVersion().catch(() => "unknown");
      return cached(`company|${datasetVersion}|${id}`, datasetVersion, () => base.getCompany(id));
    },

    async getCompanyContacts(companyId: string, params: ContactQueryParams = {}): Promise<ContactPageResponse> {
      const datasetVersion = await resolveVersion().catch(() => "unknown");
      const key = buildContactCacheKey({
        datasetVersion,
        companyId,
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 25,
        sort: params.sort ?? "name",
        order: params.order ?? "asc",
        filters: params.filters as Record<string, unknown> | undefined,
      });
      return cached(key, datasetVersion, () => base.getCompanyContacts(companyId, params));
    },

    async listContacts(params: ContactQueryParams = {}): Promise<ContactPageResponse> {
      const datasetVersion = await resolveVersion().catch(() => "unknown");
      const key = buildContactCacheKey({
        datasetVersion,
        companyId: params.companyIds?.join(",") ?? params.companyId ?? null,
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 25,
        sort: params.sort ?? "name",
        order: params.order ?? "asc",
        filters: params.filters as Record<string, unknown> | undefined,
      });
      return cached(key, datasetVersion, () => base.listContacts(params));
    },
  };
}

let cachedClient: ApiClient | null = null;

export function createApiClient(): ApiClient {
  if (!cachedClient) cachedClient = withPersistentCache(getApiClient());
  return cachedClient;
}

/** Invalidate cached pages that do not belong to the active dataset version. */
export async function invalidateCacheForVersion(activeVersion: string | null): Promise<number> {
  return persistentCache.invalidateExcept(activeVersion);
}

export async function clearPersistentCache(): Promise<void> {
  await persistentCache.clearAll();
}

export { persistentCache };
