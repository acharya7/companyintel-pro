/**
 * Read-only verification of the `raw/` prefix and the published dataset.
 *
 * This is the logic behind the isolated probe Worker, written against a
 * *structural* bucket interface so it can be exercised in tests with an
 * in-memory bucket and in the Worker with the native `COMPANY_DATA` binding.
 * Nothing here can write: the interface exposes only `list`, `head` and `get`,
 * and every read is bounded.
 *
 * What it refuses to do:
 *   - assume the first two objects are the source files (they are chosen by size
 *     within a bounded listing, and the choice is labelled as automatic);
 *   - claim a bucket total from one page (`objectsRead` is what was read, and a
 *     truncated listing is reported as partial);
 *   - turn a missing object, an unreadable body or a failed validation into a
 *     success.
 */

import { compareExpected, formatBytes, planRawListing, summarizeObject, type ObjectLike, type ObjectSummary } from "./objects";

/* -------------------------------------------------------------------------- */
/* Minimal bucket surface                                                     */
/* -------------------------------------------------------------------------- */

export interface BucketBody {
  key: string;
  size: number;
  etag?: string;
  uploaded?: Date | string;
  httpMetadata?: { contentType?: string; contentEncoding?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface BucketHead {
  key: string;
  size: number;
  etag?: string;
  uploaded?: Date | string;
  httpMetadata?: { contentType?: string; contentEncoding?: string };
}

/**
 * The only bucket capability any verification code gets. `R2Bucket` satisfies it
 * (asserted by the probe's own typecheck), and so does the test double.
 */
export interface ReadOnlyBucket {
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{ objects: unknown[]; truncated?: boolean; cursor?: string }>;
  head(key: string): Promise<BucketHead | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<BucketBody | null>;
}

/* -------------------------------------------------------------------------- */
/* Report shapes                                                              */
/* -------------------------------------------------------------------------- */

export interface ListingReport {
  prefix: string;
  pagesRead: number;
  pageLimit: number;
  /** Objects actually returned inside the page budget (`objectsRead`). */
  objectsRead: number;
  /** True when more objects exist than the page budget read. */
  truncated: boolean;
  /** True when `objectsRead` was also cut down to the reporting bound. */
  reportingTruncated: boolean;
  listed: ObjectSummary[];
  csvObjects: string[];
  otherObjects: string[];
}

export interface SourceVerification {
  key: string;
  present: boolean;
  sizeBytes: number | null;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  /** Bytes actually read from the body (bounded). */
  readBytes: number | null;
  readable: boolean;
  error: string | null;
}

export interface DatasetState {
  activeVersion: string | null;
  previousVersion: string | null;
  publishedAt: string | null;
  manifestPresent: boolean;
  validationPassed: boolean;
  counters: {
    uniqueCompanies: number | null;
    uniqueContacts: number | null;
    rowsRejected: number | null;
    perSource: Record<string, unknown> | null;
  };
  indexShards: unknown;
  indexBytes: number | null;
  note?: string;
}

export interface VerificationReport {
  bucket: string;
  checkedAt: string;
  /** `ok` once the prefix listed, `denied` when listing was refused. */
  access: "ok" | "denied";
  readOnly: true;
  listing: ListingReport;
  selection: {
    mode: "explicit" | "two-largest-csv";
    ambiguous: boolean;
    csvCandidates: string[];
    chosen: string[];
  } | null;
  sources: SourceVerification[];
  dataset: DatasetState | null;
  problems: string[];
  notices: string[];
}

export interface VerifyOptions {
  bucket?: string;
  prefix?: string;
  /** Objects per page, and the number of objects reported. Capped by the caller. */
  maxObjects?: number;
  /** How many pages of `maxObjects` may be read. */
  maxPages?: number;
  /** Bounded body read per source (bytes). */
  readBytes?: number;
  /** Exact keys to verify instead of auto-selecting the two largest CSVs. */
  keys?: string[];
  /** How many source objects the raw/ prefix is expected to contain. */
  expectedSources?: number;
  /** When false, skip the published-dataset check. */
  includeDataset?: boolean;
}

const DEFAULT_MAX_OBJECTS = 25;
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_READ_BYTES = 1024;
/** Upper bound for reading any JSON pointer/manifest through the probe. */
const JSON_READ_LIMIT = 1 << 20;

/** Read the `raw/` prefix and verify the source objects. Never writes. */
export async function verifyRawPrefix(bucket: ReadOnlyBucket, options: VerifyOptions = {}): Promise<VerificationReport> {
  const bucketName = options.bucket ?? "company-intel-data";
  const prefix = options.prefix ?? "raw/";
  const maxObjects = options.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const readBytes = options.readBytes ?? DEFAULT_READ_BYTES;

  const report: VerificationReport = {
    bucket: bucketName,
    checkedAt: new Date().toISOString(),
    access: "ok",
    readOnly: true,
    listing: {
      prefix,
      pagesRead: 0,
      pageLimit: maxObjects,
      objectsRead: 0,
      truncated: false,
      reportingTruncated: false,
      listed: [],
      csvObjects: [],
      otherObjects: [],
    },
    selection: null,
    sources: [],
    dataset: null,
    problems: [],
    notices: [],
  };

  /* ------------------------------ bounded LIST ---------------------------- */

  const collected: ObjectLike[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    let result: { objects: unknown[]; truncated?: boolean; cursor?: string };
    try {
      result = await bucket.list({ prefix, limit: maxObjects, ...(cursor ? { cursor } : {}) });
    } catch (error) {
      report.access = "denied";
      report.problems.push(`${prefix} could not be listed: ${messageOf(error)}`);
      return report;
    }
    report.listing.pagesRead += 1;
    for (const object of result.objects ?? []) collected.push(object as ObjectLike);
    truncated = Boolean(result.truncated);
    cursor = result.cursor;
    if (!truncated || !cursor) break;
  }

  const plan = planRawListing(collected, maxObjects);
  report.listing.objectsRead = plan.objectsRead;
  report.listing.truncated = truncated;
  report.listing.reportingTruncated = plan.truncated;
  report.listing.listed = plan.listed.map(summarizeObject);
  report.listing.csvObjects = plan.csvs.map((object) => object.key);
  report.listing.otherObjects = plan.others.map((object) => object.key);

  if (truncated) {
    report.notices.push(
      `the LIST was still truncated after ${report.listing.pagesRead} page(s): more objects exist under ${prefix} than were read, ` +
        `so this is a bounded view, not a bucket total.`,
    );
  }
  if (plan.truncated) {
    report.notices.push(`only the ${maxObjects} largest of the ${plan.objectsRead} objects read are shown.`);
  }
  if (!plan.listed.length) {
    report.problems.push(`no object was listed under ${prefix} — is the prefix correct?`);
  }

  /* ------------------------------- selection ------------------------------ */

  const explicit = options.keys?.filter(Boolean) ?? [];
  const expected = explicit.length ? explicit : plan.csvs.slice(0, 2).map((object) => object.key);
  const ambiguous = !explicit.length && plan.csvs.length > 2;
  report.selection = {
    mode: explicit.length ? "explicit" : "two-largest-csv",
    ambiguous,
    csvCandidates: plan.csvs.map((object) => object.key),
    chosen: expected,
  };

  const expectedSources = options.expectedSources ?? 2;
  if (!explicit.length && plan.csvs.length < expectedSources) {
    report.problems.push(
      `${plan.csvs.length} .csv object(s) were found within the ${maxObjects}-object bound` +
        `${truncated ? " and the listing was truncated" : ""}; pass the exact keys to name the sources instead of assuming them.`,
    );
  }
  if (ambiguous) {
    report.notices.push(
      `auto-selection chose the two largest .csv objects (${expected.join(", ")}). ${prefix} holds ` +
        `${plan.csvs.length - 2} more .csv object(s) inside the bound; name the sources explicitly if that is wrong.`,
    );
  }

  const presence = compareExpected(expected, plan.listed);
  for (const entry of presence) {
    if (!entry.present) report.problems.push(`expected object is not present in the ${prefix} listing: ${entry.key}`);
  }

  /* ------------------------- presence + bounded read ---------------------- */

  for (const entry of presence) {
    const source: SourceVerification = {
      key: entry.key,
      present: entry.present,
      sizeBytes: entry.object ? summarizeObject(entry.object).size : null,
      etag: entry.object ? summarizeObject(entry.object).etag : null,
      lastModified: entry.object ? summarizeObject(entry.object).lastModified : null,
      contentType: null,
      readBytes: null,
      readable: false,
      error: null,
    };

    if (!entry.present) {
      report.sources.push(source);
      continue;
    }

    try {
      const head = await bucket.head(entry.key);
      if (!head) {
        source.error = "HEAD returned no metadata";
        report.problems.push(`${entry.key}: HEAD returned no metadata, so the object could not be verified.`);
        report.sources.push(source);
        continue;
      }
      source.sizeBytes = typeof head.size === "number" ? head.size : source.sizeBytes;
      source.etag = head.etag ? String(head.etag) : source.etag;
      source.lastModified = head.uploaded ? String(head.uploaded instanceof Date ? head.uploaded.toISOString() : head.uploaded) : source.lastModified;
      source.contentType = head.httpMetadata?.contentType ?? null;

      // Bounded body read: proves the body is readable without pulling a 50 GB file.
      const body = await bucket.get(entry.key, { range: { offset: 0, length: readBytes } });
      if (!body) {
        source.error = "the ranged GET returned no body";
        report.problems.push(`${entry.key}: the ranged GET returned no body.`);
        report.sources.push(source);
        continue;
      }
      const bytes = new Uint8Array(await body.arrayBuffer());
      source.readBytes = bytes.length;
      source.readable = bytes.length > 0;
      source.contentType = source.contentType ?? body.httpMetadata?.contentType ?? null;
      if (!source.readable) report.problems.push(`${entry.key}: the ranged GET returned 0 bytes.`);
    } catch (error) {
      source.error = messageOf(error);
      report.problems.push(`${entry.key}: ${source.error}`);
    }

    report.sources.push(source);
  }

  if (options.includeDataset !== false) {
    const dataset = await readDatasetState(bucket);
    report.dataset = dataset.state;
    report.problems.push(...dataset.problems);
  }

  return report;
}

/* -------------------------------------------------------------------------- */
/* Published dataset                                                          */
/* -------------------------------------------------------------------------- */

/** Read `manifests/active.json` and the version it points at, all bounded. */
export async function readDatasetState(
  bucket: ReadOnlyBucket,
): Promise<{ state: DatasetState | null; problems: string[] }> {
  const problems: string[] = [];
  const pointer = await readJsonBounded(bucket, "manifests/active.json");
  const version = pointer.ok && typeof pointer.value?.version === "string" ? pointer.value.version : null;
  if (!version) {
    return {
      state: { ...emptyDataset(), note: "No dataset version is published yet." },
      problems,
    };
  }

  const manifest = await readJsonBounded(bucket, `manifests/${version}/manifest.json`);
  const validation = await readJsonBounded(bucket, `manifests/${version}/validation.json`);
  const directory = await readJsonBounded(bucket, `indexes/${version}/directory.json`);
  const counters = (manifest.value?.counters ?? manifest.value?.counts ?? {}) as Record<string, unknown>;

  const state: DatasetState = {
    activeVersion: version,
    previousVersion: stringOrNull(pointer.value?.previousVersion ?? pointer.value?.previous),
    publishedAt: stringOrNull(pointer.value?.publishedAt ?? pointer.value?.activatedAt),
    manifestPresent: Boolean(manifest.ok && manifest.value),
    validationPassed: Boolean(validation.ok && validation.value?.passed),
    counters: {
      uniqueCompanies: numberOrNull(counters.uniqueCompanies),
      uniqueContacts: numberOrNull(counters.uniqueContacts),
      rowsRejected: numberOrNull(counters.rowsRejected),
      perSource: (counters.perSource as Record<string, unknown> | undefined) ?? null,
    },
    indexShards: directory.value?.shards ?? null,
    indexBytes: numberOrNull(directory.value?.bytes?.total ?? directory.value?.bytes),
  };

  if (!state.manifestPresent) problems.push(`manifests/${version}/manifest.json is missing.`);
  if (!state.validationPassed) problems.push(`version ${version} has no passing validation record.`);
  if (!directory.ok || !directory.value) problems.push(`indexes/${version}/directory.json is missing.`);
  if (state.counters.perSource && Object.keys(state.counters.perSource).length < 2) {
    problems.push("the manifest records fewer than two contributing sources — confirm both files were indexed.");
  }
  return { state, problems };
}

function emptyDataset(): DatasetState {
  return {
    activeVersion: null,
    previousVersion: null,
    publishedAt: null,
    manifestPresent: false,
    validationPassed: false,
    counters: { uniqueCompanies: null, uniqueContacts: null, rowsRejected: null, perSource: null },
    indexShards: null,
    indexBytes: null,
  };
}

/** Bounded JSON read: a manifest is small, and the bound proves it. */
export async function readJsonBounded(
  bucket: ReadOnlyBucket,
  key: string,
  limit = JSON_READ_LIMIT,
): Promise<{ ok: boolean; status: "ok" | "missing" | "unparsable"; value: any; bytes: number; truncated: boolean }> {
  let body: BucketBody | null;
  try {
    body = await bucket.get(key, { range: { offset: 0, length: limit } });
  } catch {
    // An unreadable pointer is treated as "no published dataset", which is the
    // safe reading: it never makes the app claim a version it cannot load.
    return { ok: false, status: "missing", value: null, bytes: 0, truncated: false };
  }
  if (!body) return { ok: false, status: "missing", value: null, bytes: 0, truncated: false };
  const bytes = new Uint8Array(await body.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  const truncated = bytes.length >= limit;
  try {
    return { ok: true, status: "ok", value: JSON.parse(text), bytes: bytes.length, truncated };
  } catch {
    return { ok: false, status: "unparsable", value: null, bytes: bytes.length, truncated };
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Human-readable summary lines for a report (used by the CLI formatter). */
export function summarizeVerification(report: VerificationReport): string[] {
  const lines: string[] = [];
  lines.push(`bucket ${report.bucket} — ${report.access === "ok" ? "readable (read-only, no writes performed)" : "NOT readable"}`);
  lines.push(
    `objects under ${report.listing.prefix}: ${report.listing.objectsRead} read over ${report.listing.pagesRead} page(s), ` +
      `showing up to ${report.listing.pageLimit}${report.listing.truncated ? " (listing truncated)" : ""}`,
  );
  for (const object of report.listing.listed) {
    lines.push(`  ${formatBytes(object.size).padStart(10)}  ${object.key}${object.lastModified ? `   ${object.lastModified}` : ""}`);
  }
  if (!report.listing.listed.length) lines.push("  (none)");
  return lines;
}
