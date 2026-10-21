/**
 * Bounded direct search of the ORIGINAL R2 sources.
 *
 * This is level 3 of the real-data search path: when the activated index (level 2)
 * does not hold a record, a background job can read the original `raw/*.csv`
 * objects with ranged requests and look for it there. It is deliberately NOT a
 * corpus scan in one request:
 *
 *   - every job has a byte budget per source (`--max-mb`, enforced by the Worker
 *     from `REALDATA_SCAN_MAX_MB` before it starts the container);
 *   - it streams 8 MiB ranges through the SAME `CsvParser` the indexer uses, so a
 *     quoted newline, a multi-byte character or the header row cannot cut a record;
 *   - it persists `bytesScanned` per source after every window, and a restart
 *     continues on a record boundary — never from the start, never mid-record;
 *   - results are deduplicated, bounded and written progressively, so the browser
 *     can poll and show what has been found so far;
 *   - `cancel.json` is honoured between windows and leaves a resumable status;
 *   - a job never claims absence: `complete` means "this budget was processed", and
 *     the status always carries the scanned bytes and the remaining bytes.
 *
 * The company and contact sides use the same normalisation as the index
 * (`normalizeName`), plus a bounded edit-distance fallback for a first-letter typo,
 * so a scan cannot miss a record the index would have found by a spelling variant.
 */

import type { BlobStore } from "../cloud/store";
import { CsvParser, guessDelimiter, type CsvRecord } from "../../src/shared/csv-parse";
import { companyId, contactId } from "../../src/shared/hash";
import { normalizeName, normalizeQuery, nameVariants } from "../../src/shared/normalize";
import { editBudgetFor, editSimilarity, tokenOverlap } from "../../src/shared/search/similarity";
import {
  REALDATA_LIMITS,
  realDataKeys,
  type RealDataScanKind,
  type RealDataScanResults,
  type RealDataScanSourceProgress,
  type RealDataScanStatus,
  type ScannedCompany,
  type ScannedContact,
} from "../../src/shared/realdata/types";

/** Bytes per ranged read. Small enough to stay responsive, large enough to be cheap. */
export const SCAN_WINDOW_BYTES = 8 * 1024 * 1024;

interface SourceSpec {
  id: string;
  key: string;
  role: "company" | "contact";
  columns: Record<string, string>;
}

const SOURCES: SourceSpec[] = [
  {
    id: "csv1",
    key: "raw/file1.csv",
    role: "company",
    columns: {
      name: "organization_name",
      id: "organization_id",
      domain: "organization_domain",
      website: "organization_website_url",
      linkedin: "organization_linkedin_url",
      industry: "organization_industries",
      size: "organization_num_current_employees",
      revenue: "organization_revenue_in_thousands_int",
      city: "organization_hq_location_city",
      state: "organization_hq_location_state",
      country: "organization_hq_location_country",
    },
  },
  {
    id: "csv2",
    key: "raw/file2.csv",
    role: "contact",
    columns: {
      name: "person_name",
      firstName: "person_first_name_unanalyzed",
      lastName: "person_last_name_unanalyzed",
      title: "person_title",
      designation: "person_title_normalized",
      seniority: "person_seniority",
      department: "person_functions",
      email: "person_email",
      phone: "person_phone",
      linkedin: "person_linkedin_url",
      company: "sanitized_organization_name_unanalyzed",
      city: "person_location_city",
      state: "person_location_state",
      country: "person_location_country",
    },
  },
];

/** Columns that are too large to repeat in every result row. */
const SKIP_ATTRIBUTES = new Set(["person_location_geojson", "predictive_scores", "organization_current_technologies"]);

export interface ScanOptions {
  store: BlobStore;
  jobId: string;
  query: string;
  kind: RealDataScanKind;
  datasetVersion: string;
  /** Bytes allowed per source for this job. */
  maxBytesPerSource: number;
  limit?: number;
  onLog?: (line: string) => void;
  onProgress?: (status: RealDataScanStatus) => void;
  /** Test seam: makes the clock deterministic. */
  now?: () => Date;
}

export interface ScanRunResult {
  status: RealDataScanStatus;
  results: RealDataScanResults;
}

/* ------------------------------- matching -------------------------------- */

