/**
 * CompanyIntel Worker API (Hono).
 *
 * Every route below is behind Cloudflare Access verification (`verifyAccess`),
 * validates its inputs with the shared Zod contract, and answers with the same
 * shapes the frontend parses. Nothing here scans CSV files: retrieval goes
 * through the sharded index and bounded profile reads only.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  MAX_EXPORT_ROWS,
  activityRequestSchema,
  companyFiltersSchema,
  companySearchRequestSchema,
  contactFiltersSchema,
  datasetActivateRequestSchema,
  exportRequestSchema,
  parseAssociationFilter,
  savedSearchRequestSchema,
  saveLeadRequestSchema,
  settingsRequestSchema,
  toContactFilters,
  updateLeadRequestSchema,
} from "../../src/shared/api-contract";
import { associationMatchesFilter, type AssociationCategory } from "../../src/shared/association";
import { spoolPartitionOfNormalizedName, type IndexDirectory } from "../../src/shared/search/index-format";
import { DEFAULT_SETTINGS, LEAD_STATUSES } from "../../src/shared/models";
import type {
  ActivityEntry,
  CompanySearchHit,
  Contact,
  ContactFilters,
  DatasetSourcesResponse,
  DatasetStatusResponse,
  DatasetValidationResponse,
  ExportJob,
  SavedLead,
  SavedSearch,
  UnassignedContact,
  UnassignedContactsResponse,
  UserSettings,
} from "../../src/shared/models";
import { EXPORT_COLUMN_HEADERS, exportFilename, toCsv, type CsvColumn } from "../../src/shared/csv";
import { leadId } from "../../src/shared/hash";
import { searchCompanies } from "../../src/shared/search/engine";
import { R2Store } from "./store";
import { R2CandidateSource } from "./search-source";
import { ReadMetrics, searchCacheFor } from "./search-cache";
import { AccessError, verifyAccess } from "./access";
import type { AccessIdentity, Env } from "./env";

type Variables = { identity: AccessIdentity; requestId: string; store: R2Store; metrics: ReadMetrics };

export const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const APP_VERSION = "0.1.0";
/** The only bucket this Worker is bound to; there is no second data store. */
const BUCKET_NAME = "company-intel-data";
/** Contact listing is bounded: this many company partitions per request. */
const MAX_CONTACT_COMPANIES = 50;
/** Bounded `raw/` listing for the Dataset page — never a full bucket walk. */
const MAX_RAW_OBJECTS = 25;

/* ------------------------------- middleware ------------------------------ */

app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  c.set("requestId", requestId);
  // Per-request R2 accounting, plus the isolate-wide cache of immutable index
  // objects (one cache per bucket binding; mutable `app-data/` reads bypass it).
  c.set("metrics", new ReadMetrics());
  c.set(
    "store",
    new R2Store(c.env.COMPANY_DATA, {
      cache: searchCacheFor(c.env.COMPANY_DATA),
      metrics: c.get("metrics"),
    }),
  );
  await next();
  c.header("x-request-id", requestId);
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("x-frame-options", "DENY");
  c.header("permissions-policy", "geolocation=(), microphone=(), camera=()");
  c.header("cross-origin-opener-policy", "same-origin");
});

/** Reject cross-origin API use outright: this app is same-origin only. */
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  const host = new URL(c.req.url).origin;
  if (origin && origin !== host) {
    return c.json(
      { error: { code: "forbidden" as const, message: "Cross-origin requests are not allowed on this API" } },
      403,
    );
  }
  await next();
});

/** Cloudflare Access verification for every API route (no anonymous access). */
app.use("/api/*", async (c, next) => {
  const identity = await verifyAccess(c.req.raw, c.env);
  c.set("identity", identity);
  await next();
});

/** Best-effort in-isolate rate limiting; production should also use WAF rules. */
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

app.use("/api/*", async (c, next) => {
  const identity = c.get("identity");
  const limit = Number(c.env.MAX_SEARCHES_PER_MINUTE ?? 120);
  if (!rateLimit(`${identity.email}:${new URL(c.req.url).pathname}`, limit)) {
    return c.json(
      { error: { code: "rate_limited" as const, message: `Rate limit exceeded (${limit} requests/minute)` } },
      429,
    );
  }
  await next();
});

