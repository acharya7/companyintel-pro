/**
 * The CompanyIntel API contract.
 *
 * Every request and response shape is validated with Zod on BOTH sides:
 * the Cloudflare Worker parses inbound payloads with these schemas, and the
 * frontend parses responses with them, so a contract drift fails loudly instead
 * of rendering `undefined` in the UI.
 *
 * Final endpoint table (all under the Worker's `/api` prefix):
 *
 *   GET    /api/health
 *   GET    /api/dataset/status
 *   POST   /api/dataset/validate            { version }
 *   POST   /api/dataset/activate            { version, confirm: true }
 *   GET    /api/companies/search            ?q&page&pageSize&sort&order&fuzzy&filters
 *   GET    /api/companies/:id
 *   GET    /api/companies/:id/contacts      ?page&pageSize&sort&order&filters
 *   GET    /api/companies/:id/unassigned    ?page&pageSize&category   (contacts kept without an employer)
 *   GET    /api/contacts/:id
 *   GET    /api/contacts                    ?page&pageSize&companyIds&filters
 *   GET    /api/leads
 *   POST   /api/leads                        (idempotent upsert by kind+target)
 *   PATCH  /api/leads/:id
 *   DELETE /api/leads/:id
 *   GET    /api/saved-searches
 *   POST   /api/saved-searches
 *   DELETE /api/saved-searches/:id
 *   GET    /api/settings
 *   PUT    /api/settings
 *   GET    /api/activity
 *   POST   /api/activity
 *   GET    /api/exports
 *   POST   /api/exports
 *   GET    /api/exports/:id
 *   GET    /api/exports/:id/download
 */

import { z } from "zod";

import { ASSOCIATION_CATEGORIES, type AssociationCategory, type AssociationReason } from "./association";
import type { ContactFilters } from "./models";

/* -------------------------------------------------------------------------- */
/* Shared enums                                                               */
/* -------------------------------------------------------------------------- */

export const leadStatusSchema = z.enum([
  "new",
  "researching",
  "contacted",
  "follow-up",
  "qualified",
  "not-interested",
]);

export const companySortSchema = z.enum(["relevance", "name", "contactCount"]);
export const contactSortSchema = z.enum(["name", "title", "country"]);
export const sortOrderSchema = z.enum(["asc", "desc"]);

/**
 * Booleans arrive as query-string values, and `Boolean("false")` is `true`.
 * `z.coerce.boolean()` therefore silently turns "false" into an enabled filter,
 * so every boolean input goes through this explicit parser instead.
 */