function normalizeCompanyName(value: string): string {
  return normalizeName(value);
}

function normalizePersonName(value: string): string {
  // Person names are not companies: no legal-suffix stripping, no abbreviation
  // expansion that would turn "St" into "street". Lowercase + deaccent + collapse
  // whitespace is the same shape the index uses for exact matching.
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Score a name against the query.
 *
 * 1000 exact · 700 prefix · 550 contains · 420 all tokens · 0..400 fuzzy.
 * A zero score means "not a match"; the fuzzy floor is intentionally high so a
 * short query cannot match half the corpus.
 */
export function matchScore(query: string, name: string, normalize: (value: string) => string): number {
  const q = normalize(query);
  const n = normalize(name);
  if (!q || !n) return 0;
  if (n === q) return 1000;
  if (n.startsWith(q)) return 700 - Math.min(100, n.length - q.length);
  if (n.includes(q)) return 550;
  const tokens = q.split(" ").filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => n.split(" ").includes(token))) return 420;
  if (tokens.length > 1) {
    const overlap = tokenOverlap(tokens, n.split(" "));
    if (overlap >= 0.75) return 380 + Math.round(overlap * 40);
  }
  if (q.length >= 4) {
    const budget = editBudgetFor(q);
    const distance = editSimilarity(q, n, budget);
    if (distance >= 0.82) return Math.round(200 + distance * 200);
    // First-letter typo on a long name: "microsft" vs "microsoft" is editSimilarity
    // 0.94, already covered; this catches a transposition inside one token.
    const bestToken = Math.max(...n.split(" ").map((token) => (token.length >= 3 ? editSimilarity(q, token, budget) : 0)));
    if (bestToken >= 0.8) return Math.round(150 + bestToken * 150);
  }
  return 0;
}

/* -------------------------------- helpers -------------------------------- */

interface HeaderMap {
  delimiter: string;
  index: Record<string, number>;
  headers: string[];
}

function buildHeaderMap(headers: string[], delimiter: string, spec: SourceSpec): HeaderMap {
  const lower = headers.map((header) => header.trim().toLowerCase());
  const index: Record<string, number> = {};
  for (const [field, column] of Object.entries(spec.columns)) {
    const at = lower.indexOf(column.toLowerCase());
    if (at >= 0) index[field] = at;
  }
  return { delimiter, index, headers };
}