app.onError((error, c) => {
  const requestId = c.get("requestId");
  if (error instanceof AccessError) {
    return c.json({ error: { code: error.code, message: error.message, requestId } }, error.status as 401);
  }
  // `HttpError` carries the status the client must see (404 not found, 503 no
  // dataset, 400 invalid). Without this branch every one of those would surface
  // as a generic 500 and the UI could not tell "missing" from "broken".
  if (error instanceof HttpError) {
    return c.json(
      { error: { code: error.code, message: error.message, requestId } },
      error.status as 400 | 401 | 403 | 404 | 429 | 500 | 503,
    );
  }
  if (error instanceof z.ZodError) {
    return c.json(
      {
        error: {
          code: "invalid_request" as const,
          message: error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "),
          requestId,
        },
      },
      400,
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return c.json({ error: { code: "internal" as const, message, requestId } }, 500);
});

/* --------------------------------- helpers ------------------------------- */

interface DatasetContext {
  store: R2Store;
  version: string;
  source: R2CandidateSource;
  /** The version's directory — the single source of truth for shard counts. */
  directory: IndexDirectory;
}

async function requireDataset(store: R2Store): Promise<DatasetContext> {
  const pointer = await store.getActivePointer();
  if (!pointer?.version) {
    throw new HttpError(503, "dataset_unavailable", "No dataset version is active. Index and publish a dataset first.");
  }
  const directory = await store.getDirectory(pointer.version);
  if (!directory) {
    throw new HttpError(503, "dataset_unavailable", `Index directory for version ${pointer.version} is missing or unreadable.`);
  }
  return { store, version: pointer.version, source: new R2CandidateSource(store, directory), directory };
}

/** Convenience wrapper for route handlers. */
function datasetFor(c: { get: (key: "store") => R2Store }): Promise<DatasetContext> {
  return requireDataset(c.get("store"));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: "unauthorized" | "forbidden" | "invalid_request" | "not_found" | "dataset_unavailable" | "rate_limited" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function enrichHits(hits: CompanySearchHit[], source: R2CandidateSource): CompanySearchHit[] {
  return hits.map((hit) => {
    const company = source.companyForId(hit.id);
    if (!company) return hit;
    return {
      ...hit,
      website: company.website,
      linkedinUrl: company.linkedinUrl,
      state: company.state,
      companySize: company.companySize,
      revenue: company.revenue,
      multiSource: new Set(company.sources.map((s) => s.source)).size > 1,
    };
  });
}

function paginate<T>(rows: T[], page: number, pageSize: number) {
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return {
    slice,
    page: {
      page,
      pageSize,
      total: rows.length,
      totalIsLowerBound: false,
      hasMore: start + pageSize < rows.length,
    },
  };
}

function sortContacts(contacts: Contact[], sort: string, order: "asc" | "desc"): Contact[] {
  const pick = (contact: Contact) =>
    sort === "title" ? contact.title ?? "" : sort === "country" ? contact.country ?? "" : contact.fullName;
  return [...contacts].sort((a, b) => {
    const delta = pick(a).localeCompare(pick(b));
    return order === "asc" ? delta : -delta;
  });
}

function filterContacts(contacts: Contact[], filters?: ContactFilters): Contact[] {
  if (!filters) return contacts;
  return contacts.filter((contact) => {
    if (filters.designation && contact.designation !== filters.designation) return false;
    if (filters.department && contact.department !== filters.department) return false;
    if (filters.seniority && contact.seniority !== filters.seniority) return false;
    if (filters.country && contact.country !== filters.country) return false;
    if (filters.city && contact.city !== filters.city) return false;
    if (filters.hasEmail && !contact.email) return false;
    if (filters.hasLinkedin && !contact.linkedinUrl) return false;
    // Association category: the trusted view (high-confidence + plausible) is
    // expressed as a filter, never as a silent omission of disputed rows.
    if (!associationMatchesFilter(contact.association?.category, filters.association)) return false;
    return true;
  });
}

/* --------------------------------- routes -------------------------------- */

app.get("/api/health", (c) => {
  const identity = c.get("identity");
  return c.json({
    ok: true,
    service: "companyintel-worker",
    mode: "worker" as const,
    version: c.env.APP_VERSION ?? APP_VERSION,
    datasetVersion: null as string | null,
    time: new Date().toISOString(),
    identity: identity.email,
    environment: c.env.ENVIRONMENT ?? "unknown",
  });
});

app.get("/api/dataset/status", async (c) => {
  const store = c.get("store");
  const pointer = await store.getActivePointer();
  const versions = await store.listManifests(10);
  let bucketOk = true;
  let bucketError: string | undefined;
  let sources: DatasetStatusResponse["sources"] = [];

  if (pointer?.version) {
    const directory = await store.getDirectory(pointer.version);
    sources = (directory?.sources ?? []).map((id) => ({
      id,
      key: "raw/",
      // The real source files are known from the verified bucket inventory; the
      // id alone does not carry the key, so nothing is invented here.
      ...(id === "csv1" ? { role: "organizations" as const } : {}),
      ...(id === "csv2" ? { role: "people" as const } : {}),
      sizeBytes: null,
      lastModified: null,
      verified: false,
      error:
        "The manifest records that this source contributed rows, but not the uploaded file name. Open the Dataset page to list the actual raw/ objects with their sizes.",
    }));
  } else {
    try {
      // Only a HEAD is used: never list a 60 GB prefix on a status request.
      await store.head("raw/");
      bucketOk = true;
    } catch (error) {
      bucketOk = false;
      bucketError = error instanceof Error ? error.message : "R2 bucket is not reachable";
    }
  }

  const manifest = pointer?.version ? await store.getManifest(pointer.version) : null;
  const progress = pointer?.version ? await store.getProgress(pointer.version) : null;

  const response: DatasetStatusResponse = {
    indexed: Boolean(pointer?.version && manifest?.validationPassed),
    activeVersion: pointer?.version ?? null,
    previousVersion: pointer?.previousVersion ?? null,
    message: pointer?.version
      ? `Active dataset version ${pointer.version}.`
      : "Dataset not indexed. Run the local indexer and publish a validated version.",
    bucket: BUCKET_NAME,
    bucketOk,
    bucketError,
    sources,
    versions,
    lastIndexedAt: manifest?.completedAt ?? null,
    indexing: (progress as DatasetStatusResponse["indexing"]) ?? null,
    dataOrigin: "r2",
  };
  return c.json(response);
});

/**
 * Bounded listing of the original files under `raw/`.
 *
 * Deliberately a separate endpoint from `/api/dataset/status`: status is called
 * on every page by the shell, and a LIST is a Class A operation. This one is
 * requested only when the Dataset Management page is opened, returns at most 25
 * objects (never the index or contact prefixes), and reports failure honestly
 * instead of inventing sizes.
 */
app.get("/api/dataset/sources", async (c) => {
  const store = c.get("store");
  const checkedAt = new Date().toISOString();
  try {
    const objects = await store.list("raw/", MAX_RAW_OBJECTS + 1);
    return c.json<DatasetSourcesResponse>({
      bucket: BUCKET_NAME,
      objects: objects.slice(0, MAX_RAW_OBJECTS).map((object) => ({
        key: object.key,
        sizeBytes: typeof object.size === "number" ? object.size : null,
        lastModified: object.uploaded ? new Date(object.uploaded).toISOString() : null,
      })),
      truncated: objects.length > MAX_RAW_OBJECTS,
      checkedAt,
    });
  } catch (error) {
    return c.json<DatasetSourcesResponse>({
      bucket: BUCKET_NAME,
      objects: [],
      truncated: false,
      checkedAt,
      error: error instanceof Error ? error.message : "The raw/ prefix could not be listed",
    });
  }
});

app.get("/api/dataset/stats", async (c) => {
  const store = c.get("store");
  const pointer = await store.getActivePointer();
  if (!pointer?.version) {
    return c.json({
      error: {
        code: "dataset_unavailable" as const,
        message: "No dataset version is active, so no statistics exist yet.",
      },
    }, 503);
  }
  const stats = await store.getStats(pointer.version);
  if (!stats) {
    return c.json({
      error: {
        code: "not_found" as const,
        message: `Version ${pointer.version} has no statistics object (manifests/${pointer.version}/stats.json).`,
      },
    }, 404);
  }
  return c.json(stats);
});

app.post("/api/dataset/validate", async (c) => {
  const body = z.object({ version: z.string().min(1).max(64) }).parse(await c.req.json());
  const store = c.get("store");
  const stored = (await store.getValidation(body.version)) as DatasetValidationResponse | null;
  if (stored) return c.json(stored);

  const directory = await store.getDirectory(body.version);
  if (!directory) {
    const response: DatasetValidationResponse = {
      version: body.version,
      passed: false,
      checkedAt: new Date().toISOString(),
      issues: [
        { severity: "error", code: "missing_directory", message: `Index directory for ${body.version} is missing.` },
      ],
      verifiedObjects: 0,
      missingObjects: [`indexes/${body.version}/directory.json`],
    };
    return c.json(response, 404);
  }
  // Object-level verification is performed by the local indexer's `validate`
  // command; the Worker re-checks the essentials it can do cheaply.
  const misses: string[] = [];
  const shards = [
    { kind: "exact" as const, count: directory.shards.exact },
    { kind: "prefix" as const, count: directory.shards.prefix },
    { kind: "token" as const, count: directory.shards.token },
    { kind: "trigram" as const, count: directory.shards.trigram },
  ];
  let verified = 0;
  for (const shard of shards) {
    for (let shardId = 0; shardId < Math.min(shard.count, 8); shardId += 1) {
      const head = await store.head(`${"indexes/" + body.version + "/" + shard.kind}/${String(shardId).padStart(4, "0")}.json.gz`);
      if (head) verified += 1;
      else misses.push(`${shard.kind}/${shardId}`);
    }
  }
  const response: DatasetValidationResponse = {
    version: body.version,
    passed: misses.length === 0,
    checkedAt: new Date().toISOString(),
    issues: misses.length
      ? [{ severity: "error", code: "missing_shards", message: `Missing index shards: ${misses.slice(0, 10).join(", ")}` }]
      : [{ severity: "info", code: "sampled_verification", message: `Sampled ${verified} index objects; full verification is performed by the local indexer.` }],
    verifiedObjects: verified,
    missingObjects: misses,
  };
  return c.json(response);
});

app.post("/api/dataset/activate", async (c) => {
  const body = datasetActivateRequestSchema.parse(await c.req.json());
  const store = c.get("store");
  const manifest = await store.getManifest(body.version);
  if (!manifest) throw new HttpError(404, "not_found", `Version ${body.version} has no manifest.`);
  if (!manifest.validationPassed) {
    throw new HttpError(400, "invalid_request", `Version ${body.version} did not pass validation and cannot be activated.`);
  }
  const current = await store.getActivePointer();
  await store.activateVersion({
    version: body.version,
    previousVersion: current?.version ?? null,
    activatedAt: new Date().toISOString(),
    activatedBy: c.get("identity").email,
  });
  return c.json({ activated: true, activeVersion: body.version });
});

app.get("/api/companies/search", async (c) => {
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const parsed = companySearchRequestSchema.parse({
    ...query,
    filters: companyFiltersSchema.optional().parse(extractFilters(query)),
  });
  const dataset = await datasetFor(c);
  // `SEARCH_MAX_HYDRATE` is the operator's recall/CPU dial: profile partitions
  // read per search. Unset or unparseable falls through to the engine default
  // (16), which the engine clamps to its own ceiling.
  const configuredHydrate = Number(c.env.SEARCH_MAX_HYDRATE);
  // Snapshot the isolate-wide cache counters so the reported hit/miss numbers are
  // this search's, not the isolate's lifetime totals.
  const cache = searchCacheFor(c.env.COMPANY_DATA);
  const metrics = c.get("metrics");
  const cacheBefore = metrics.snapshotCache(cache);
  const response = await searchCompanies(dataset.source, parsed.q, {
    page: parsed.page,
    pageSize: parsed.pageSize,
    sort: parsed.sort,
    order: parsed.order,
    fuzzy: parsed.fuzzy,
    resultBudget: parsed.resultBudget,
    filters: parsed.filters,
    maxHydrate: Number.isFinite(configuredHydrate) && configuredHydrate > 0 ? configuredHydrate : undefined,
  });
  metrics.recordCacheDelta(cache, cacheBefore);
  // Logical reads the search asked for; `shardGets`/`partitionGets` already hold
  // the subset that had to become real R2 GETs.
  metrics.shardRequests += dataset.source.shardReads;
  metrics.partitionRequests += dataset.source.partitionReads;
  return c.json({
    ...response,
    hits: enrichHits(response.hits, dataset.source),
    retrieval: { ...response.retrieval, r2: metrics.toJSON() },
  });
});

app.get("/api/companies/:id", async (c) => {
  const dataset = await datasetFor(c);
  const ref = await dataset.source.refForCompanyId(c.req.param("id"));
  if (ref === null) throw new HttpError(404, "not_found", `Company ${c.req.param("id")} is not in dataset ${dataset.version}.`);
  const company = await dataset.store.getCompanyByRef(dataset.version, ref);
  if (!company) throw new HttpError(404, "not_found", `Company record ${c.req.param("id")} could not be read.`);
  return c.json({
    company,
    facets:
      company.facets ?? {
        designations: [],
        departments: [],
        seniority: [],
        countries: [],
        cities: [],
        emailAvailable: 0,
        linkedinAvailable: 0,
      },
    datasetVersion: dataset.version,
  });
});

app.get("/api/companies/:id/contacts", async (c) => {
  const dataset = await datasetFor(c);
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)));
  const sort = query.sort ?? "name";
  const order = query.order === "desc" ? "desc" : "asc";
  const filters = toContactFilters(contactFiltersSchema.optional().parse(extractFilters(query)));

  const ref = await dataset.source.refForCompanyId(c.req.param("id"));
  if (ref === null) throw new HttpError(404, "not_found", `Company ${c.req.param("id")} is not in dataset ${dataset.version}.`);
  const contacts = sortContacts(filterContacts(await dataset.store.getContactsByCompanyRef(dataset.version, ref), filters), sort, order);
  const { slice, page: pageInfo } = paginate(contacts, page, pageSize);
  return c.json({ companyId: c.req.param("id"), contacts: slice, page: pageInfo, datasetVersion: dataset.version });
});

