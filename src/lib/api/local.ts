/**
 * Local API adapter — PREVIEW ONLY.
 *
 * Implements the same `ApiClient` contract as the Cloudflare Worker adapter, but
 * against the deterministic synthetic sample dataset. Saved leads / searches /
 * settings live in `localStorage` here; in production those are R2 objects
 * written through the Worker.
 *
 * This module is never imported by the Worker, and the dataset it serves is
 * always flagged `dataOrigin: "sample"` so the UI can label it.
 */

import type {
  ActivityEntry,
  Company,
  CompanyDetailResponse,
  DatasetStats,
  CompanySearchResponse,
  Contact,
  ContactPageResponse,
  ContactSearchHit,
  ContactSearchResponse,
  ContactSortField,
  DatasetSourcesResponse,
  DatasetStatusResponse,
  DatasetValidationResponse,
  ExportJob,
  SavedLead,
  SavedSearch,
  SortOrder,
  UnassignedContact,
  UnassignedContactsResponse,
  UserSettings,
} from "@/shared/models";
import type { AssociationCategory } from "@/shared/association";
import { DEFAULT_SETTINGS } from "@/shared/models";
import { LEAD_STATUSES } from "@/shared/models";
import { leadId } from "@/shared/hash";
import { normalizeEmail, normalizeQuery } from "@/shared/normalize";
import { searchCompanies } from "@/shared/search/engine";
import { LocalCandidateSource } from "@/shared/search/local-index";
import { EXPORT_COLUMN_HEADERS, exportFilename, toCsv, type CsvColumn } from "@/shared/csv";
import { DEFAULT_PAGE_SIZE, MAX_EXPORT_ROWS, MAX_PAGE_SIZE, toContactFilters } from "@/shared/api-contract";
import {
  SAMPLE_DATASET_LABEL,
  SAMPLE_DATASET_VERSION,
  buildFacets,
  contactMatchesFilters,
  getSampleDataset,
} from "./sample-dataset";
import type {
  ApiClient,
  CompanySearchParams,
  ContactQueryParams,
  ContactSearchParams,
  HealthResponse,
  LeadListResponse,
  SaveLeadInput,
  UnassignedQueryParams,
  UpdateLeadInput,
} from "./types";
import type { ExportRequestBody, SavedSearchRequest, SettingsRequest } from "@/shared/api-contract";

const LS_PREFIX = "companyintel.sample.";