export const booleanish = z
  .union([z.boolean(), z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
  .transform((value) => value === true || value === "true" || value === "1");

export const companyFiltersSchema = z
  .object({
    industry: z.string().max(120).optional(),
    country: z.string().max(120).optional(),
    city: z.string().max(120).optional(),
    companySize: z.string().max(60).optional(),
    hasContacts: booleanish.optional(),
    hasDomain: booleanish.optional(),
  })
  .strict();

export const contactFiltersSchema = z
  .object({
    designation: z.string().max(160).optional(),
    department: z.string().max(160).optional(),
    seniority: z.string().max(80).optional(),
    country: z.string().max(120).optional(),
    city: z.string().max(120).optional(),
    hasEmail: booleanish.optional(),
    hasLinkedin: booleanish.optional(),
    /**
     * Comma-separated association categories (`high_confidence,plausible`). A
     * query string carries no arrays, and a single repeated-key form would need
     * `extractFilters` to invent one, so the list travels as text and is parsed
     * by `parseAssociationFilter` (which ignores unknown names rather than
     * failing a whole page request over a typo).
     */
    association: z.string().max(160).optional(),
  })
  .strict();

/** The four association categories, as the API accepts and returns them. */
export const associationCategorySchema = z.enum(["high_confidence", "plausible", "unresolved", "conflicting"]);

/**
 * Every reason the indexer can record, as literals.
 *
 * Declared here (not as a free-form string) so a reason the model knows about
 * cannot silently fail response validation — the exhaustiveness assertion below
 * fails to compile instead.
 */
export const associationReasonSchema = z.enum([
  "row_carries_employer_identity",
  "email_domain_matches_assigned_company",
  "email_domain_matches_other_company_of_same_name",
  "email_domain_outside_name_family",
  "email_domain_conflicts_with_row_identity",
  "unique_name",
  "country_supports_assigned_company",
  "country_identifies_company",
  "country_points_to_other_company_of_same_name",
  "single_strong_candidate",
  "several_candidates_remain",
  "no_credible_candidate",
]);

/** `true` only while the list above names every `AssociationReason`. */
export type AssociationReasonsAreExhaustive =
  [
    Exclude<AssociationReason, z.infer<typeof associationReasonSchema>>,
    Exclude<z.infer<typeof associationReasonSchema>, AssociationReason>,
  ] extends [never, never]
    ? true
    : {
        missing: Exclude<AssociationReason, z.infer<typeof associationReasonSchema>>;
        extra: Exclude<z.infer<typeof associationReasonSchema>, AssociationReason>;
      };

export const ASSOCIATION_REASONS_ARE_EXHAUSTIVE: AssociationReasonsAreExhaustive = true;

/** Wire contact filter object → the model's filter shape. */
export function toContactFilters(filters?: z.infer<typeof contactFiltersSchema>): ContactFilters | undefined {
  if (!filters) return undefined;
  const association = parseAssociationFilter(filters.association);
  return association ? { ...filters, association } : { ...filters, association: undefined };
}

/** Parse a comma-separated category filter; unknown names are ignored. */
export function parseAssociationFilter(value: unknown): AssociationCategory[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parts = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is AssociationCategory => (ASSOCIATION_CATEGORIES as readonly string[]).includes(part));
  return parts.length ? [...new Set(parts)] : undefined;
}

/* -------------------------------------------------------------------------- */
/* Bounded pagination                                                         */
/* -------------------------------------------------------------------------- */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_EXPORT_ROWS = 50_000;

export const pageParamsSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

/** Filters travel as a compact query string; unknown keys are ignored. */
export function filtersToQuery(filters: Record<string, unknown> | undefined): string {
  if (!filters) return "";
  const parts = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.join("&");
}

export function queryToFilters(search: URLSearchParams): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of search.entries()) {
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Request schemas                                                            */
/* -------------------------------------------------------------------------- */

export const companySearchRequestSchema = z.object({
  q: z.string().trim().min(1, "A search term is required").max(200),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: companySortSchema.default("relevance"),
  order: sortOrderSchema.default("desc"),
  fuzzy: booleanish.default(true),    resultBudget: z.coerce.number().int().min(1).max(2000).default(400),
  filters: companyFiltersSchema.optional(),
});

export const companyContactsRequestSchema = pageParamsSchema.extend({
  sort: contactSortSchema.default("name"),
  order: sortOrderSchema.default("asc"),
  filters: contactFiltersSchema.optional(),
});

export const saveLeadRequestSchema = z.object({
  kind: z.enum(["company", "contact"]),
  targetId: z.string().min(1).max(64),
  /** Snapshot fields sent by the client so the lead stays readable offline. */
  snapshot: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
  status: leadStatusSchema.default("new"),
  tags: z.array(z.string().max(40)).max(20).default([]),
  datasetVersion: z.string().max(64),
});

export const updateLeadRequestSchema = z.object({
  status: leadStatusSchema.optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  addNote: z.string().max(2000).optional(),
  removeNoteAt: z.string().optional(),
});

export const savedSearchRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().min(1).max(200),
  filters: companyFiltersSchema.default({}),
  sort: companySortSchema.default("relevance"),
  order: sortOrderSchema.default("desc"),
});

export const settingsRequestSchema = z
  .object({
    theme: z.enum(["light", "dark", "system"]).optional(),
    pageSize: z.number().int().min(5).max(MAX_PAGE_SIZE).optional(),
    fuzzySearch: z.boolean().optional(),
    defaultSort: companySortSchema.optional(),
    defaultOrder: sortOrderSchema.optional(),
    resultBudget: z.number().int().min(100).max(2000).optional(),
    cacheEnabled: z.boolean().optional(),
    cacheMaxEntries: z.number().int().min(0).max(5000).optional(),
    cacheTtlMinutes: z.number().int().min(1).max(1440).optional(),
    edgeCacheEnabled: z.boolean().optional(),
    retainContactFieldsInCache: z.boolean().optional(),
  })
  .strict();

export const exportRequestSchema = z.object({
  kind: z.enum(["contacts", "companies", "leads"]),
  companyId: z.string().max(64).optional(),
  contactIds: z.array(z.string().max(64)).max(MAX_EXPORT_ROWS).optional(),
  companyIds: z.array(z.string().max(64)).max(MAX_EXPORT_ROWS).optional(),
  leadIds: z.array(z.string().max(64)).max(MAX_EXPORT_ROWS).optional(),
  columns: z.array(z.string().max(40)).min(1).max(40),
  filters: contactFiltersSchema.optional(),
});