/**
 * Contacts preserved WITHOUT an employer that claimed this company's name.
 *
 * Deliberately its own endpoint, not part of the company profile: a company page
 * must stay cheap, and these rows are the ones the indexer refused to attach, so
 * they belong behind an explicit "review the uncertain ones" action. One bounded
 * object read (the company's own Pass 1 partition); format-v2 indexes answer with
 * an empty list rather than an error.
 */
app.get("/api/companies/:id/unassigned", async (c) => {
  const dataset = await datasetFor(c);
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)));
  // Default to the unattached ones; `?category=conflicting` reviews the ones the
  // index attached to their claim but flagged.
  const wanted = parseAssociationFilter(query.category) ?? (["unresolved"] as AssociationCategory[]);

  const ref = await dataset.source.refForCompanyId(c.req.param("id"));
  if (ref === null) throw new HttpError(404, "not_found", `Company ${c.req.param("id")} is not in dataset ${dataset.version}.`);
  const company = await dataset.store.getCompanyByRef(dataset.version, ref);
  if (!company) throw new HttpError(404, "not_found", `Company record ${c.req.param("id")} could not be read.`);

  const preserved: UnassignedContact[] = [];
  const partitions = dataset.directory.shards.spoolPartitions;
  if (partitions && partitions > 0) {
    const partition = spoolPartitionOfNormalizedName(company.normalizedName, partitions);
    for (const contact of await dataset.store.getUnassignedContacts(dataset.version, partition)) {
      if (!wanted.includes(contact.association.category)) continue;
      // Keep it only when this company is what the contact claimed, or when it was
      // one of the candidates the decision could not choose between.
      const claimed = contact.claimedNormalizedName === company.normalizedName;
      if (!claimed && !contact.association.candidateCompanyIds?.includes(company.id)) continue;
      preserved.push(contact);
    }
  }

  const sorted = [...preserved].sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id));
  const { slice, page: pageInfo } = paginate(sorted, page, pageSize);
  const response: UnassignedContactsResponse = {
    companyId: company.id,
    companyName: company.name,
    contacts: slice,
    page: pageInfo,
    datasetVersion: dataset.version,
    totals: {
      unresolved: sorted.filter((contact) => contact.association.category === "unresolved").length,
      conflicting: company.associations?.conflicting ?? 0,
    },
  };
  return c.json(response);
});