function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeStore(key: string, value: unknown): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable (private mode): the UI keeps working in memory.
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export class LocalApiClient implements ApiClient {
  readonly mode = "local" as const;

  private readonly dataset = getSampleDataset();
  private readonly source = new LocalCandidateSource(getSampleDataset().companies, SAMPLE_DATASET_VERSION);
  private readonly companyById = new Map<string, Company>();
  private readonly contactById = new Map<string, Contact>();

  constructor() {
    for (const company of this.dataset.companies) this.companyById.set(company.id, company);
    for (const contact of this.dataset.contacts) this.contactById.set(contact.id, contact);
  }

  /* ------------------------------ meta ---------------------------------- */

  async health(): Promise<HealthResponse> {
    return {
      ok: true,
      service: "companyintel-local",
      mode: "local",
      version: "0.1.0",
      datasetVersion: SAMPLE_DATASET_VERSION,
      time: nowIso(),
    };
  }

  /**
   * Honest dataset status: nothing is indexed in R2 in preview mode, so
   * `indexed` is false and the dashboard shows a clear "not indexed" state.
   * The sample dataset is reported separately and labelled.
   */
  async datasetStatus(): Promise<DatasetStatusResponse> {
    return {
      indexed: false,
      activeVersion: null,
      previousVersion: null,
      message: `No dataset indexed in R2. ${SAMPLE_DATASET_LABEL} is active for interface preview only.`,
      bucket: "company-intel-data",
      bucketOk: false,
      // Deliberately does not name the Worker's R2 binding: this string is
      // compiled into the client bundle, and server-side identifiers do not
      // belong there (tests/frontend-secrets.test.ts scans `dist/` for them).
      // The operator-facing hint carries the identifier instead — see
      // docs/configuration.md and the Dataset page of the deployed Worker.
      bucketError:
        "Preview mode: the browser cannot reach the private R2 bucket. Deploy the Worker (its R2 binding is what can read the bucket) to verify the object store.",
      // The keys are the ones verified against the real bucket; the browser still
      // cannot read them, so nothing here is claimed as verified.
      sources: ([
        { id: "csv1", key: "raw/file1.csv", role: "organizations" as const },
        { id: "csv2", key: "raw/file2.csv", role: "people" as const },
      ]).map((source) => ({
        ...source,
        sizeBytes: null,
        lastModified: null,
        verified: false,
        error: "Not read here — the browser cannot reach the private bucket. Open the Dataset page on the deployed Worker for real sizes.",
      })),
      versions: [],
      lastIndexedAt: null,
      indexing: null,
      dataOrigin: "sample",
    };
  }

  /**
   * The preview has no bucket to list, so it reports no objects and says why.
   * It never invents filenames or sizes that were not read from R2.
   */
  async datasetSources(): Promise<DatasetSourcesResponse> {
    return {
      bucket: "company-intel-data",
      objects: [],
      truncated: false,
      checkedAt: new Date().toISOString(),
      error: "Preview mode: the browser cannot list the private R2 bucket. Open the Dataset page on the deployed Worker to see the real raw/ objects.",
    };
  }

  /** Statistics computed from the sample dataset itself (never fabricated). */
  async datasetStats(): Promise<DatasetStats | null> {
    const { companies, contacts } = this.dataset;
    const count = (pick: (value: never) => string | undefined, source: unknown[]) => {
      const map = new Map<string, number>();
      for (const item of source) {
        const value = pick(item as never);
        if (value) map.set(value, (map.get(value) ?? 0) + 1);
      }
      return [...map.entries()]
        .map(([value, n]) => ({ value, count: n }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    };
    return {
      version: SAMPLE_DATASET_VERSION,
      generatedAt: nowIso(),
      companies: companies.length,
      contacts: contacts.length,
      companiesByIndustry: count((c: Company) => c.industry, companies),
      companiesByCountry: count((c: Company) => c.country, companies),
      companiesBySize: count((c: Company) => c.companySize, companies),
      contactsByDesignation: count((c: Contact) => c.designation, contacts),
      contactsByDepartment: count((c: Contact) => c.department, contacts),
      contactsBySeniority: count((c: Contact) => c.seniority, contacts),
      contactCoverage: {
        email: contacts.filter((c) => c.email).length,
        linkedin: contacts.filter((c) => c.linkedinUrl).length,
        phone: contacts.filter((c) => c.phone).length,
        neither: contacts.filter((c) => !c.email && !c.linkedinUrl && !c.phone).length,
      },
    };
  }

  async validateDataset(): Promise<DatasetValidationResponse> {
    return {
      version: SAMPLE_DATASET_VERSION,
      passed: false,
      checkedAt: nowIso(),
      issues: [
        {
          severity: "warning",
          code: "sample_mode",
          message: "Validation requires the Cloudflare Worker with the R2 binding. No R2 dataset is reachable in preview mode.",
        },
      ],
      verifiedObjects: 0,
      missingObjects: [],
    };
  }

  async activateDataset(): Promise<{ activated: boolean; activeVersion: string }> {
    throw new Error("Dataset activation requires the Cloudflare Worker API and a validated R2 dataset.");
  }

  /* ---------------------------- search ---------------------------------- */

  async searchCompanies(params: CompanySearchParams): Promise<CompanySearchResponse> {
    const response = await searchCompanies(this.source, params.query, {
      page: params.page,
      pageSize: params.pageSize,
      sort: params.sort,
      order: params.order,
      fuzzy: params.fuzzy ?? true,
      resultBudget: params.resultBudget,
      filters: params.filters,
    });

    // Enrich the ranked hits with the company fields the search engine does not
    // carry (website, LinkedIn, size, revenue) without changing the ranking.
    const hits = response.hits.map((hit) => {
      const company = this.companyById.get(hit.id);
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

    return { ...response, hits };
  }

  async getCompany(id: string): Promise<CompanyDetailResponse> {
    const company = this.companyById.get(id);
    if (!company) throw new Error(`Company ${id} was not found in the active dataset.`);
    const contacts = this.dataset.contactsByCompany.get(id) ?? [];
    return { company, facets: buildFacets(contacts), datasetVersion: SAMPLE_DATASET_VERSION };
  }

  async getCompanyContacts(companyId: string, params: ContactQueryParams = {}): Promise<ContactPageResponse> {
    const all = this.dataset.contactsByCompany.get(companyId) ?? [];
    return this.paginateContacts(all, companyId, params);
  }

  async listContacts(params: ContactQueryParams = {}): Promise<ContactPageResponse> {
    const pool = params.companyIds?.length
      ? params.companyIds.flatMap((id) => this.dataset.contactsByCompany.get(id) ?? [])
      : this.dataset.contacts;
    return this.paginateContacts(pool, params.companyId ?? null, params);
  }

  /**
   * Person search over the in-memory sample dataset.
   *
   * The sample dataset is small enough to scan, and that is deliberate: this
   * adapter exists to keep the preview usable when no index is configured, and it
   * labels its data `sample` so nothing here can be mistaken for a real hit. The
   * production path (`WorkerApiClient.searchContacts`) goes through the sharded
   * contact index instead.
   */
  async searchContacts(params: ContactSearchParams): Promise<ContactSearchResponse> {
    const started = Date.now();
    const normalized = normalizeQuery(params.query).replace(/\s+/g, " ").trim();
    const pageSize = Math.min(Math.max(params.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(params.page ?? 1, 1);

    const pool: Contact[] = [...this.dataset.contacts];
    for (const group of this.dataset.unassignedByCompany.values()) pool.push(...group);

    const ranked: { contact: Contact; score: number; matched: string[] }[] = [];
    for (const contact of pool) {
      const key = normalizeQuery(contact.fullName ?? "").replace(/\s+/g, " ").trim();
      if (!key) continue;
      const terms = normalized.split(" ").filter(Boolean);
      const keyTokens = key.split(" ").filter(Boolean);
      const matched = terms.filter((term) => keyTokens.some((token) => token.startsWith(term)));
      if (!matched.length) continue;
      let score = 300 * (matched.length / terms.length);
      if (key === normalized) score += 1000;
      else if (key.startsWith(normalized)) score += 400;
      ranked.push({ contact, score, matched });
    }
    ranked.sort((a, b) => b.score - a.score || a.contact.fullName.localeCompare(b.contact.fullName));

    const start = (page - 1) * pageSize;
    const hits: ContactSearchHit[] = ranked.slice(start, start + pageSize).map(({ contact, score, matched }) => {
      const company = contact.companyId ? this.companyById.get(contact.companyId) : undefined;
      const claimed = (contact as Partial<UnassignedContact>).claimedCompanyName ?? null;
      const association = contact.association?.category ?? (company ? null : "unresolved");
      return {
        id: contact.id,
        fullName: contact.fullName,
        firstName: contact.firstName ?? null,
        lastName: contact.lastName ?? null,
        title: contact.title ?? null,
        designation: contact.designation ?? null,
        seniority: contact.seniority ?? null,
        department: contact.department ?? null,
        email: contact.email ?? null,
        phone: contact.phone ?? null,
        linkedinUrl: contact.linkedinUrl ?? null,
        country: contact.country ?? null,
        city: contact.city ?? null,
        companyId: company?.id ?? null,
        companyName: company?.name ?? claimed,
        association,
        // Only `high_confidence` evidence counts as a confirmed employer; anything
        // else (including a v2 index with no category) is shown as unconfirmed.
        employerUnconfirmed: association !== "high_confidence",
        relevance: score,
        matchedTerms: matched,
      };
    });

    return {
      query: params.query,
      normalizedQuery: normalized,
      correctedQuery: null,
      notice: hits.length ? null : "We did not find anything related to this company or contact in our database.",
      hits,
      matchedIds: ranked.length,
      notHydrated: 0,
      page: { page, pageSize, total: ranked.length, totalIsLowerBound: false, hasMore: start + pageSize < ranked.length },
      datasetVersion: SAMPLE_DATASET_VERSION,
      tookMs: Date.now() - started,
    };
  }

  /**
   * The preview's preserved contacts. Keyed directly by company id because the
   * sample dataset is built in memory; production addresses them by the company's
   * Pass 1 partition (see `unassignedPartitionKey`).
   */
  async getCompanyUnassigned(companyId: string, params: UnassignedQueryParams = {}): Promise<UnassignedContactsResponse> {
    const company = this.companyById.get(companyId);
    if (!company) throw new Error(`Company ${companyId} was not found in the active dataset.`);
    const wanted = params.category?.length ? params.category : (["unresolved"] as AssociationCategory[]);
    const matching = (this.dataset.unassignedByCompany.get(companyId) ?? []).filter((contact) =>
      wanted.includes(contact.association.category),
    );
    const pageSize = Math.min(Math.max(params.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(params.page ?? 1, 1);
    const start = (page - 1) * pageSize;
    return {
      companyId,
      companyName: company.name,
      contacts: matching.slice(start, start + pageSize),
      page: {
        page,
        pageSize,
        total: matching.length,
        totalIsLowerBound: false,
        hasMore: start + pageSize < matching.length,
      },
      datasetVersion: SAMPLE_DATASET_VERSION,
      totals: { unresolved: matching.length, conflicting: company.associations?.conflicting ?? 0 },
    };
  }

  private paginateContacts(
    pool: Contact[],
    companyId: string | null,
    params: ContactQueryParams,
  ): ContactPageResponse {
    const pageSize = Math.min(Math.max(params.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(params.page ?? 1, 1);
    const sort: ContactSortField = params.sort ?? "name";
    const order: SortOrder = params.order ?? "asc";

    const filtered = pool.filter((contact) => contactMatchesFilters(contact, params.filters));
    const sorted = [...filtered].sort((a, b) => {
      const pick = (c: Contact) =>
        sort === "name" ? c.fullName : sort === "title" ? c.title ?? "" : c.country ?? "";
      const delta = pick(a).localeCompare(pick(b));
      return order === "asc" ? delta : -delta;
    });

    const start = (page - 1) * pageSize;
    const slice = sorted.slice(start, start + pageSize);
    return {
      companyId,
      contacts: slice,
      page: {
        page,
        pageSize,
        total: sorted.length,
        totalIsLowerBound: false,
        hasMore: start + pageSize < sorted.length,
      },
      datasetVersion: SAMPLE_DATASET_VERSION,
    };
  }

  async getContact(id: string): Promise<{ contact: Contact; companyName: string | null; companyId: string | null }> {
    const contact = this.contactById.get(id);
    if (!contact) throw new Error(`Contact ${id} was not found in the active dataset.`);
    const company = this.companyById.get(contact.companyId);
    return { contact, companyName: company?.name ?? null, companyId: company?.id ?? null };
  }

  /* ----------------------------- leads ---------------------------------- */

  private readLeads(): SavedLead[] {
    return readStore<SavedLead[]>("leads", []);
  }

  private writeLeads(leads: SavedLead[]): void {
    writeStore("leads", leads);
  }

  async listLeads(): Promise<LeadListResponse> {
    const leads = this.readLeads();
    return { leads, total: leads.length };
  }

  async saveLead(input: SaveLeadInput): Promise<SavedLead> {
    const leads = this.readLeads();
    const id = leadId(input.kind, input.targetId);
    const existing = leads.find((lead) => lead.id === id);
    if (existing) return existing;

    const snapshot = input.snapshot ?? {};
    const at = nowIso();
    const base = {
      id,
      status: input.status ?? "new",
      tags: input.tags ?? [],
      notes: [],
      savedAt: at,
      updatedAt: at,
      datasetVersion: input.datasetVersion,
    };

    let lead: SavedLead;
    if (input.kind === "company") {
      assertFound(this.companyById.get(input.targetId), "company", input.targetId);
      lead = {
        ...base,
        kind: "company",
        companyId: input.targetId,
        name: String(snapshot.name ?? this.companyById.get(input.targetId)!.name),
        industry: snapshot.industry ? String(snapshot.industry) : this.companyById.get(input.targetId)!.industry,
        country: snapshot.country ? String(snapshot.country) : this.companyById.get(input.targetId)!.country,
        contactCount: Number(snapshot.contactCount ?? this.companyById.get(input.targetId)!.contactCount),
      };
    } else {
      assertFound(this.contactById.get(input.targetId), "contact", input.targetId);
      const contact = this.contactById.get(input.targetId)!;
      const company = this.companyById.get(contact.companyId);
      lead = {
        ...base,
        kind: "contact",
        contactId: contact.id,
        companyId: contact.companyId,
        companyName: String(snapshot.companyName ?? company?.name ?? "Unknown company"),
        fullName: contact.fullName,
        title: contact.title,
        email: contact.email ? normalizeEmail(contact.email) ?? undefined : undefined,
        linkedinUrl: contact.linkedinUrl,
      };
    }

    this.writeLeads([lead, ...leads]);
    return lead;
  }

  async updateLead(id: string, input: UpdateLeadInput): Promise<SavedLead> {
    const leads = this.readLeads();
    const index = leads.findIndex((lead) => lead.id === id);
    if (index === -1) throw new Error(`Lead ${id} was not found.`);
    const current = leads[index];
    if (input.status && !LEAD_STATUSES.includes(input.status)) {
      throw new Error(`Unknown lead status: ${input.status}`);
    }
    const notes = [...current.notes];
    if (input.addNote) notes.push({ at: nowIso(), text: input.addNote });
    const updated: SavedLead = {
      ...current,
      status: input.status ?? current.status,
      tags: input.tags ?? current.tags,
      notes: input.removeNoteAt ? notes.filter((note) => note.at !== input.removeNoteAt) : notes,
      updatedAt: nowIso(),
    };
    leads[index] = updated;
    this.writeLeads(leads);
    return updated;
  }

  async deleteLead(id: string): Promise<void> {
    this.writeLeads(this.readLeads().filter((lead) => lead.id !== id));
  }

  /* -------------------------- saved searches ---------------------------- */

  async listSavedSearches(): Promise<SavedSearch[]> {
    return readStore<SavedSearch[]>("saved-searches", []);
  }

  async createSavedSearch(input: SavedSearchRequest): Promise<SavedSearch> {
    const searches = readStore<SavedSearch[]>("saved-searches", []);
    const search: SavedSearch = {
      id: `ss_${Math.random().toString(36).slice(2, 10)}`,
      name: input.name,
      query: input.query,
      filters: input.filters ?? {},
      sort: input.sort ?? "relevance",
      order: input.order ?? "desc",
      createdAt: nowIso(),
      lastRunAt: null,
      runCount: 0,
    };
    writeStore("saved-searches", [search, ...searches]);
    return search;
  }

  async deleteSavedSearch(id: string): Promise<void> {
    writeStore(
      "saved-searches",
      (await this.listSavedSearches()).filter((search) => search.id !== id),
    );
  }

  async markSavedSearchRun(id: string): Promise<SavedSearch> {
    const searches = await this.listSavedSearches();
    const index = searches.findIndex((search) => search.id === id);
    if (index === -1) throw new Error(`Saved search ${id} was not found.`);
    const updated = { ...searches[index], lastRunAt: nowIso(), runCount: searches[index].runCount + 1 };
    searches[index] = updated;
    writeStore("saved-searches", searches);
    return updated;
  }

  /* ----------------------------- settings ------------------------------- */

  async getSettings(): Promise<UserSettings> {
    return { ...DEFAULT_SETTINGS, ...readStore<Partial<UserSettings>>("settings", {}) };
  }

  async updateSettings(input: SettingsRequest): Promise<UserSettings> {
    const next = { ...(await this.getSettings()), ...input, updatedAt: nowIso() };
    writeStore("settings", next);
    return next;
  }

  /* ----------------------------- activity ------------------------------- */

  async listActivity(): Promise<ActivityEntry[]> {
    return readStore<ActivityEntry[]>("activity", []);
  }

  async recordActivity(entry: Omit<ActivityEntry, "id" | "at">): Promise<void> {
    const existing = await this.listActivity();
    const next: ActivityEntry = {
      ...entry,
      id: `a_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: nowIso(),
    };
    // Bounded feed: newest 60 entries only.
    writeStore("activity", [next, ...existing].slice(0, 60));
  }

  /* ------------------------------ exports ------------------------------- */

  async listExports(): Promise<ExportJob[]> {
    return readStore<ExportJob[]>("exports", []);
  }

  async createExport(body: ExportRequestBody): Promise<ExportJob> {
    const { job } = await this.buildExport(body);
    const jobs = await this.listExports();
    writeStore("exports", [job, ...jobs].slice(0, 50));
    return job;
  }

  async getExport(id: string): Promise<ExportJob> {
    const job = (await this.listExports()).find((item) => item.id === id);
    if (!job) throw new Error(`Export ${id} was not found.`);
    return job;
  }

  async downloadExport(id: string): Promise<{ filename: string; csv: string; truncated: boolean; rowCount: number }> {
    const job = await this.getExport(id);
    // The request body is retained alongside the job so the sample export can be
    // rebuilt on demand — the production adapter streams the stored R2 object.
    const body = readStore<ExportRequestBody | null>(`export-body:${id}`, null);
    if (!body) throw new Error("This export request was not retained; run the export again.");
    const { csv, rowCount, truncated } = await this.buildExportCsv(body);
    return { filename: job.filename, csv, truncated, rowCount };
  }

  private async buildExport(body: ExportRequestBody): Promise<{ job: ExportJob }> {
    const id = `ex_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const filename = exportFilename(body.kind, body.companyId ? this.companyById.get(body.companyId)?.name ?? body.kind : body.kind);
    const { csv, rowCount, truncated } = await this.buildExportCsv(body);
    const job: ExportJob = {
      id,
      status: "completed",
      createdAt: nowIso(),
      completedAt: nowIso(),
      rowCount,
      bytes: csv.length,
      filename,
      truncated,
      objectKey: `app-data/exports/${id}.csv`,
    };
    writeStore(`export-body:${id}`, body);
    return { job };
  }

  private async buildExportCsv(job: ExportRequestBody): Promise<{
    csv: string;
    rowCount: number;
    truncated: boolean;
  }> {
    const rows: Record<string, unknown>[] = [];
    let truncated = false;

    if (job.kind === "contacts") {
      const pool = job.contactIds?.length
        ? job.contactIds.map((id) => this.contactById.get(id)).filter((c): c is Contact => Boolean(c))
        : job.companyId
          ? this.dataset.contactsByCompany.get(job.companyId) ?? []
          : this.dataset.contacts;
      for (const contact of pool) {
        if (!contactMatchesFilters(contact, toContactFilters(job.filters))) continue;
        if (rows.length >= MAX_EXPORT_ROWS) {
          truncated = true;
          break;
        }
        const company = this.companyById.get(contact.companyId);
        rows.push({
          ...contact,
          companyName: company?.name ?? "",
          companyDomain: company?.domain ?? "",
          industry: company?.industry ?? "",
          sourceFile: contact.source.source,
          sourceRow: contact.source.row,
        });
      }
    } else if (job.kind === "companies") {
      const pool = job.companyIds?.length
        ? job.companyIds.map((id) => this.companyById.get(id)).filter((c): c is Company => Boolean(c))
        : this.dataset.companies;
      for (const company of pool) {
        if (rows.length >= MAX_EXPORT_ROWS) {
          truncated = true;
          break;
        }
        rows.push({ ...company, sources: company.sources.map((s) => `${s.source}:${s.row}`).join(";") });
      }
    } else {
      const wanted = new Set(job.leadIds ?? []);
      for (const lead of this.readLeads()) {
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
          notes: lead.notes.map((n) => n.text).join(" | "),
          savedAt: lead.savedAt,
        });
      }
    }

    const columns: CsvColumn<Record<string, unknown>>[] = job.columns.map((column) => ({
      id: column,
      header: EXPORT_COLUMN_HEADERS[column] ?? column,
      value: (row) => row[column],
    }));
    return { csv: toCsv(rows, columns), rowCount: rows.length, truncated };
  }
}

function assertFound<T>(value: T | undefined, kind: string, id: string): asserts value is T {
  if (!value) throw new Error(`Cannot save ${kind} lead: ${kind} ${id} is not in the active dataset.`);
}