export const datasetActivateRequestSchema = z.object({
  version: z.string().min(1).max(64),
  confirm: z.literal(true),
});

export const activityRequestSchema = z.object({
  kind: z.enum(["search", "company-view", "lead-saved", "export", "dataset"]),
  label: z.string().max(200),
  detail: z.string().max(400).optional(),
  href: z.string().max(300).optional(),
});

/* -------------------------------------------------------------------------- */
/* Response schemas (used by the frontend to validate what it receives)        */
/* -------------------------------------------------------------------------- */

const sourceRefSchema = z.object({ source: z.string(), row: z.number().int().nonnegative() });

/**
 * Association shapes are declared before any schema that embeds them: a zod
 * schema is built at module-evaluation time, so referencing a `const` declared
 * further down would be a temporal-dead-zone crash rather than a lazy lookup.
 */
export const associationCountsSchema = z.object({
  highConfidence: z.number().int().nonnegative(),
  plausible: z.number().int().nonnegative(),
  conflicting: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const associationRecordSchema = z.object({
  category: associationCategorySchema,
  reason: associationReasonSchema,
  evidence: z.object({
    name: z.enum(["unique", "shared"]),
    domain: z.enum(["match", "sibling", "outside_family", "public_provider", "absent", "ambiguous"]),
    country: z.enum(["selects", "supports", "differ", "ambiguous", "absent"]),
    rowIdentity: z.boolean(),
    candidates: z.number().int().nonnegative(),
  }),
  candidateCompanyIds: z.array(z.string()).max(50).optional(),
  /**
   * How many candidates there really were when the index stored only a bounded
   * sample of ids (`MAX_CANDIDATE_IDS`). Absent on records written before the cap,
   * where the id list was complete.
   */
  candidateCount: z.number().int().nonnegative().optional(),
});

export const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  normalizedName: z.string(),
  aliases: z.array(z.string()).optional(),
  domain: z.string().optional(),
  website: z.string().optional(),
  linkedinUrl: z.string().optional(),
  industry: z.string().optional(),
  subIndustry: z.string().optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  companySize: z.string().optional(),
  revenue: z.string().optional(),
  contactCount: z.number().int().nonnegative(),
  sources: z.array(sourceRefSchema),
  ambiguous: z.boolean().optional(),
  associations: associationCountsSchema.optional(),
  /**
   * Every source column of the record, verbatim and in full (long values included).
   * Part of the contract on purpose: the response is parsed with Zod, which strips
   * unknown keys, so a field the client is meant to display has to be declared
   * here or it silently disappears.
   */
  attributes: z.record(z.string(), z.string()).optional(),
});

export const contactSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  fullName: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  designation: z.string().optional(),
  seniority: z.string().optional(),
  department: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  /** Every source column, verbatim and in full (see `companySchema.attributes`). */
  attributes: z.record(z.string(), z.string()).optional(),
  source: sourceRefSchema,
  association: associationRecordSchema.optional(),
});

/** A contact preserved without an employer, plus the name it claimed. */
export const unassignedContactSchema = contactSchema.extend({
  claimedCompanyName: z.string(),
  claimedNormalizedName: z.string(),
  association: associationRecordSchema,
});

export const pageInfoSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int().nullable(),
  totalIsLowerBound: z.boolean(),
  hasMore: z.boolean(),
});

export const companySearchHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  matchCategory: z.enum(["exact", "alias", "prefix", "typo", "similar"]),
  relevance: z.number(),
  possibleMatch: z.boolean(),
  matchedTerms: z.array(z.string()),
  domain: z.string().optional(),
  website: z.string().optional(),
  linkedinUrl: z.string().optional(),
  industry: z.string().optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  companySize: z.string().optional(),
  revenue: z.string().optional(),
  contactCount: z.number().int(),
  multiSource: z.boolean(),
});

/** Person-search request: one query, one page. Mirrors the company request. */
export const contactSearchRequestSchema = z.object({
  q: z.string().min(1, "Enter a name to search for.").max(200),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** One person result, with the employer evidence it was hydrated with. */
export const contactSearchHitSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  title: z.string().nullable(),
  designation: z.string().nullable(),
  seniority: z.string().nullable(),
  department: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  association: z.string().nullable(),
  employerUnconfirmed: z.boolean(),
  relevance: z.number(),
  matchedTerms: z.array(z.string()),
});

export const contactSearchResponseSchema = z.object({
  query: z.string(),
  normalizedQuery: z.string(),
  correctedQuery: z.string().nullable(),
  notice: z.string().nullable(),
  hits: z.array(contactSearchHitSchema),
  matchedIds: z.number().int(),
  notHydrated: z.number().int(),
  page: pageInfoSchema,
  datasetVersion: z.string(),
  tookMs: z.number(),
});