app.get("/api/contacts", async (c) => {
  const dataset = await datasetFor(c);
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const companyIds = String(query.companyIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!companyIds.length) {
    throw new HttpError(
      400,
      "invalid_request",
      "Global contact listing across the whole dataset requires a dedicated contact index, which is not enabled. Pass companyIds (max 50) to list contacts for specific companies.",
    );
  }
  if (companyIds.length > MAX_CONTACT_COMPANIES) {
    throw new HttpError(400, "invalid_request", `At most ${MAX_CONTACT_COMPANIES} companies per contact request.`);
  }
  const filters = toContactFilters(contactFiltersSchema.optional().parse(extractFilters(query)));
  const collected: Contact[] = [];
  for (const companyId of companyIds) {
    const ref = await dataset.source.refForCompanyId(companyId);
    if (ref === null) continue;
    collected.push(...(await dataset.store.getContactsByCompanyRef(dataset.version, ref)));
  }
  const filtered = filterContacts(collected, filters);
  const sorted = sortContacts(filtered, query.sort ?? "name", query.order === "desc" ? "desc" : "asc");
  const { slice, page } = paginate(sorted, Math.max(1, Number(query.page ?? 1)), Math.min(100, Math.max(1, Number(query.pageSize ?? 25))));
  return c.json({ companyId: null, contacts: slice, page, datasetVersion: dataset.version });
});

