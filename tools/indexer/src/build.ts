/**
 * CompanyIntel indexing engine.
 *
 * Runs on your own machine (Windows, macOS or Linux) and never inside a
 * Cloudflare Worker: 60 GB cannot be streamed through a request, and the
 * specification explicitly forbids trying.
 *
 * Pipeline
 * --------
 *   preflight   verify inputs, disk space, memory and (optionally) R2 access
 *   pass 1      stream both CSVs and spool canonical rows into hash partitions
 *   pass 2      one partition at a time: resolve identity, deduplicate
 *               contacts, emit company + contact objects, feed the indexes
 *   finalize    group each shard's postings, write compressed index objects,
 *               compute statistics, manifest, directory and per-object checksums
 *   validate    re-read what was written and verify counts and checksums
 *   upload      PUT any object that is missing or whose checksum differs
 *   publish     write manifests/active.json only after validation passes
 *
 * Everything is disk-backed and bounded: at no point is more than one partition
 * of raw rows, or one shard of postings, held in memory.
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { cpus, freemem, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import type { Company, Contact, DatasetStats, DatasetVersionSummary, FacetBucket, IndexingCounters, SourceRef } from "../../../src/shared/models";
import { NORMALIZER_VERSION } from "../../../src/shared/normalize";
import {
  INDEX_FORMAT_VERSION,
  SHARDING,
  folderFor,
  qualityByte,
  type CompanyPartitionPayload,
  type ContactPartitionPayload,
  type IndexDirectory,
  type Postings,
  type ShardPayload,
} from "../../../src/shared/search/index-format";
import { contactId as contactIdFor, shardOf } from "../../../src/shared/hash";
import { readCsvFile, profileCsvFile, type FileProfile } from "./csv";
import {
  ALL_CANONICAL_FIELDS,
  CompanyResolver,
  buildColumnMap,
  buildCompany,
  buildContact,
  companyKeysFromInput,
  contactFingerprint,
  extractCompanyInput,
  extractContactInput,
  finalizeFacets,
  accumulateFacets,
  partitionFor,
  pickCanonicalKey,
  type RawContactInput,
  type RawCompanyInput,
} from "./mapping";
import { credentialsFromEnv, fileSize, R2Client } from "./r2";

export interface SourceConfig {
  id: string;
  path: string;
  encoding?: string;
  delimiter?: string;
  /** Optional manual column overrides: canonical field -> header name. */
  columns?: Record<string, string>;
}

export interface IndexerConfig {
  datasetVersion: string;
  sources: SourceConfig[];
  workDir: string;
  outputDir: string;
  /** Number of spool partitions. Keep a power of two; 256 handles 10M+ rows. */
  partitions: number;
  shards: { exact: number; prefix: number; token: number; trigram: number; ids: number };
  /**
   * Companies per company/contact object is NOT configurable on purpose: the
   * readers derive the object for a given document ref from the shared
   * `SHARDING` constants, so the two sides can never disagree.
   */
  upload?: { enabled: boolean; bucket: string };
}

export interface ProgressEvent {
  stage: "preflight" | "profiling" | "pass1-partition" | "pass2-merge" | "indexing" | "validating" | "uploading" | "completed" | "failed";
  rowsRead: number;
  rowsRejected: number;
  companies: number;
  contacts: number;
  message: string;
  progress: number | null;
  rowsPerSecond: number | null;
  etaSeconds: number | null;
}

export interface PreflightReport {
  sources: { id: string; path: string; bytes: number | null; exists: boolean }[];
  totalInputBytes: number;
  freeDiskBytes: number | null;
  estimatedWorkBytes: number;
  estimatedOutputBytes: number;
  memoryBytes: { free: number; total: number };
  cpuCount: number;
  estimatedRows: number | null;
  estimatedDurationSeconds: number | null;
  warnings: string[];
}

const BYTES_PER_SPOOL_ROW = 900;
const ROWS_PER_SECOND_BASELINE = 120_000;

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