export const companySearchResponseSchema = z.object({
  query: z.string(),
  normalizedQuery: z.string(),
  correctedQuery: z.string().nullable(),
  notice: z.string().nullable(),
  hits: z.array(companySearchHitSchema),
  page: pageInfoSchema,
  datasetVersion: z.string(),
  tookMs: z.number(),
  retrieval: z.object({
    exact: z.number().int(),
    prefix: z.number().int(),
    token: z.number().int(),
    trigram: z.number().int(),
    scored: z.number().int(),
    cached: z.boolean(),
    candidates: z.number().int(),
    truncated: z.number().int(),
    hydrationPasses: z.number().int(),
    hydrateBudget: z.number().int(),
    budgetLimited: z.boolean(),
    fuzzyDeferred: z.boolean(),
    fuzzyRecovered: z.boolean(),
    /**
     * Set when the adaptive ladder stopped climbing because every candidate had
     * been hydrated (so a larger partition budget could not add a row).
     */
    ladderStopped: z.literal("candidates_exhausted").optional(),
    r2: z
      .object({
        objectsRead: z.number().int(),
        bytesRead: z.number().int(),
        shardGets: z.number().int(),
        partitionGets: z.number().int(),
        shardRequests: z.number().int(),
        partitionRequests: z.number().int(),
        cacheHits: z.number().int(),
        cacheMisses: z.number().int(),
      })
      .optional(),
  }),
});

const facetBucketSchema = z.object({ value: z.string(), count: z.number().int() });

export const companyDetailResponseSchema = z.object({
  company: companySchema,
  facets: z.object({
    designations: z.array(facetBucketSchema),
    departments: z.array(facetBucketSchema),
    seniority: z.array(facetBucketSchema),
    countries: z.array(facetBucketSchema),
    cities: z.array(facetBucketSchema),
    emailAvailable: z.number().int(),
    linkedinAvailable: z.number().int(),
  }),
  datasetVersion: z.string(),
});

export const contactPageResponseSchema = z.object({
  companyId: z.string().nullable(),
  contacts: z.array(contactSchema),
  page: pageInfoSchema,
  datasetVersion: z.string(),
  associations: associationCountsSchema.nullable().optional(),
});

export const unassignedContactsResponseSchema = z.object({
  companyId: z.string(),
  companyName: z.string().nullable(),
  contacts: z.array(unassignedContactSchema),
  page: pageInfoSchema,
  datasetVersion: z.string(),
  totals: z.object({ unresolved: z.number().int().nonnegative(), conflicting: z.number().int().nonnegative() }),
});

export const contactDetailResponseSchema = z.object({
  contact: contactSchema,
  company: companySchema.nullable(),
  /** True when the contact is preserved without an employer (format v3+). */
  unassigned: z.boolean().optional(),
  datasetVersion: z.string(),
});

export const savedLeadSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("company"),
    companyId: z.string(),
    name: z.string(),
    industry: z.string().optional(),
    country: z.string().optional(),
    contactCount: z.number().int(),
    status: leadStatusSchema,
    tags: z.array(z.string()),
    notes: z.array(z.object({ at: z.string(), text: z.string() })),
    savedAt: z.string(),
    updatedAt: z.string(),
    datasetVersion: z.string(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("contact"),
    contactId: z.string(),
    companyId: z.string(),
    companyName: z.string(),
    fullName: z.string(),
    title: z.string().optional(),
    email: z.string().optional(),
    linkedinUrl: z.string().optional(),
    status: leadStatusSchema,
    tags: z.array(z.string()),
    notes: z.array(z.object({ at: z.string(), text: z.string() })),
    savedAt: z.string(),
    updatedAt: z.string(),
    datasetVersion: z.string(),
  }),
]);

export const savedSearchSchema = z.object({
  id: z.string(),
  name: z.string(),
  query: z.string(),
  filters: companyFiltersSchema,
  sort: companySortSchema,
  order: sortOrderSchema,
  createdAt: z.string(),
  lastRunAt: z.string().nullable(),
  runCount: z.number().int(),
});

export const userSettingsSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
  pageSize: z.number().int(),
  fuzzySearch: z.boolean(),
  defaultSort: companySortSchema,
  defaultOrder: sortOrderSchema,
  resultBudget: z.number().int(),
  cacheEnabled: z.boolean(),
  cacheMaxEntries: z.number().int(),
  cacheTtlMinutes: z.number().int(),
  edgeCacheEnabled: z.boolean(),
  retainContactFieldsInCache: z.boolean(),
  updatedAt: z.string(),
});