app.get("/api/contacts/:id", async (c) => {
  const dataset = await datasetFor(c);
  const contactIdParam = c.req.param("id");
  // Contact ids are hashed from the company ref, so the company is discoverable
  // only through the index: walk the id index for the owning company instead of
  // scanning contact partitions.
  const ref = await dataset.source.refForContactId(contactIdParam);
  if (ref === null) throw new HttpError(404, "not_found", "Contact is not part of the active dataset.");
  const contacts = await dataset.store.getContactsByCompanyRef(dataset.version, ref);
  const contact = contacts.find((item) => item.id === contactIdParam);
  if (!contact) throw new HttpError(404, "not_found", "Contact record could not be read.");
  const company = await dataset.store.getCompanyByRef(dataset.version, ref);
  return c.json({ contact, company, datasetVersion: dataset.version });
});

/* -------------------------------- leads ---------------------------------- */

app.get("/api/leads", async (c) => {
  const leads = await c.get("store").listLeads();
  return c.json({ leads, total: leads.length });
});

/**
 * Repair the saved-lead directory from the authoritative shard objects.
 *
 * Needed if a write was interrupted between the shard and the directory object
 * (the shard is written first, so the leads themselves survive). Reads already
 * self-heal, so this is for an explicit operator action; it never deletes a lead.
 */