export async function preflight(config: IndexerConfig): Promise<PreflightReport> {
  const sources: PreflightReport["sources"] = [];
  let totalInputBytes = 0;
  const warnings: string[] = [];

  for (const source of config.sources) {
    const bytes = await fileSize(source.path);
    const exists = bytes !== null;
    if (!exists) warnings.push(`Source ${source.id} was not found at ${source.path}`);
    sources.push({ id: source.id, path: source.path, bytes, exists });
    totalInputBytes += bytes ?? 0;
  }

  const freeDiskBytes = await freeDiskBytesFor(config.workDir);
  // Spool rows are the dominant temporary cost; output is compressed JSON.
  const estimatedWorkBytes = Math.round(totalInputBytes * 1.1) + 256 * 1024 * 1024;
  const estimatedOutputBytes = Math.round(totalInputBytes * 0.12);
  const cpuCount = cpus().length || 1;

  if (freeDiskBytes !== null && freeDiskBytes < estimatedWorkBytes) {
    warnings.push(
      `Temporary space looks insufficient: about ${(freeDiskBytes / 1e9).toFixed(1)} GB free vs ${(estimatedWorkBytes / 1e9).toFixed(1)} GB estimated for spooling.`,
    );
  }
  if (freemem() < 1024 * 1024 * 1024) {
    warnings.push("Less than 1 GB of free memory: indexing will still run (it is partitioned) but will be slower.");
  }

  return {
    sources,
    totalInputBytes,
    freeDiskBytes,
    estimatedWorkBytes,
    estimatedOutputBytes,
    memoryBytes: { free: freemem(), total: totalmem() },
    cpuCount,
    estimatedRows: null,
    estimatedDurationSeconds: null,
    warnings,
  };
}