export const exportJobSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  rowCount: z.number().int(),
  bytes: z.number().int(),
  objectKey: z.string().optional(),
  downloadUrl: z.string().optional(),
  filename: z.string(),
  error: z.string().optional(),
  truncated: z.boolean(),
});

export const indexingCountersSchema = z.object({
  rowsRead: z.number().int(),
  rowsRejected: z.number().int(),
  uniqueCompanies: z.number().int(),
  uniqueContacts: z.number().int(),
  duplicateRowsResolved: z.number().int(),
  duplicateCompaniesResolved: z.number().int(),
  ambiguousCompanies: z.number().int(),
  recordsMissingCompanyId: z.number().int(),
  perSource: z.record(
    z.string(),
    z.object({
      rowsRead: z.number().int(),
      rowsRejected: z.number().int(),
      companies: z.number().int(),
      contacts: z.number().int(),
    }),
  ),
});

export const datasetStatusResponseSchema = z.object({
  indexed: z.boolean(),
  activeVersion: z.string().nullable(),
  previousVersion: z.string().nullable(),
  message: z.string(),
  bucket: z.string(),
  bucketOk: z.boolean(),
  bucketError: z.string().optional(),
  sources: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      sizeBytes: z.number().nullable(),
      lastModified: z.string().nullable(),
      verified: z.boolean(),
      error: z.string().optional(),
    }),
  ),
  versions: z.array(
    z.object({
      version: z.string(),
      state: z.enum(["indexing", "staging", "validated", "active", "retired"]),
      createdAt: z.string(),
      completedAt: z.string().optional(),
      normalizerVersion: z.number().int(),
      indexFormatVersion: z.number().int(),
      counters: indexingCountersSchema,
      bytes: z.number().int(),
      objectCount: z.number().int(),
      validationPassed: z.boolean(),
      notes: z.string().optional(),
    }),
  ),
  lastIndexedAt: z.string().nullable(),
  indexing: z
    .object({
      version: z.string(),
      stage: z.enum([
        "idle",
        "profiling",
        "pass1-partition",
        "pass2-merge",
        "indexing",
        "validating",
        "uploading",
        "completed",
        "failed",
      ]),
      startedAt: z.string(),
      updatedAt: z.string(),
      progress: z.number().nullable(),
      rowsRead: z.number().int(),
      rowsPerSecond: z.number().nullable(),
      etaSeconds: z.number().nullable(),
      message: z.string(),
      host: z.string(),
    })
    .nullable(),
  dataOrigin: z.enum(["r2", "sample"]),
});

/** Bounded listing of `raw/`, requested only by the Dataset Management page. */
export const datasetSourcesResponseSchema = z.object({
  bucket: z.string(),
  objects: z.array(
    z.object({
      key: z.string(),
      sizeBytes: z.number().nullable(),
      lastModified: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
  checkedAt: z.string(),
  error: z.string().optional(),
});

export const datasetValidationResponseSchema = z.object({
  version: z.string(),
  passed: z.boolean(),
  checkedAt: z.string(),
  issues: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      code: z.string(),
      message: z.string(),
      count: z.number().int().optional(),
    }),
  ),
  verifiedObjects: z.number().int(),
  missingObjects: z.array(z.string()),
});

export const activityEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(["search", "company-view", "lead-saved", "export", "dataset"]),
  label: z.string(),
  detail: z.string().optional(),
  href: z.string().optional(),
});

export const apiErrorSchema = z.object({
  error: {
    code: z.enum([
      "unauthorized",
      "forbidden",
      "invalid_request",
      "not_found",
      "dataset_unavailable",
      "rate_limited",
      "internal",
    ]),
    message: z.string(),
    /** Request id echoed to the client so a failure can be correlated. */
    requestId: z.string().optional(),
  },
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type CompanySearchRequest = z.infer<typeof companySearchRequestSchema>;
export type CompanyContactsRequest = z.infer<typeof companyContactsRequestSchema>;
export type SaveLeadRequest = z.infer<typeof saveLeadRequestSchema>;
export type UpdateLeadRequest = z.infer<typeof updateLeadRequestSchema>;
export type SavedSearchRequest = z.infer<typeof savedSearchRequestSchema>;
export type SettingsRequest = z.infer<typeof settingsRequestSchema>;
export type ExportRequestBody = z.infer<typeof exportRequestSchema>;
export type ActivityRequest = z.infer<typeof activityRequestSchema>;