app.post("/api/leads/repair", async (c) => {
  const index = await c.get("store").rebuildLeadIndex();
  return c.json({ repaired: true, total: index.total, partitions: index.partitions.length });
});

app.post("/api/leads", async (c) => {
  const body = saveLeadRequestSchema.parse(await c.req.json());
  const dataset = await datasetFor(c);
  const store = c.get("store");
  const id = leadId(body.kind, body.targetId);
  const at = new Date().toISOString();

  let lead: SavedLead;
  if (body.kind === "company") {
    const ref = await dataset.source.refForCompanyId(body.targetId);
    if (ref === null) throw new HttpError(404, "not_found", "Company is not in the active dataset.");
    const company = await store.getCompanyByRef(dataset.version, ref);
    if (!company) throw new HttpError(404, "not_found", "Company record could not be read.");
    lead = {
      id,
      kind: "company",
      companyId: company.id,
      name: company.name,
      industry: company.industry,
      country: company.country,
      contactCount: company.contactCount,
      status: body.status,
      tags: body.tags,
      notes: [],
      savedAt: at,
      updatedAt: at,
      datasetVersion: dataset.version,
    };
  } else {
    const ref = await dataset.source.refForContactId(body.targetId);
    if (ref === null) throw new HttpError(404, "not_found", "Contact is not in the active dataset.");
    const contacts = await store.getContactsByCompanyRef(dataset.version, ref);
    const contact = contacts.find((item) => item.id === body.targetId);
    if (!contact) throw new HttpError(404, "not_found", "Contact record could not be read.");
    const company = await store.getCompanyByRef(dataset.version, ref);
    lead = {
      id,
      kind: "contact",
      contactId: contact.id,
      companyId: contact.companyId,
      companyName: company?.name ?? "Unknown company",
      fullName: contact.fullName,
      title: contact.title,
      email: contact.email,
      linkedinUrl: contact.linkedinUrl,
      status: body.status,
      tags: body.tags,
      notes: [],
      savedAt: at,
      updatedAt: at,
      datasetVersion: dataset.version,
    };
  }
  const stored = await store.upsertLead(lead);
  return c.json(stored, 201);
});

app.patch("/api/leads/:id", async (c) => {
  const body = updateLeadRequestSchema.parse(await c.req.json());
  const store = c.get("store");
  const id = c.req.param("id");
  const existing = await store.getLead(id);
  if (!existing) throw new HttpError(404, "not_found", `Lead ${id} was not found.`);
  if (body.status && !LEAD_STATUSES.includes(body.status)) {
    throw new HttpError(400, "invalid_request", `Unknown lead status: ${body.status}`);
  }
  const notes = body.removeNoteAt ? existing.notes.filter((note) => note.at !== body.removeNoteAt) : existing.notes;
  if (body.addNote) notes.push({ at: new Date().toISOString(), text: body.addNote });
  const updated: SavedLead = {
    ...existing,
    status: body.status ?? existing.status,
    tags: body.tags ?? existing.tags,
    notes,
    updatedAt: new Date().toISOString(),
  };
  return c.json(await store.upsertLead(updated));
});

app.delete("/api/leads/:id", async (c) => {
  const deleted = await c.get("store").deleteLead(c.req.param("id"));
  if (!deleted) throw new HttpError(404, "not_found", "Lead was not found.");
  return c.json({ deleted: true });
});

/* ---------------------------- saved searches ----------------------------- */

app.get("/api/saved-searches", async (c) => c.json(await c.get("store").getSavedSearches()));

app.post("/api/saved-searches", async (c) => {
  const body = savedSearchRequestSchema.parse(await c.req.json());
  const search: SavedSearch = {
    id: `ss_${crypto.randomUUID().slice(0, 8)}`,
    name: body.name,
    query: body.query,
    filters: body.filters,
    sort: body.sort,
    order: body.order,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    runCount: 0,
  };
  const list = await c.get("store").mutateSavedSearches((current) => [search, ...current].slice(0, 200));
  void list;
  return c.json(search, 201);
});

app.delete("/api/saved-searches/:id", async (c) => {
  const id = c.req.param("id");
  let removed = false;
  await c.get("store").mutateSavedSearches((current) => {
    const next = current.filter((search) => search.id !== id);
    removed = next.length !== current.length;
    return next;
  });
  if (!removed) throw new HttpError(404, "not_found", "Saved search was not found.");
  return c.json({ deleted: true });
});