async function freeDiskBytesFor(path: string): Promise<number | null> {
  try {
    const { statfs } = await import("node:fs/promises");
    const info = await statfs(existsSync(path) ? path : dirname(path));
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Shard writing                                                              */
/* -------------------------------------------------------------------------- */

type ShardKind = "exact" | "prefix" | "token" | "trigram" | "ids";

/**
 * Appends `term␁ref␁quality` lines to one file per shard, keeping a bounded
 * number of file handles open. Postings are never accumulated in memory, which
 * is what makes a 10M-company trigram index possible on a laptop.
 */
class ShardWriter {
  private readonly handles = new Map<string, WriteStream>();
  private readonly order: string[] = [];
  private readonly pending: Promise<void>[] = [];

  constructor(
    private readonly root: string,
    private readonly maxHandles = 64,
  ) {}

  private async handle(kind: ShardKind, shard: number): Promise<WriteStream> {
    const key = `${kind}/${String(shard).padStart(4, "0")}`;
    const existing = this.handles.get(key);
    if (existing) return existing;

    if (this.handles.size >= this.maxHandles) {
      const evictKey = this.order.shift();
      if (evictKey) {
        const stream = this.handles.get(evictKey);
        this.handles.delete(evictKey);
        stream?.end();
      }
    }

    const path = join(this.root, `${key}.lines`);
    await mkdir(dirname(path), { recursive: true });
    const stream = createWriteStream(path, { flags: "a" });
    this.handles.set(key, stream);
    this.order.push(key);
    return stream;
  }

  async write(kind: ShardKind, shard: number, term: string, ref: number, quality: number): Promise<void> {
    const stream = await this.handle(kind, shard);
    const line = `${term}\u0001${ref}\u0001${quality}\n`;
    if (!stream.write(line)) {
      await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
    }
  }

  async close(): Promise<void> {
    for (const stream of this.handles.values()) {
      this.pending.push(new Promise<void>((resolve) => stream.end(resolve)));
    }
    this.handles.clear();
    await Promise.all(this.pending);
  }
}

/* -------------------------------------------------------------------------- */
/* Object writing                                                             */
/* -------------------------------------------------------------------------- */

interface WrittenObject {
  key: string;
  bytes: number;
  sha256: string;
  gzip: boolean;
}

class ObjectWriter {
  readonly objects: WrittenObject[] = [];

  constructor(private readonly outputDir: string) {}

  async writeJson(key: string, value: unknown, gzip = true): Promise<WrittenObject> {
    const path = join(this.outputDir, key);
    await mkdir(dirname(path), { recursive: true });
    const raw = Buffer.from(JSON.stringify(value), "utf8");
    const body = gzip ? gzipSync(raw) : raw;
    await writeFile(path, body);
    const object: WrittenObject = {
      key,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      gzip,
    };
    this.objects.push(object);
    return object;
  }

  async writeText(key: string, value: string): Promise<WrittenObject> {
    const path = join(this.outputDir, key);
    await mkdir(dirname(path), { recursive: true });
    const body = Buffer.from(value, "utf8");
    await writeFile(path, body);
    const object: WrittenObject = { key, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), gzip: false };
    this.objects.push(object);
    return object;
  }
}

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* -------------------------------------------------------------------------- */

export interface RunOptions {
  /** Hard cap on records per source (sample runs). */
  sampleLimit?: number;
  onProgress?: (event: ProgressEvent) => void;
  /** Resume from the checkpoint when present (default true). */
  resume?: boolean;
}

export interface RunResult {
  version: string;
  counters: IndexingCounters;
  objects: WrittenObject[];
  directory: IndexDirectory;
  manifest: DatasetVersionSummary;
  profiles: FileProfile[];
  elapsedMs: number;
}

interface SpoolRow {
  /** Every identifier key this row carries (strongest first). */
  keys: string[];
  /** Partition bucket = strongest identifier, so related rows share a partition. */
  bucket: string;
  strong: boolean;
  normalizedName: string;
  company: RawCompanyInput;
  contact: RawContactInput | null;
  source: SourceRef;
}

export async function runIndex(config: IndexerConfig, options: RunOptions = {}): Promise<RunResult> {
  const startedAt = Date.now();
  const report = await preflight(config);
  const emit = (event: Partial<ProgressEvent> & { stage: ProgressEvent["stage"]; message: string }) =>
    options.onProgress?.({
      rowsRead: 0,
      rowsRejected: 0,
      companies: 0,
      contacts: 0,
      progress: null,
      rowsPerSecond: null,
      etaSeconds: null,
      ...event,
    });

  for (const warning of report.warnings) emit({ stage: "preflight", message: `warning: ${warning}` });

  const workDir = config.workDir;
  const spoolDir = join(workDir, "spool");
  const shardDir = join(workDir, "shards");
  const checkpointPath = join(workDir, "checkpoint.json");
  const resume = options.resume !== false;
  const checkpoint = resume && existsSync(checkpointPath) ? JSON.parse(await readFile(checkpointPath, "utf8")) : null;

  await mkdir(spoolDir, { recursive: true });
  await mkdir(shardDir, { recursive: true });
  await mkdir(config.outputDir, { recursive: true });

  /* ------------------------------- profiling ------------------------------ */

  const profiles: FileProfile[] = [];
  const columnMaps: Record<string, number>[] = [];
  for (const source of config.sources) {
    const profile = await profileCsvFile(source.path, {
      encoding: source.encoding,
      delimiter: source.delimiter,
      sampleRows: 500,
      knownFields: [...ALL_CANONICAL_FIELDS],
    });
    profiles.push(profile);
    const map = buildColumnMap(profile.headers);
    if (source.columns) {
      for (const [field, header] of Object.entries(source.columns)) {
        const index = profile.headers.findIndex((value) => value.trim().toLowerCase() === header.trim().toLowerCase());
        if (index !== -1) map[field] = index;
      }
    }
    columnMaps.push(map);
    emit({
      stage: "profiling",
      message: `profiled ${source.id}: ${profile.headers.length} columns, ${profile.unmappedHeaders.length} unmapped, ${profile.missingCanonicalFields.length} canonical fields absent`,
    });
    if (profile.unmappedHeaders.length) {
      emit({ stage: "profiling", message: `  unmapped in ${source.id}: ${profile.unmappedHeaders.slice(0, 12).join(", ")}` });
    }
  }

  /* --------------------------------- pass 1 ------------------------------- */

  const counters: IndexingCounters = {
    rowsRead: 0,
    rowsRejected: 0,
    uniqueCompanies: 0,
    uniqueContacts: 0,
    duplicateRowsResolved: 0,
    duplicateCompaniesResolved: 0,
    ambiguousCompanies: 0,
    recordsMissingCompanyId: 0,
    perSource: {},
  };
  for (const source of config.sources) {
    counters.perSource[source.id] = { rowsRead: 0, rowsRejected: 0, companies: 0, contacts: 0 };
  }

  const rejectedPath = join(workDir, "rejected.jsonl");
  const rejected = createWriteStream(rejectedPath, { flags: checkpoint ? "a" : "w" });

  if (!checkpoint || checkpoint.stage === "preflight") {
    emit({ stage: "pass1-partition", message: "pass 1: streaming both files into hash partitions" });
    const pass1Start = Date.now();

    for (let sourceIndex = 0; sourceIndex < config.sources.length; sourceIndex += 1) {
      const source = config.sources[sourceIndex];
      const map = columnMaps[sourceIndex];
      const sinks = new Map<number, WriteStream>();
      let rows = 0;
      // The first record of each file is its header row, which was already read
      // by the profiler and must never be indexed as data.
      let isHeader = true;

      for await (const record of readCsvFile(source.path, {
        encoding: source.encoding,
        delimiter: source.delimiter,
        maxRecords: options.sampleLimit === undefined ? undefined : options.sampleLimit + 1,
      })) {
        if (isHeader) {
          isHeader = false;
          continue;
        }
        if (record.fields.every((field) => field.trim() === "")) continue;
        rows += 1;
        counters.rowsRead += 1;
        counters.perSource[source.id].rowsRead += 1;

        const companyInput = extractCompanyInput(record.fields, map);
        if (!companyInput) {
          counters.rowsRejected += 1;
          counters.perSource[source.id].rowsRejected += 1;
          rejected.write(`${JSON.stringify({ source: source.id, line: record.line, reason: "missing_company_name", fields: record.fields.slice(0, 8) })}\n`);
          continue;
        }
        if (!companyInput.domain && !companyInput.linkedinUrl && !companyInput.sourceId) {
          counters.recordsMissingCompanyId += 1;
        }

        const contactInput = extractContactInput(record.fields, map);
        const keys = companyKeysFromInput(companyInput, source.id);
        const partition = partitionFor(keys.bucket, config.partitions);
        const row: SpoolRow = {
          keys: keys.all,
          bucket: keys.bucket,
          strong: keys.strong,
          normalizedName: keys.normalizedName,
          company: companyInput,
          contact: contactInput,
          source: { source: source.id, row: record.line },
        };

        let sink = sinks.get(partition);
        if (!sink) {
          const path = join(spoolDir, `part-${String(partition).padStart(4, "0")}.jsonl`);
          sink = createWriteStream(path, { flags: "a" });
          sinks.set(partition, sink);
        }
        if (!sink.write(`${JSON.stringify(row)}\n`)) {
          await new Promise<void>((resolve) => sink!.once("drain", () => resolve()));
        }

        if (rows % 200_000 === 0) {
          const elapsed = (Date.now() - pass1Start) / 1000;
          const rate = counters.rowsRead / Math.max(1, elapsed);
          emit({
            stage: "pass1-partition",
            rowsRead: counters.rowsRead,
            rowsRejected: counters.rowsRejected,
            rowsPerSecond: rate,
            progress: options.sampleLimit ? rows / options.sampleLimit : null,
            message: `pass 1: ${counters.rowsRead.toLocaleString()} rows read (${Math.round(rate).toLocaleString()} rows/s)`,
          });
        }
      }

      await Promise.all([...sinks.values()].map((sink) => new Promise<void>((resolve) => sink.end(resolve))));
      emit({ stage: "pass1-partition", rowsRead: counters.rowsRead, message: `pass 1: finished ${source.id} (${rows.toLocaleString()} rows)` });
    }

    await writeFile(checkpointPath, JSON.stringify({ stage: "pass2-merge", counters }, null, 2));
  }

  /* --------------------------------- pass 2 ------------------------------- */

  const writer = new ObjectWriter(config.outputDir);
  const shardWriter = new ShardWriter(shardDir);
  const companyStats = { byIndustry: new Map<string, number>(), byCountry: new Map<string, number>(), bySize: new Map<string, number>() };
  const contactStats = { byDesignation: new Map<string, number>(), byDepartment: new Map<string, number>(), bySeniority: new Map<string, number>() };
  const coverage = { email: 0, linkedin: 0, phone: 0, neither: 0 };

  let globalRef = 0;
  let companyBuffer: Company[] = [];
  let companyBufferStart = 0;
  let contactBuffer = new Map<number, Contact[]>();
  let contactBufferStart = 0;
  let companyPartitionIndex = 0;
  let contactPartitionIndex = 0;

  const flushCompanies = async () => {
    if (!companyBuffer.length) return;
    const payload: CompanyPartitionPayload = { firstRef: companyBufferStart, companies: companyBuffer };
    await writer.writeJson(folderFor("companies", config.datasetVersion, companyPartitionIndex), payload);
    companyPartitionIndex += 1;
    companyBuffer = [];
  };

  const flushContacts = async () => {
    if (!contactBuffer.size) return;
    const byCompany: Record<string, Contact[]> = {};
    for (const [ref, contacts] of contactBuffer) byCompany[String(ref)] = contacts;
    const payload: ContactPartitionPayload = { firstRef: contactBufferStart, byCompany };
    await writer.writeJson(folderFor("contacts", config.datasetVersion, contactPartitionIndex), payload);
    contactPartitionIndex += 1;
    contactBuffer = new Map();
  };

  const spoolFiles = (await readdir(spoolDir)).filter((name) => name.endsWith(".jsonl")).sort();
  emit({ stage: "pass2-merge", message: `pass 2: resolving ${spoolFiles.length} partitions` });

  for (let fileIndex = 0; fileIndex < spoolFiles.length; fileIndex += 1) {
    const path = join(spoolDir, spoolFiles[fileIndex]);
    const resolver = new CompanyResolver();
    const groups = new Map<
      number,
      {
        ref: number;
        /** All identifiers seen for this entity, used to pick a stable id. */
        keys: Set<string>;
        input: RawCompanyInput;
        sources: SourceRef[];
        contacts: Map<string, Contact>;
        ambiguous: boolean;
        strong: boolean;
        normalizedName: string;
      }
    >();

    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as SpoolRow;
      const decision = resolver.resolve({ all: row.keys, bucket: row.bucket, strong: row.strong, normalizedName: row.normalizedName });
      let group = groups.get(decision.ref);
      if (!group) {
        group = {
          ref: decision.ref,
          keys: new Set(row.keys),
          input: row.company,
          sources: [],
          contacts: new Map(),
          ambiguous: decision.ambiguous,
          strong: row.strong,
          normalizedName: row.normalizedName,
        };
        groups.set(decision.ref, group);
      }
      for (const key of row.keys) group.keys.add(key);
      if (!group.sources.some((ref) => ref.source === row.source.source && ref.row === row.source.row)) {
        group.sources.push(row.source);
      }
      if (row.contact) {
        const provisional = buildContact({ input: row.contact, company: placeholderCompany(row.bucket, row.company), source: row.source, rowFingerprint: `${row.source.source}:${row.source.row}` });
        const fingerprint = contactFingerprint(provisional);
        if (fingerprint && group.contacts.has(fingerprint)) {
          counters.duplicateRowsResolved += 1;
        } else {
          group.contacts.set(fingerprint ?? `r:${row.source.source}:${row.source.row}`, provisional);
        }
      }
    }

    // Several keys can share one normalized name (e.g. two subsidiaries with
    // different domains). Those are kept as separate records and flagged, never
    // merged — exactly what the specification requires.
    const nameCounts = new Map<string, number>();
    for (const group of groups.values()) nameCounts.set(group.normalizedName, (nameCounts.get(group.normalizedName) ?? 0) + 1);
    for (const group of groups.values()) {
      if ((nameCounts.get(group.normalizedName) ?? 0) > 1) group.ambiguous = true;
    }

    // Emit companies in a deterministic order so refs stay reproducible.
    const ordered = [...groups.values()].sort(
      (a, b) => a.normalizedName.localeCompare(b.normalizedName) || pickCanonicalKey(a.keys).localeCompare(pickCanonicalKey(b.keys)),
    );
    for (const group of ordered) {
      const company = buildCompany({
        ref: globalRef,
        input: group.input,
        key: {
          key: pickCanonicalKey(group.keys),
          strong: group.strong,
          normalizedName: group.normalizedName,
          display: group.input.name,
        },
        sources: group.sources,
        ambiguous: group.ambiguous,
      });
      const facets = company.facets ?? { designations: [], departments: [], seniority: [], countries: [], cities: [], emailAvailable: 0, linkedinAvailable: 0 };
      const contacts: Contact[] = [];
      for (const contact of group.contacts.values()) {
        const finalised: Contact = { ...contact, companyId: company.id };
        finalised.id = buildContactId(company.id, finalised);
        contacts.push(finalised);
        accumulateFacets(facets, finalised);
        counters.uniqueContacts += 1;
        if (counters.perSource[finalised.source.source]) counters.perSource[finalised.source.source].contacts += 1;
        if (contacts.length === 1) {
          companyStats.byIndustry.set(company.industry ?? "Unknown", (companyStats.byIndustry.get(company.industry ?? "Unknown") ?? 0) + 1);
          companyStats.byCountry.set(company.country ?? "Unknown", (companyStats.byCountry.get(company.country ?? "Unknown") ?? 0) + 1);
          companyStats.bySize.set(company.companySize ?? "Unknown", (companyStats.bySize.get(company.companySize ?? "Unknown") ?? 0) + 1);
        }
        if (finalised.designation) contactStats.byDesignation.set(finalised.designation, (contactStats.byDesignation.get(finalised.designation) ?? 0) + 1);
        if (finalised.department) contactStats.byDepartment.set(finalised.department, (contactStats.byDepartment.get(finalised.department) ?? 0) + 1);
        if (finalised.seniority) contactStats.bySeniority.set(finalised.seniority, (contactStats.bySeniority.get(finalised.seniority) ?? 0) + 1);
        if (finalised.email) coverage.email += 1;
        if (finalised.linkedinUrl) coverage.linkedin += 1;
        if (finalised.phone) coverage.phone += 1;
        if (!finalised.email && !finalised.linkedinUrl && !finalised.phone) coverage.neither += 1;
      }
      company.contactCount = contacts.length;
      company.facets = finalizeFacets(facets);
      if (group.ambiguous) counters.ambiguousCompanies += 1;

      // Index postings (bounded per shard file).
      const quality = qualityByte(company.contactCount, company.normalizedName.length);
      const variants = new Set<string>([company.normalizedName, ...(company.aliases ?? [])]);
      for (const variant of variants) {
        await shardWriter.write("exact", shardOf(variant, config.shards.exact), variant, globalRef, quality);
        const maxPrefix = Math.min(12, variant.length);
        for (let i = 1; i <= maxPrefix; i += 1) {
          await shardWriter.write("prefix", shardOf(variant.slice(0, i), config.shards.prefix), variant.slice(0, i), globalRef, quality);
        }
        for (const gram of trigrams(variant)) {
          await shardWriter.write("trigram", shardOf(gram, config.shards.trigram), gram, globalRef, quality);
        }
      }
      for (const token of new Set(company.normalizedName.split(" "))) {
        await shardWriter.write("token", shardOf(token, config.shards.token), token, globalRef, quality);
      }
      await shardWriter.write("ids", shardOf(company.id, config.shards.ids), company.id, globalRef, 255);
      for (const contact of contacts) {
        await shardWriter.write("ids", shardOf(contact.id, config.shards.ids), contact.id, globalRef, 255);
      }

      companyBuffer.push(company);
      if (companyBuffer.length >= SHARDING.companiesPerPartition) await flushCompanies();

      const bucket = Math.floor(globalRef / SHARDING.companiesPerContactPartition);
      if (contacts.length) contactBuffer.set(globalRef, contacts);
      if (bucket !== contactBufferStart) {
        await flushContacts();
        contactBufferStart = bucket;
      }

      globalRef += 1;
      counters.uniqueCompanies += 1;
      const ownerSource = company.sources[0]?.source ?? config.sources[0].id;
      if (counters.perSource[ownerSource]) counters.perSource[ownerSource].companies += 1;
    }

    if (fileIndex % 16 === 0) {
      emit({
        stage: "pass2-merge",
        rowsRead: counters.rowsRead,
        rowsRejected: counters.rowsRejected,
        companies: counters.uniqueCompanies,
        contacts: counters.uniqueContacts,
        progress: fileIndex / spoolFiles.length,
        message: `pass 2: ${counters.uniqueCompanies.toLocaleString()} companies from ${fileIndex + 1}/${spoolFiles.length} partitions`,
      });
    }
  }

  await flushCompanies();
  await flushContacts();
  await shardWriter.close();
  await new Promise<void>((resolve) => rejected.end(resolve));

  /* -------------------------------- finalize ------------------------------ */

  emit({ stage: "indexing", message: "finalizing index shards" });
  const indexPathIndex = async (kind: ShardKind, shards: number) => {
    for (let shard = 0; shard < shards; shard += 1) {
      const linesPath = join(shardDir, `${kind}/${String(shard).padStart(4, "0")}.lines`);
      if (!existsSync(linesPath)) continue;
      const terms: Record<string, Postings> = {};
      const lastRef = new Map<string, number>();
      const lines = createInterface({ input: createReadStream(linesPath), crlfDelay: Infinity });
      for await (const line of lines) {
        const first = line.indexOf("\u0001");
        if (first === -1) continue;
        const second = line.indexOf("\u0001", first + 1);
        const term = line.slice(0, first);
        const ref = Number(line.slice(first + 1, second));
        const quality = Number(line.slice(second + 1)) || 0;
        if (lastRef.get(term) === ref) continue; // same company already recorded
        lastRef.set(term, ref);
        const postings = terms[term] ?? { refs: [], q: [] };
        postings.refs.push(ref);
        postings.q!.push(quality);
        terms[term] = postings;
      }
      const payload: ShardPayload = { terms };
      await writer.writeJson(folderFor("indexes", config.datasetVersion, `${kind}/${String(shard).padStart(4, "0")}.json`), payload);
      await rm(linesPath, { force: true });
    }
  };

  await indexPathIndex("exact", config.shards.exact);
  await indexPathIndex("prefix", config.shards.prefix);
  await indexPathIndex("token", config.shards.token);
  await indexPathIndex("trigram", config.shards.trigram);
  await indexPathIndex("ids", config.shards.ids);

  const stats: DatasetStats = {
    version: config.datasetVersion,
    generatedAt: new Date().toISOString(),
    companies: counters.uniqueCompanies,
    contacts: counters.uniqueContacts,
    companiesByIndustry: topBuckets(companyStats.byIndustry, 25),
    companiesByCountry: topBuckets(companyStats.byCountry, 25),
    companiesBySize: topBuckets(companyStats.bySize, 12),
    contactsByDesignation: topBuckets(contactStats.byDesignation, 25),
    contactsByDepartment: topBuckets(contactStats.byDepartment, 25),
    contactsBySeniority: topBuckets(contactStats.bySeniority, 12),
    contactCoverage: coverage,
  };
  await writer.writeJson(`manifests/${config.datasetVersion}/stats.json`, stats, false);

  const bytes = writer.objects.reduce(
    (total, object) => {
      if (object.key.startsWith("indexes/")) total.indexes += object.bytes;
      else if (object.key.startsWith("companies/")) total.companies += object.bytes;
      else if (object.key.startsWith("contacts/")) total.contacts += object.bytes;
      return total;
    },
    { indexes: 0, companies: 0, contacts: 0 },
  );

  const directory: IndexDirectory = {
    formatVersion: INDEX_FORMAT_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    version: config.datasetVersion,
    createdAt: new Date().toISOString(),
    shards: {
      exact: config.shards.exact,
      prefix: config.shards.prefix,
      token: config.shards.token,
      trigram: config.shards.trigram,
      ids: config.shards.ids,
      companyPartitions: companyPartitionIndex,
      contactPartitions: contactPartitionIndex,
    },
    counts: { companies: counters.uniqueCompanies, contacts: counters.uniqueContacts, indexedAliases: 0 },
    sources: config.sources.map((source) => source.id),
    bytes: { ...bytes, total: bytes.indexes + bytes.companies + bytes.contacts },
    fields: { company: ["name", "domain", "industry", "country", "city", "companySize", "revenue"], contact: ["fullName", "title", "email", "phone", "linkedinUrl", "country", "city"] },
  };
  await writer.writeJson(`indexes/${config.datasetVersion}/directory.json`, directory, false);

  const elapsedMs = Date.now() - startedAt;
  const manifest: DatasetVersionSummary = {
    version: config.datasetVersion,
    state: "validated",
    createdAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    normalizerVersion: NORMALIZER_VERSION,
    indexFormatVersion: INDEX_FORMAT_VERSION,
    counters,
    bytes: writer.objects.reduce((total, object) => total + object.bytes, 0),
    objectCount: writer.objects.length,
    validationPassed: false,
    notes: options.sampleLimit ? `Sample run limited to ${options.sampleLimit} records per source.` : undefined,
  };

  /* ------------------------------- validation ----------------------------- */

  emit({ stage: "validating", message: "validating generated objects" });
  const missing: string[] = [];
  for (const object of writer.objects) {
    const path = join(config.outputDir, object.key);
    const info = await stat(path).catch(() => null);
    if (!info) {
      missing.push(object.key);
      continue;
    }
    const body = await readFile(path);
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== object.sha256) missing.push(object.key);
  }

  const enoughShards = writer.objects.filter((object) => object.key.startsWith("indexes/")).length > 0;
  const bothSources = config.sources.every((source) => (counters.perSource[source.id]?.rowsRead ?? 0) > 0);
  const validation = {
    version: config.datasetVersion,
    passed: missing.length === 0 && enoughShards && bothSources,
    checkedAt: new Date().toISOString(),
    verifiedObjects: writer.objects.length - missing.length,
    missingObjects: missing,
    issues: [
      ...(missing.length ? [{ severity: "error" as const, code: "checksum_mismatch", message: `${missing.length} object(s) failed verification`, count: missing.length }] : []),
      ...(!enoughShards ? [{ severity: "error" as const, code: "no_index_objects", message: "No index shards were generated" }] : []),
      ...(!bothSources
        ? [
            {
              severity: "error" as const,
              code: "source_missing_rows",
              message: `Not every source contributed rows: ${config.sources
                .map((source) => `${source.id}=${counters.perSource[source.id]?.rowsRead ?? 0}`)
                .join(", ")}`,
            },
          ]
        : []),
      { severity: "info" as const, code: "row_sample", message: `${counters.rowsRead} rows read, ${counters.rowsRejected} rejected.` },
    ],
  };
  await writer.writeText(`manifests/${config.datasetVersion}/validation.json`, JSON.stringify(validation, null, 2));

  manifest.validationPassed = validation.passed;
  await writer.writeJson(`manifests/${config.datasetVersion}/manifest.json`, manifest, false);
  await writeFile(
    join(config.outputDir, "objects.jsonl"),
    writer.objects.map((object) => JSON.stringify(object)).join("\n"),
    "utf8",
  );

  emit({
    stage: "completed",
    rowsRead: counters.rowsRead,
    rowsRejected: counters.rowsRejected,
    companies: counters.uniqueCompanies,
    contacts: counters.uniqueContacts,
    message: validation.passed
      ? `index built and validated: ${counters.uniqueCompanies.toLocaleString()} companies, ${counters.uniqueContacts.toLocaleString()} contacts`
      : "index built but validation reported problems — see manifests/validation.json",
  });

  return { version: config.datasetVersion, counters, objects: writer.objects, directory, manifest, profiles, elapsedMs };
}