function attributesOf(headers: string[], record: string[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  let captured = 0;
  for (let i = 0; i < headers.length && i < record.length; i += 1) {
    const value = record[i];
    if (!value) continue;
    const name = headers[i];
    if (SKIP_ATTRIBUTES.has(name)) continue;
    // A scan result is polled repeatedly, so the payload is bounded: at most 30
    // non-empty source fields, each truncated. Enough to show the original row's
    // available information without turning every poll into a megabyte.
    attributes[name] = value.length > 160 ? `${value.slice(0, 160)}…` : value;
    captured += 1;
    if (captured >= 30) break;
  }
  return attributes;
}

const pick = (record: CsvRecord, map: HeaderMap, field: string): string | undefined => {
  const at = map.index[field];
  const value = at === undefined ? undefined : record.fields[at];
  return value && value.trim() ? value.trim() : undefined;
};

function sourceProgress(
  specs: SourceSpec[],
  sizes: Map<string, number>,
  previous: RealDataScanSourceProgress[] = [],
): RealDataScanSourceProgress[] {
  return specs.map((spec) => {
    const old = previous.find((entry) => entry.id === spec.id);
    return {
      id: spec.id,
      key: spec.key,
      sizeBytes: sizes.get(spec.id) ?? old?.sizeBytes ?? 0,
      bytesScanned: old?.bytesScanned ?? 0,
      recordsRead: old?.recordsRead ?? 0,
      complete: old?.complete ?? false,
    };
  });
}

function totalsFor(sources: RealDataScanSourceProgress[], status: RealDataScanStatus | null) {
  const bytesScanned = sources.reduce((sum, source) => sum + source.bytesScanned, 0);
  const bytesTotal = sources.reduce((sum, source) => sum + source.sizeBytes, 0);
  return {
    bytesScanned,
    bytesTotal,
    coveragePercent: bytesTotal ? Number(((bytesScanned / bytesTotal) * 100).toFixed(6)) : 0,
    recordsScanned: sources.reduce((sum, source) => sum + source.recordsRead, 0),
    companies: status?.totals.companies ?? 0,
    contacts: status?.totals.contacts ?? 0,
    dropped: status?.totals.dropped ?? 0,
  };
}

/* --------------------------------- runner -------------------------------- */

export async function runScan(options: ScanOptions): Promise<ScanRunResult> {
  const now = options.now ?? (() => new Date());
  const limit = Math.min(options.limit ?? REALDATA_LIMITS.defaultLimit, REALDATA_LIMITS.maxLimit);
  const query = options.query.trim();
  const normalizedQuery = normalizeQuery(query);
  const store = options.store;
  const cancelKey = realDataKeys.scanCancel(options.jobId);

  const existingStatus = await store.getJson<RealDataScanStatus>(realDataKeys.scanStatus(options.jobId));
  const existingResults = await store.getJson<RealDataScanResults>(realDataKeys.scanResults(options.jobId));

  if (existingStatus?.state === "complete" && existingStatus.query === query && existingResults) {
    options.onLog?.("This scan already completed; reusing its results.");
    return { status: existingStatus, results: existingResults };
  }

  const sizes = new Map<string, number>();
  for (const spec of SOURCES) {
    const head = await store.head(spec.key);
    if (!head.exists || head.size === null) throw new Error(`Source object ${spec.key} is missing or unreadable.`);
    sizes.set(spec.id, head.size);
  }

  const startedAt = existingStatus?.startedAt ?? now().toISOString();
  const status: RealDataScanStatus = {
    format: 1,
    jobId: options.jobId,
    query,
    normalizedQuery,
    kind: options.kind,
    state: "running",
    startedAt,
    updatedAt: now().toISOString(),
    sources: sourceProgress(
      SOURCES,
      sizes,
      existingStatus?.sources?.map((source) => ({ ...source, sizeBytes: sizes.get(source.id) ?? source.sizeBytes })),
    ),
    totals: totalsFor(
      sourceProgress(
        SOURCES,
        sizes,
        existingStatus?.sources?.map((source) => ({ ...source, sizeBytes: sizes.get(source.id) ?? source.sizeBytes })),
      ),
      existingStatus,
    ),
    limit,
    maxMbPerSource: Math.round(options.maxBytesPerSource / (1024 * 1024)),
    datasetVersion: options.datasetVersion,
    complete: false,
  };

  const results: RealDataScanResults = existingResults ?? {
    format: 1,
    jobId: options.jobId,
    generatedAt: now().toISOString(),
    companies: [],
    contacts: [],
    truncated: false,
  };

  /*
   * Two maps, for two different jobs:
   *
   *   companyByKey  deduplicates by normalised name AND domain. The normaliser
   *                 strips legal suffixes ("Corporation", "Inc."), so two genuinely
   *                 different companies can share a normalised name; merging them
   *                 would present one company's row as another's.
   *   companyByName links a contact row to a company. The contact row carries only a
   *                 company NAME, so that is the only available key; when two matched
   *                 companies normalise the same, the first encountered is the employer
   *                 shown and the ambiguity remains visible in the per-row source.
   */
  const companyByKey = new Map<string, ScannedCompany>();
  const companyByName = new Map<string, ScannedCompany>();
  for (const company of results.companies) {
    companyByKey.set(companyDedupeKey(company), company);
    if (!companyByName.has(company.normalizedName)) companyByName.set(company.normalizedName, company);
  }
  const contactKeys = new Set(results.contacts.map((contact) => contactKey(contact)));
  const matchedCompanyNames = new Set<string>();
  for (const company of results.companies) {
    if (matchScore(query, company.name, normalizeCompanyName) > 0) matchedCompanyNames.add(company.normalizedName);
  }

  let lastBeat = 0;
  const persist = async (force = false) => {
    status.updatedAt = now().toISOString();
    status.totals = totalsFor(status.sources, status);
    status.totals.companies = results.companies.length;
    status.totals.contacts = results.contacts.length;
    status.complete =
      status.sources.length > 0 &&
      status.sources.every((source) => source.complete || source.bytesScanned >= options.maxBytesPerSource || source.bytesScanned >= source.sizeBytes);
    // A cancellation or failure is terminal for this attempt: the next resume is a
    // new call that reads the stored state, so persist() must not downgrade it back
    // to "running" on the way out.
    if (status.state !== "cancelled" && status.state !== "failed") {
      status.state = status.complete ? "complete" : "running";
    }
    results.generatedAt = status.updatedAt;
    results.truncated = results.truncated || status.totals.dropped > 0;
    await store.putJson(realDataKeys.scanStatus(options.jobId), status);
    await store.putJson(realDataKeys.scanResults(options.jobId), results);
    // Keep the Durable Object's keep-alive honest. `cloud/jobs/<job>/` is the shape
    // the orchestrator already inspects for Pass 1 jobs.
    const at = Date.now();
    if (force || at - lastBeat >= 10_000) {
      lastBeat = at;
      await store.putJson(`cloud/jobs/${options.jobId}/run.json`, {
        version: options.jobId,
        outcome: status.state === "complete" ? "completed" : "running",
        heartbeatAt: status.updatedAt,
        startedAt,
        reason: status.reason,
      });
      await store.putJson(`cloud/jobs/${options.jobId}/state.json`, {
        version: options.jobId,
        mode: "scan",
        stage: status.state === "complete" ? "pass1-complete" : status.state === "cancelled" ? "aborted" : status.state === "failed" ? "failed" : "pass1",
        startedAt,
        updatedAt: status.updatedAt,
        note: `Direct R2 scan for "${query}"`,
        config: { query, kind: options.kind, maxMbPerSource: status.maxMbPerSource, limit },
        progress: { bytesScanned: status.totals.bytesScanned, bytesTotal: status.totals.bytesTotal, coveragePercent: status.totals.coveragePercent },
        accounting: { estimatedUsd: null, containerUsd: null },
      });
    }
    options.onProgress?.(status);
  };

  const cancelled = async () => (await store.getJson<unknown>(cancelKey)) !== null;

  for (const spec of SOURCES) {
    const progress = status.sources.find((source) => source.id === spec.id);
    if (!progress || progress.complete) continue;
    if (await cancelled()) {
      status.state = "cancelled";
      status.reason = "Cancelled by the operator.";
      await persist();
      return { status, results };
    }
    const size = sizes.get(spec.id) ?? 0;
    const allowance = Math.min(options.maxBytesPerSource, size);
    if (progress.bytesScanned >= allowance) {
      progress.complete = true;
      continue;
    }
    options.onLog?.(`scanning ${spec.key} (${spec.role}) from ${(progress.bytesScanned / 1e6).toFixed(1)} MB (allowance ${(allowance / 1e6).toFixed(0)} MB)`);

    // The header is re-read on resume: it is one bounded range and it is what makes
    // the field mapping deterministic without storing 50 column names in status.
    const headerBytes = await store.getRange(spec.key, 0, Math.min(256 * 1024, size));
    const headerText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(headerBytes, { stream: true });
    const delimiter = guessDelimiter(headerText.split("\n", 1)[0] ?? "") || "\t";
    const headerParser = new CsvParser({ delimiter });
    const headerRecords = [...headerParser.push(headerText)];
    const headerRecord = headerRecords[0];
    if (!headerRecord) throw new Error(`${spec.key} has no header row.`);
    const map = buildHeaderMap(headerRecord.fields, delimiter, spec);
    // `0` is a valid column index: compare against undefined, not truthiness.
    if (map.index.name === undefined) {
      throw new Error(`${spec.key} has no "${spec.columns.name}" column; refusing to scan with a guessed mapping.`);
    }

    const parser = new CsvParser({ delimiter });
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let offset = progress.bytesScanned;
    let lastBoundary = offset;
    // The parser counts bytes from the chunk stream's first byte, so its offsets are
    // relative to where this attempt started, not to the object.
    const parserStart = offset;
    let headerSkipped = offset > 0;
    /*
     * The budget is enforced to the record, not to the byte. A record that starts a
     * few bytes before the limit must be read to its end before the parser can commit
     * a boundary, so the job may overshoot by at most one small read (256 KiB). The
     * overshoot is reported in `bytesScanned`; it is not extra scanning beyond the
     * source's configured window except for that one record.
     */
    const OVERSHOOT_BYTES = 256 * 1024;
    const hardEnd = Math.min(size, allowance + OVERSHOOT_BYTES);
    // A resume starts exactly on a record boundary, so the parser sees a full record
    // stream from its first byte.
    while (offset < hardEnd) {
      if (await cancelled()) {
        if (lastBoundary > progress.bytesScanned) {
          progress.bytesScanned = lastBoundary;
        }
        status.state = "cancelled";
        status.reason = "Cancelled by the operator.";
        await persist(true);
        return { status, results };
      }
      const length = Math.min(SCAN_WINDOW_BYTES, hardEnd - offset);
      if (length <= 0) break;
      const body = await store.getRange(spec.key, offset, length);
      if (!body.length) break;
      const text = decoder.decode(body, { stream: true });
      const dropped = { count: status.totals.dropped };
      for (const record of parser.push(text)) {
        progress.recordsRead += 1;
        lastBoundary = parserStart + (record.endByte ?? 0);
        if (!headerSkipped) {
          headerSkipped = true;
          continue;
        }
        if (spec.role === "company") {
          absorbCompany(record, map, results, companyByKey, companyByName, matchedCompanyNames, query, limit, dropped);
        } else {
          absorbContact(record, map, results, contactKeys, companyByName, matchedCompanyNames, query, limit, options.kind, dropped);
        }
      }
      status.totals.dropped = dropped.count;
      if (lastBoundary > progress.bytesScanned) progress.bytesScanned = lastBoundary;
      offset += body.length;
      await persist();
      // `lastBoundary` is always the end of a complete record, so it is the only
      // offset a restart may resume from. A chunk usually ends mid-record, which is
      // why the commit does not depend on `atRecordBoundary`.
      if (progress.bytesScanned >= allowance) break;
    }
    // At the end of a source object, flush the last record if the file does not end
    // with a newline. A budget stop deliberately leaves the partial record for the
    // next run (`lastBoundary` is its start).
    if (offset >= size) {
      const dropped = { count: status.totals.dropped };
      for (const record of parser.end()) {
        progress.recordsRead += 1;
        if (!headerSkipped) {
          headerSkipped = true;
          continue;
        }
        if (spec.role === "company") absorbCompany(record, map, results, companyByKey, companyByName, matchedCompanyNames, query, limit, dropped);
        else absorbContact(record, map, results, contactKeys, companyByName, matchedCompanyNames, query, limit, options.kind, dropped);
      }
      status.totals.dropped = dropped.count;
      progress.bytesScanned = Math.max(progress.bytesScanned, size);
    }
    progress.complete = progress.bytesScanned >= allowance || progress.bytesScanned >= size;
    await persist(true);
  }

  status.state = status.complete ? "complete" : "running";
  if (!status.complete || status.totals.bytesScanned < status.totals.bytesTotal) {
    status.reason = status.complete
      ? "The requested scan scope was processed. The budget stops before the end of each source, so records outside the scanned bytes were not examined."
      : "The scan paused before its requested scope; run it again to continue from the committed record boundary.";
  }
  await persist(true);
  options.onLog?.(
    `scan ${status.state}: ${results.companies.length} compan${results.companies.length === 1 ? "y" : "ies"}, ` +
      `${results.contacts.length} contact(s), ${(status.totals.bytesScanned / 1e6).toFixed(1)} MB of ${(status.totals.bytesTotal / 1e9).toFixed(2)} GB`,
  );
  return { status, results };
}

function contactKey(contact: ScannedContact): string {
  return contact.email
    ? `e:${contact.email.toLowerCase()}`
    : contact.linkedinUrl
      ? `l:${contact.linkedinUrl.toLowerCase()}`
      : `n:${contact.fullName.toLowerCase()}|${contact.companyName ?? ""}`;
}

function companyDedupeKey(company: Pick<ScannedCompany, "normalizedName" | "domain" | "source">): string {
  return `${company.normalizedName}|${company.domain ?? `row:${company.source.id}:${company.source.row}`}`;
}

function absorbCompany(
  record: CsvRecord,
  map: HeaderMap,
  results: RealDataScanResults,
  companyByKey: Map<string, ScannedCompany>,
  companyByName: Map<string, ScannedCompany>,
  matchedCompanyNames: Set<string>,
  query: string,
  limit: number,
  dropped: { count: number },
): void {
  const name = pick(record, map, "name");
  if (!name) return;
  const normalizedName = normalizeCompanyName(name);
  const score = matchScore(query, name, normalizeCompanyName);
  if (!score) return;
  matchedCompanyNames.add(normalizedName);
  const domain = pick(record, map, "domain");
  const key = `${normalizedName}|${domain ?? `row:csv1:${record.line}`}`;
  const existing = companyByKey.get(key);
  if (existing) {
    // Keep the richest attribute set, never duplicate the company.
    existing.attributes = { ...record_attributes(record, map), ...existing.attributes };
    return;
  }
  if (results.companies.length >= limit) {
    dropped.count += 1;
    return;
  }
  const company: ScannedCompany = {
    id: companyId(`n:${normalizedName}|${domain ?? record.line}`),
    name,
    normalizedName,
    domain,
    website: pick(record, map, "website") ?? (pick(record, map, "domain") ? `https://${pick(record, map, "domain")}` : undefined),
    linkedinUrl: pick(record, map, "linkedin"),
    industry: pick(record, map, "industry"),
    companySize: pick(record, map, "size"),
    revenue: pick(record, map, "revenue"),
    country: pick(record, map, "country"),
    state: pick(record, map, "state"),
    city: pick(record, map, "city"),
    contacts: [],
    source: { id: "csv1", row: record.line },
    attributes: record_attributes(record, map),
  };
  results.companies.push(company);
  companyByKey.set(key, company);
  if (!companyByName.has(normalizedName)) companyByName.set(normalizedName, company);
}

function absorbContact(
  record: CsvRecord,
  map: HeaderMap,
  results: RealDataScanResults,
  seen: Set<string>,
  companyByName: Map<string, ScannedCompany>,
  matchedCompanyNames: Set<string>,
  query: string,
  limit: number,
  kind: RealDataScanKind,
  dropped: { count: number },
): void {
  const name = pick(record, map, "name");
  if (!name) return;
  const companyName = pick(record, map, "company");
  const normalizedCompany = companyName ? normalizeCompanyName(companyName) : "";
  const personScore = kind === "companies" ? 0 : matchScore(query, name, normalizePersonName);
  const atMatchedCompany =
    kind !== "contacts" && normalizedCompany !== "" && matchedCompanyNames.has(normalizedCompany);
  if (!personScore && !atMatchedCompany) return;
  const email = pick(record, map, "email");
  const linkedinUrl = pick(record, map, "linkedin");
  const contact: ScannedContact = {
    id: contactId(`${normalizedCompany}|${email ?? linkedinUrl ?? name}`),
    fullName: name,
    firstName: pick(record, map, "firstName"),
    lastName: pick(record, map, "lastName"),
    title: pick(record, map, "title"),
    designation: pick(record, map, "designation"),
    seniority: pick(record, map, "seniority"),
    department: pick(record, map, "department"),
    email,
    phone: pick(record, map, "phone"),
    linkedinUrl,
    companyName,
    companyId: companyByName.get(normalizedCompany)?.id ?? null,
    country: pick(record, map, "country"),
    state: pick(record, map, "state"),
    city: pick(record, map, "city"),
    source: { id: "csv2", row: record.line },
    attributes: record_attributes(record, map),
  };
  const key = contactKey(contact);
  if (seen.has(key)) return;
  if (results.contacts.length >= limit) {
    dropped.count += 1;
    results.truncated = true;
    return;
  }
  seen.add(key);
  results.contacts.push(contact);
  const company = companyByName.get(normalizedCompany);
  if (company && !company.contacts.some((entry) => entry.id === contact.id)) {
    if (company.contacts.length < 25) company.contacts.push(contact);
  }
}

function record_attributes(record: CsvRecord, map: HeaderMap): Record<string, string> {
  return attributesOf(map.headers, record.fields);
}

/** Name variants the index would accept, exported so `/explain` and tests agree. */
export function companyQueryVariants(query: string): string[] {
  return [normalizeName(query), ...nameVariants(query)];
}