app.post("/api/saved-searches/:id/run", async (c) => {
  const id = c.req.param("id");
  let updated: SavedSearch | null = null;
  await c.get("store").mutateSavedSearches((current) =>
    current.map((search) => {
      if (search.id !== id) return search;
      updated = { ...search, lastRunAt: new Date().toISOString(), runCount: search.runCount + 1 };
      return updated;
    }),
  );
  if (!updated) throw new HttpError(404, "not_found", "Saved search was not found.");
  return c.json(updated);
});

/* ------------------------------- settings -------------------------------- */

app.get("/api/settings", async (c) => {
  const stored = await c.get("store").getSettings();
  return c.json(stored ?? { ...DEFAULT_SETTINGS, updatedAt: new Date().toISOString() });
});

app.put("/api/settings", async (c) => {
  const body = settingsRequestSchema.parse(await c.req.json());
  const store = c.get("store");
  const current = (await store.getSettings()) ?? { ...DEFAULT_SETTINGS, updatedAt: new Date().toISOString() };
  const next: UserSettings = { ...current, ...body, updatedAt: new Date().toISOString() };
  return c.json(await store.putSettings(next));
});

/* ------------------------------- activity -------------------------------- */

app.get("/api/activity", async (c) => c.json(await c.get("store").getActivity()));

app.post("/api/activity", async (c) => {
  const body = activityRequestSchema.parse(await c.req.json());
  const entry: ActivityEntry = {
    id: `a_${crypto.randomUUID().slice(0, 10)}`,
    at: new Date().toISOString(),
    kind: body.kind,
    label: body.label,
    detail: body.detail,
    href: body.href,
  };
  await c.get("store").appendActivity(entry);
  return c.json({ recorded: true });
});

/* -------------------------------- exports -------------------------------- */

app.get("/api/exports", async (c) => {
  const entries = await c.get("store").listExports();
  return c.json(
    entries.map<ExportJob>((entry) => ({
      id: entry.id,
      status: "completed",
      createdAt: entry.createdAt,
      completedAt: entry.createdAt,
      rowCount: entry.rowCount,
      bytes: entry.bytes,
      objectKey: `app-data/exports/${entry.id}.csv`,
      downloadUrl: `/api/exports/${entry.id}/download`,
      filename: entry.filename,
      truncated: entry.truncated,
    })),
  );
});

app.post("/api/exports", async (c) => {
  const body = exportRequestSchema.parse(await c.req.json());
  const dataset = await datasetFor(c);
  const store = c.get("store");

  const rows: Record<string, unknown>[] = [];
  let truncated = false;

  if (body.kind === "companies") {
    const ids = body.companyIds ?? [];
    if (!ids.length) throw new HttpError(400, "invalid_request", "Select at least one company to export.");
    for (const id of ids.slice(0, MAX_EXPORT_ROWS)) {
      const ref = await dataset.source.refForCompanyId(id);
      if (ref === null) continue;
      const company = await store.getCompanyByRef(dataset.version, ref);
      if (!company) continue;
      rows.push({ ...company, sources: company.sources.map((s) => `${s.source}:${s.row}`).join(";") });
    }
  } else if (body.kind === "contacts") {
    const companyIds = body.companyId ? [body.companyId] : [];
    if (companyIds.length) {
      for (const companyId of companyIds) {
        const ref = await dataset.source.refForCompanyId(companyId);
        if (ref === null) continue;
        const company = await store.getCompanyByRef(dataset.version, ref);
        const contacts = filterContacts(await store.getContactsByCompanyRef(dataset.version, ref), toContactFilters(body.filters));
        for (const contact of contacts) {
          if (rows.length >= MAX_EXPORT_ROWS) {
            truncated = true;
            break;
          }
          rows.push({
            ...contact,
            companyName: company?.name ?? "",
            companyDomain: company?.domain ?? "",
            industry: company?.industry ?? "",
            sourceFile: contact.source.source,
            sourceRow: contact.source.row,
          });
        }
      }
    } else {
      const wanted = new Set(body.contactIds ?? []);
      if (!wanted.size) throw new HttpError(400, "invalid_request", "Provide a companyId or contactIds for a contact export.");
      for (const contactId of wanted) {
        if (rows.length >= MAX_EXPORT_ROWS) {
          truncated = true;
          break;
        }
        const ref = await dataset.source.refForContactId(contactId);
        if (ref === null) continue;
        const contacts = await store.getContactsByCompanyRef(dataset.version, ref);
        const contact = contacts.find((item) => item.id === contactId);
        if (!contact) continue;
        const company = await store.getCompanyByRef(dataset.version, ref);
        rows.push({
          ...contact,
          companyName: company?.name ?? "",
          companyDomain: company?.domain ?? "",
          industry: company?.industry ?? "",
          sourceFile: contact.source.source,
          sourceRow: contact.source.row,
        });
      }
    }
  } else {
    const wanted = new Set(body.leadIds ?? []);
    const leads = await store.listLeads();
    for (const lead of leads) {
      if (wanted.size && !wanted.has(lead.id)) continue;
      if (rows.length >= MAX_EXPORT_ROWS) {
        truncated = true;
        break;
      }
      rows.push({
        kind: lead.kind,
        name: lead.kind === "company" ? lead.name : lead.fullName,
        companyName: lead.kind === "company" ? lead.name : lead.companyName,
        title: lead.kind === "contact" ? lead.title : "",
        email: lead.kind === "contact" ? lead.email : "",
        linkedinUrl: lead.kind === "contact" ? lead.linkedinUrl : "",
        status: lead.status,
        tags: lead.tags.join("; "),
        notes: lead.notes.map((note) => note.text).join(" | "),
        savedAt: lead.savedAt,
      });
    }
  }

  const columns: CsvColumn<Record<string, unknown>>[] = body.columns.map((column) => ({
    id: column,
    header: EXPORT_COLUMN_HEADERS[column] ?? column,
    value: (row) => row[column],
  }));
  const csv = toCsv(rows, columns);
  const id = `ex_${crypto.randomUUID().slice(0, 10)}`;
  const filename = exportFilename(body.kind, body.companyId ?? body.kind);
  await store.putExport(
    { id, filename, createdAt: new Date().toISOString(), rowCount: rows.length, bytes: csv.length, truncated },
    csv,
  );

  const job: ExportJob = {
    id,
    status: "completed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    rowCount: rows.length,
    bytes: csv.length,
    objectKey: `app-data/exports/${id}.csv`,
    downloadUrl: `/api/exports/${id}/download`,
    filename,
    truncated,
  };
  return c.json(job, 201);
});