/* -------------------------------------------------------------------------- */
/* Upload + publish                                                           */
/* -------------------------------------------------------------------------- */

export interface UploadResult {
  uploaded: number;
  skipped: number;
  bytes: number;
}

/** Upload generated objects, skipping any object that is already identical. */
export async function uploadOutput(config: IndexerConfig, result: RunResult, onProgress?: (message: string) => void): Promise<UploadResult> {
  const credentials = credentialsFromEnv(config.upload?.bucket);
  if (!credentials) {
    throw new Error(
      "R2 credentials are not set. Export R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, or upload the output directory with rclone instead.",
    );
  }
  const client = new R2Client(credentials);
  const output: UploadResult = { uploaded: 0, skipped: 0, bytes: 0 };

  for (const object of result.objects) {
    const existing = await client.head(object.key);
    if (existing.exists && existing.size === object.bytes) {
      output.skipped += 1;
      continue;
    }
    const body = await readFile(join(config.outputDir, object.key));
    // `content-encoding: gzip` is required metadata, not decoration: the Worker
    // uses it (plus a magic-byte sniff) to decide whether to gunzip a shard.
    await client.put(
      object.key,
      body,
      object.gzip ? "application/json" : "application/json",
      4,
      object.gzip ? { contentEncoding: "gzip" } : undefined,
    );
    output.uploaded += 1;
    output.bytes += object.bytes;
    if (output.uploaded % 200 === 0) onProgress?.(`uploaded ${output.uploaded} objects (${(output.bytes / 1e6).toFixed(1)} MB)`);
  }

  // Progress object lets the Dataset page show a live status without listing.
  await client.putJson(
    `manifests/${config.datasetVersion}/progress.json`,
    {
      version: config.datasetVersion,
      stage: "completed",
      startedAt: result.manifest.createdAt,
      updatedAt: new Date().toISOString(),
      progress: 1,
      rowsRead: result.counters.rowsRead,
      rowsPerSecond: null,
      etaSeconds: 0,
      message: "Index uploaded and validated.",
      host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "local",
    },
    false,
  );

  return output;
}