app.get("/api/exports/:id", async (c) => {
  const entry = await c.get("store").getExport(c.req.param("id"));
  if (!entry) throw new HttpError(404, "not_found", "Export was not found.");
  const job: ExportJob = {
    id: entry.id,
    status: "completed",
    createdAt: entry.createdAt,
    completedAt: entry.createdAt,
    rowCount: entry.rowCount,
    bytes: entry.bytes,
    objectKey: `app-data/exports/${entry.id}.csv`,
    downloadUrl: `/api/exports/${entry.id}/download`,
    filename: entry.filename,
    truncated: entry.truncated,
  };
  return c.json(job);
});

app.get("/api/exports/:id/download", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");
  const entry = await store.getExport(id);
  if (!entry) throw new HttpError(404, "not_found", "Export was not found.");
  const csv = await store.getExportCsv(id);
  if (csv === null) throw new HttpError(404, "not_found", "Export file is no longer available in R2.");
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="${entry.filename}"`);
  c.header("cache-control", "private, no-store");
  return c.body(csv);
});

/* --------------------------- static frontend ----------------------------- */

app.all("*", async (c) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") {
    return c.notFound();
  }
  const assets = c.env.ASSETS;
  if (!assets) {
    return c.json({ error: { code: "not_found" as const, message: "Static assets are not bound for this deployment." } }, 404);
  }
  const url = new URL(c.req.url);
  const asset = await assets.fetch(c.req.raw);
  if (asset.status !== 404) {
    // Hashed assets are immutable; the HTML shell must never be cached.
    const isHtml = (asset.headers.get("content-type") ?? "").includes("text/html");
    return withSecurityHeaders(asset, isHtml ? "no-store" : "public, max-age=31536000, immutable");
  }
  // SPA fallback: unknown paths return the shell so client routing works.
  url.pathname = "/index.html";
  const shell = await assets.fetch(new Request(url.toString(), c.req.raw));
  return withSecurityHeaders(shell, "no-store");
});

/**
 * Static asset responses are returned as a plain `Response`, so the security
 * headers have to be applied here explicitly: the middleware's `c.header()`
 * calls only decorate responses created through the Hono context.
 */
function withSecurityHeaders(response: Response, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", cacheControl);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", "geolocation=(), microphone=(), camera=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Extract `?filters` style keys from the query string into a filter object. */
function extractFilters(query: Record<string, string>): Record<string, string | boolean> {
  const reserved = new Set(["q", "page", "pageSize", "sort", "order", "fuzzy", "resultBudget", "companyIds"]);
  const filters: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(query)) {
    if (reserved.has(key)) continue;
    if (value === "true") filters[key] = true;
    else if (value === "false") filters[key] = false;
    else filters[key] = value;
  }
  return filters;
}