/**
 * Publish a validated version by flipping the active pointer.
 *
 * The current pointer is read first so the version that was serving becomes
 * `previousVersion`: without that, the Dataset page would have no rollback
 * target and a bad publish could not be reverted in one click.
 */
export async function publishVersion(version: string, bucket?: string): Promise<{ previousVersion: string | null }> {
  const credentials = credentialsFromEnv(bucket);
  if (!credentials) throw new Error("R2 credentials are not set, so the active version cannot be published.");
  const client = new R2Client(credentials);

  let previousVersion: string | null = null;
  try {
    const current = await client.get("manifests/active.json");
    if (current.ok) {
      const parsed = (await current.json()) as { version?: string; previousVersion?: string | null };
      if (parsed?.version && parsed.version !== version) previousVersion = parsed.version;
      else if (parsed?.previousVersion && parsed.previousVersion !== version) previousVersion = parsed.previousVersion;
    }
  } catch {
    // A missing or unreadable pointer simply means there is nothing to roll back to.
  }

  await client.putJson(
    "manifests/active.json",
    {
      version,
      previousVersion,
      activatedAt: new Date().toISOString(),
      activatedBy: "local-indexer",
    },
    false,
  );
  return { previousVersion };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function topBuckets(map: Map<string, number>, limit: number): FacetBucket[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function trigrams(value: string): string[] {
  const padded = ` ${value} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i += 1) out.push(padded.slice(i, i + 3));
  return out;
}

function placeholderCompany(key: string, input: RawCompanyInput): Company {
  return {
    id: key,
    name: input.name,
    normalizedName: input.name.toLowerCase(),
    contactCount: 0,
    sources: [],
  };
}

/**
 * Contact ids are derived from the company id plus the email/LinkedIn/full-name
 * fingerprint, so re-running the indexer produces the same ids and two different
 * people with the same name are never collapsed into one record.
 */
function buildContactId(companyIdValue: string, contact: Contact): string {
  const fingerprint = contact.email ?? contact.linkedinUrl ?? `${contact.fullName}|${contact.title ?? ""}|${contact.source.row}`;
  return contactIdFor(`${companyIdValue}|${fingerprint}`);
}


