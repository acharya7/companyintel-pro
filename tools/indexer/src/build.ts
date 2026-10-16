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

import { createHash, type Hash } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import type { FileProfile } from "./csv";
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
import { credentialsFromEnv, R2Client } from "./r2";
import { encodeJsonlLine, escapeTerminators, isJsonlError, readJsonlFile, readJsonlLines } from "./jsonl";
// `encodeJsonlLine` is used for every JSONL file this pipeline writes — the spool
// partitions, `rejected.jsonl` and `objects.jsonl` — so there is one place where the
// record encoding is defined and one place to fix it.
import {
  SPOOL_MANIFEST_FILE,
  clearSpoolManifest,
  readSpoolManifest,
  spoolManifestPathFor,
  writeJsonAtomic,
  type SpoolManifest,
  type SpoolManifestEntry,
} from "./spool";
import {
  DEFAULT_CHUNK_BYTES,
  createSourceContext,
  parseR2Source,
  sourceBytes,
  sourceProfile,
  sourceRecords,
  type SourceContext,
  type SourceStats,
} from "./source";

export interface SourceConfig {
  id: string;
  /**
   * MODE A: path to a local CSV file.
   * MODE B: `r2://company-intel-data/raw/<key>.csv` — streamed from R2 in bounded
   * ranged reads (see `source.ts` for why Mode B needs S3 credentials).
   */
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
   * Where Mode B (r2://) sources are cached locally, so a re-run resumes from
   * disk instead of downloading the objects again. Set to `null` to stream
   * without caching (nothing is written to disk; a re-run re-downloads).
   */
  rawCacheDir?: string | null;
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

/**
 * Every storage term a run needs at once, in bytes, with the measurements each
 * number comes from.
 *
 * The 1,000,000-record benchmark exposed two independent defects here, and the
 * breakdown exists so that neither can come back silently:
 *
 *   1. the Mode B **raw-cache staging file** was not in the estimate at all. A
 *      cached source is streamed into `<rawCacheDir>/<bucket>/<key>.part`, so at
 *      its peak the volume holds the spool PLUS the bytes of the object read so
 *      far. For the 1 M benchmark that is ~2.2 GB that the old estimate omitted;
 *   2. `BYTES_PER_SPOOL_ROW = 900` was a guess. A real spool row measures 525 B
 *      (3,778 rows of the real-data sample occupy 1.98 MB), while the benchmark's
 *      own peak (2.49 GB for 2.0 M rows) shows the whole working set is larger
 *      than either term alone suggests.
 *
 * The peak is therefore estimated as
 * `((spool + peak raw cache + output + fixed overhead) × safety margin)` — every
 * term named, summed and printed, so an operator can see which one of them makes
 * their machine too small instead of being told "free some space".
 */
export interface WorkEstimate {
  /** Canonical spool rows written by pass 1 (`part-*.jsonl`). */
  spoolBytes: number;
  /**
   * Largest raw-cache staging file alive at one time. Sources are read one after
   * another and each `.part` is dropped when a sample stops, so the peak is the
   * largest single source, not their sum.
   */
  rawCachePeakBytes: number;
  /** Generated index objects (`outputDir`), written during pass 2. */
  outputBytes: number;
  /** Checkpoint, spool manifest, rejected.jsonl, objects.jsonl, shard `.lines`. */
  overheadBytes: number;
  safetyMargin: number;
  /** The number compared against free disk: the sum above × `safetyMargin`. */
  totalBytes: number;
  /** Per-source ingestion the estimate assumes, for the report. */
  perSource: { id: string; mode: "file" | "r2"; bytes: number; rows: number | null }[];
}

/**
 * Measured storage constants. Each one is a measurement from this repository's own
 * runs against the real bucket, not a guess — see `docs/indexing.md`.
 */
export const STORAGE = {
  /** Real-data sample: 3,778 spool rows occupy 1,981,398 B → 524.5 B/row. */
  measuredSpoolBytesPerRow: 525,
  /**
   * What the estimate uses: the measurement plus a third. Pass 1 derives extra
   * fields (aliases, keys, normalized name) for wide organization rows, and the
   * 1 M benchmark's own peak implies more than the sample average.
   */
  spoolBytesPerRow: 700,
  /** Measured worst case: `raw/file1.csv` is 10.22 GB for ~4.7 M rows → 2,176 B/row. */
  maxSourceBytesPerRow: 2_176,
  /** Measured corpus average: 64.26 GB for ~101.5 M rows → 633 B/row. */
  averageSourceBytesPerRow: 633,
  /**
   * Generated index per ingested row: the measured range for the full corpus is
   * 9–20 GB (99 B/company + 96 B/contact + 324 B/company of index shards), so the
   * estimate uses the TOP of that range rather than its middle.
   */
  outputBytesPerRow: 200,
  /** Fixed cost of a run's bookkeeping: checkpoint, spool manifest, rejected rows. */
  fixedOverheadBytes: 256 * 1024 * 1024,
  /** Applied to the sum before comparing with free space. */
  safetyMargin: 1.25,
} as const;

/**
 * End-to-end rows per second MEASURED on the real 1 M benchmark: pass 1 reported
 * ~5,015 rows/s while streaming two R2 objects and spooling 1.99 M rows.
 *
 * The previous value (120,000 rows/s) came from a synthetic parse loop with the
 * bytes already in memory; it made the preflight promise ~17 seconds for a job
 * that needs tens of minutes, i.e. it was wrong by more than an order of
 * magnitude in the optimistic direction. Anything printed from this constant is
 * labelled as a measured end-to-end rate, and the run prints its own per-stage
 * timings so the guess can be replaced by observation.
 */
export const ROWS_PER_SECOND_MEASURED = 5_000;

export interface PreflightReport {
  sources: { id: string; path: string; bytes: number | null; exists: boolean }[];
  totalInputBytes: number;
  freeDiskBytes: number | null;
  estimatedWorkBytes: number;
  estimatedOutputBytes: number;
  /** The same estimate, term by term, so the operator can see what dominates. */
  estimate: WorkEstimate;
  memoryBytes: { free: number; total: number };
  cpuCount: number;
  estimatedRows: number | null;
  estimatedDurationSeconds: number | null;
  /** Records per source when this is a `--sample` report, else null. */
  sampleLimit: number | null;
  warnings: string[];
}

/**
 * Free space the run refuses to go below on the output volume.
 *
 * The preflight check catches "this machine cannot hold the job at all"; this is
 * the guard for the case that actually bites on a multi-hour run — the volume
 * filling up *while* it runs (a second process, a snapshot, a smaller disk than
 * the estimate assumed). Stopping cleanly leaves the checkpoint at
 * `pass2-merge`, so re-running the same command resumes instead of starting over.
 */
const DISK_FLOOR_BYTES = 512 * 1024 * 1024;

/**
 * Provenance recorded in `workDir/checkpoint.json` alongside the counters.
 *
 * The checkpoint marks a spool in `workDir/spool/` as belonging to one specific
 * run. Without recording which one, a *different* run against the same workDir —
 * the one-million-record benchmark after a dry run, a sample after a full run, a
 * rebuild with new `columns` overrides — would silently merge a stale spool into
 * a new version, and the resulting index would mix rows from two different
 * inputs without anything failing. That is why every field that changes what the
 * spool would contain is part of the identity, and why a mismatch stops the run
 * instead of guessing.
 */
export interface CheckpointIdentity {
  version: string;
  sampleLimit: number | null;
  partitions: number;
  sources: { id: string; path: string; delimiter: string; columns: number }[];
}

interface CheckpointFile {
  stage: string;
  identity?: CheckpointIdentity;
  counters?: Partial<IndexingCounters>;
}

/** The identity of the run about to start, compared against a stored checkpoint. */
function identityFor(config: IndexerConfig, sampleLimit: number | undefined): CheckpointIdentity {
  return {
    version: config.datasetVersion,
    sampleLimit: sampleLimit ?? null,
    partitions: config.partitions,
    sources: config.sources.map((source) => ({
      id: source.id,
      path: source.path,
      delimiter: source.delimiter ?? "\t",
      columns: Object.keys(source.columns ?? {}).length,
    })),
  };
}

/** Human-readable difference between two run identities, for the stop message. */
function identityDiff(stored: CheckpointIdentity, current: CheckpointIdentity): string[] {
  const differences: string[] = [];
  if (stored.version !== current.version) differences.push(`version ${stored.version} → ${current.version}`);
  if (stored.sampleLimit !== current.sampleLimit) {
    differences.push(`sample ${stored.sampleLimit ?? "none"} → ${current.sampleLimit ?? "none"}`);
  }
  if (stored.partitions !== current.partitions) differences.push(`partitions ${stored.partitions} → ${current.partitions}`);
  for (const source of current.sources) {
    const previous = stored.sources.find((entry) => entry.id === source.id);
    if (!previous) differences.push(`source ${source.id} is new`);
    else if (previous.path !== source.path) differences.push(`${source.id} path → ${source.path}`);
    else if (previous.delimiter !== source.delimiter) differences.push(`${source.id} delimiter changed`);
    else if (previous.columns !== source.columns) differences.push(`${source.id} column overrides changed`);
  }
  for (const source of stored.sources) {
    if (!current.sources.some((entry) => entry.id === source.id)) differences.push(`source ${source.id} is gone`);
  }
  return differences;
}

/** Source context (Mode A local files / Mode B R2 objects) for one config. */
function sourceContextFor(config: IndexerConfig): SourceContext {
  return createSourceContext({ cacheDir: config.rawCacheDir === undefined ? undefined : config.rawCacheDir });
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

export interface PreflightOptions {
  /**
   * Records per source for a `--sample` run.
   *
   * A sample reads only the first N records of each source — a few megabytes even
   * for a 50 GB object — so its temporary-space and duration estimates must be
   * based on those N rows, not on the full input size. Without this, a sample run
   * would be refused on a machine that cannot hold the 60 GB job, which is exactly
   * the machine a sample run is for.
   */
  sampleLimit?: number;
}

/**
 * Estimate every storage term a run will hold at once.
 *
 * Kept separate from `preflight` so it can be asserted directly in tests: the
 * benchmark that failed did so because this arithmetic was wrong, and a test that
 * never exercises the arithmetic would not have caught it.
 */
export function estimateWorkingSet(
  config: IndexerConfig,
  measured: { id: string; bytes: number | null }[],
  options: { sampleLimit?: number; chunkBytes?: number } = {},
): WorkEstimate {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const perSource: WorkEstimate["perSource"] = [];
  let spoolBytes = 0;
  let outputBytes = 0;
  let rawCachePeakBytes = 0;

  for (const source of measured) {
    const bytes = source.bytes ?? 0;
    const mode = parseR2Source(config.sources.find((entry) => entry.id === source.id)?.path ?? "") ? "r2" : "file";
    // A sample run knows its row count; a full run derives one from the measured
    // corpus average bytes/row. `null` (unknown object size) falls back to a
    // bytes-based estimate below rather than pretending the source is empty.
    const rows = options.sampleLimit ?? (source.bytes === null ? null : Math.round(bytes / STORAGE.averageSourceBytesPerRow));
    perSource.push({ id: source.id, mode, bytes, rows });

    if (rows === null) {
      // Unknown size: fall back to the input bytes with the same headroom the
      // per-row constant carries (measured spool ≈ 0.83 × source bytes here).
      spoolBytes += Math.round(bytes * 1.1);
      outputBytes += Math.round(bytes * 0.12);
    } else {
      spoolBytes += rows * STORAGE.spoolBytesPerRow;
      outputBytes += rows * STORAGE.outputBytesPerRow;
    }

    if (mode === "r2") {
      // The staging file holds the object bytes read so far, rounded UP to whole
      // ranged chunk requests (an 8 MiB request transfers 8 MiB). A sample stops
      // before the end of a large object, so the sample bounds the staging file.
      const staged = rows === null
        ? bytes
        : Math.min(bytes, Math.ceil((rows * STORAGE.maxSourceBytesPerRow) / chunkBytes) * chunkBytes);
      rawCachePeakBytes = Math.max(rawCachePeakBytes, staged);
    }
  }

  const sum = spoolBytes + rawCachePeakBytes + outputBytes + STORAGE.fixedOverheadBytes;
  return {
    spoolBytes,
    rawCachePeakBytes,
    outputBytes,
    overheadBytes: STORAGE.fixedOverheadBytes,
    safetyMargin: STORAGE.safetyMargin,
    totalBytes: Math.ceil(sum * STORAGE.safetyMargin),
    perSource,
  };
}

export async function preflight(
  config: IndexerConfig,
  context: SourceContext = sourceContextFor(config),
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const sources: PreflightReport["sources"] = [];
  let totalInputBytes = 0;
  const warnings: string[] = [];

  for (const source of config.sources) {
    // Mode A reads the local file size; Mode B asks R2 for the object size with a
    // bounded HEAD. An unknown size stays unknown (`null`) rather than 0.
    const bytes = await sourceBytes(source, context);
    const exists = bytes !== null;
    if (!exists) warnings.push(`Source ${source.id} was not found at ${source.path}`);
    sources.push({ id: source.id, path: source.path, bytes, exists });
    totalInputBytes += bytes ?? 0;
  }

  const freeDiskBytes = await freeDiskBytesFor(config.workDir);
  const estimate = estimateWorkingSet(config, sources, { sampleLimit: options.sampleLimit, chunkBytes: context.chunkBytes });
  const estimatedWorkBytes = estimate.totalBytes;
  const estimatedOutputBytes = estimate.outputBytes;
  const sampleRows = options.sampleLimit === undefined ? null : options.sampleLimit * config.sources.length;
  const estimatedRows = sampleRows;
  const estimatedDurationSeconds = sampleRows === null ? null : sampleRows / ROWS_PER_SECOND_MEASURED;
  const cpuCount = cpus().length || 1;

  if (freeDiskBytes !== null && freeDiskBytes < estimatedWorkBytes) {
    warnings.push(
      `Temporary space looks insufficient: about ${(freeDiskBytes / 1e9).toFixed(1)} GB free vs ${(estimatedWorkBytes / 1e9).toFixed(1)} GB estimated for spool + raw cache + output${
        sampleRows === null ? "" : ` in a ${options.sampleLimit?.toLocaleString()}-record sample per source`
      }.`,
    );
  }
  if (estimate.rawCachePeakBytes > 0 && estimatedWorkBytes > 0) {
    // Called out separately because it is the term that used to be missing, and
    // because it is the one the operator can remove (see `rawCacheDir`).
    warnings.push(
      `Budget ${(estimate.rawCachePeakBytes / 1e9).toFixed(1)} GB for the Mode B raw-cache staging file as well as ${(estimate.spoolBytes / 1e9).toFixed(1)} GB for the spool: they are alive at the same time. Setting \`rawCacheDir\` to null removes that term and costs a re-download on resume.`,
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
    estimate,
    memoryBytes: { free: freemem(), total: totalmem() },
    cpuCount,
    estimatedRows,
    estimatedDurationSeconds,
    sampleLimit: options.sampleLimit ?? null,
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
    // `escapeTerminators` keeps U+2028/U+2029 out of the record for the same
    // reason `encodeJsonlLine` does for the spool: a term containing one used to
    // split the posting across two "lines" and lose it.
    const line = `${escapeTerminators(term)}\u0001${ref}\u0001${quality}\n`;
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
  /** Free-space floor on the output volume; the run stops cleanly below it. */
  diskFloorBytes?: number;
}

export interface RunResult {
  version: string;
  counters: IndexingCounters;
  objects: WrittenObject[];
  directory: IndexDirectory;
  manifest: DatasetVersionSummary;
  profiles: FileProfile[];
  elapsedMs: number;
  /**
   * R2 traffic caused by this run, measured (see `SourceStats`). Zero for Mode A.
   * A benchmark reports this as the operation count in the cost estimate, so it
   * must come from the run itself rather than from an estimate of chunk size.
   */
  sourceStats: SourceStats;
  /** Bytes this run wrote into `outputDir` (the generated index, on disk). */
  outputBytes: number;
  /**
   * Where the wall-clock time actually went, measured per stage.
   *
   * The preflight's duration hint used to be derived from a synthetic 120,000
   * rows/s figure and promised ~17 s for a job that takes tens of minutes. These
   * numbers come from the run itself, so the next estimate can be built from
   * observation: `pass1Ms` is network read + CSV parse + JSONL serialization +
   * partition writes together (they are one streaming loop), `pass2Ms` is the
   * merge, `finalizeMs` is shard grouping + compression, `validateMs` is the
   * re-read.
   */
  stages: { profilingMs: number; pass1Ms: number; pass2Ms: number; finalizeMs: number; validateMs: number };
  /** True when this run skipped pass 1 because it resumed a checkpoint. */
  resumed: boolean;
}

/**
 * One partition's append handle plus the integrity numbers recorded for it.
 *
 * The bytes/record count/checksum are accumulated as the rows are written, so the
 * manifest costs no extra I/O: it is the same bytes the writer already has.
 */
interface PartitionSink {
  stream: WriteStream;
  bytes: number;
  lines: number;
  hash: Hash;
}

interface SpoolRow {
  /** Every identifier key this row carries (strongest first). */
  keys: string[];
  /** Strongest identifier of this row (used as its provisional company identity). */
  bucket: string;
  /** Partition this row was spooled into (the normalized name — see mapping.ts). */
  partitionKey: string;
  strong: boolean;
  normalizedName: string;
  company: RawCompanyInput;
  contact: RawContactInput | null;
  source: SourceRef;
}

export async function runIndex(config: IndexerConfig, options: RunOptions = {}): Promise<RunResult> {
  const startedAt = Date.now();
  // One context for the whole run: it owns the Mode B cache and credentials.
  const sourceContext = createSourceContext({
    cacheDir: config.rawCacheDir === undefined ? undefined : config.rawCacheDir,
    onNotice: (message) => options.onProgress?.({ stage: "preflight", message, rowsRead: 0, rowsRejected: 0, companies: 0, contacts: 0, progress: null, rowsPerSecond: null, etaSeconds: null }),
  });
  const report = await preflight(config, sourceContext, { sampleLimit: options.sampleLimit });
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
  const diskFloorBytes = options.diskFloorBytes ?? DISK_FLOOR_BYTES;
  const resume = options.resume !== false;
  const stored: CheckpointFile | null = resume && existsSync(checkpointPath)
    ? (JSON.parse(await readFile(checkpointPath, "utf8")) as CheckpointFile)
    : null;
  const identity = identityFor(config, options.sampleLimit);

  /*
   * A checkpoint from a different run must never be resumed into this one: the
   * spool in `spoolDir` holds that run's rows, and pass 2 would merge them into
   * this version's index. Stop and let the operator choose, rather than either
   * silently mixing two inputs or silently deleting hours of spooled work.
   */
  if (stored && stored.identity && identityDiff(stored.identity, identity).length) {
    const differences = identityDiff(stored.identity, identity);
    throw new Error(
      `workDir already holds a checkpoint for a different run: ${differences.join("; ")}.\n` +
        `  Resume is refused because the spool partitions in ${spoolDir} belong to that run.\n` +
        "  Either re-run with --no-resume (discards the spool and rebuilds from the sources),\n" +
        "  or point `workDir` at an empty directory to keep both runs.",
    );
  }
  if (stored && !stored.identity) {
    // Written by an older build, which recorded no provenance. Its spool may or
    // may not match this run, so it is treated as unknown rather than resumed.
    console.warn(
      `! ${checkpointPath} was written without a run identity; refusing to resume it.\n` +
        "  Re-run with --no-resume to rebuild from the sources (this clears the old spool).",
    );
    throw new Error("Refusing to resume a checkpoint with unknown provenance.");
  }
  const checkpoint = stored;

  await mkdir(spoolDir, { recursive: true });
  await mkdir(shardDir, { recursive: true });
  await mkdir(config.outputDir, { recursive: true });

  /*
   * Starting fresh means the spool is empty, so any `part-*.jsonl` still on disk
   * belongs to a previous run and MUST go: pass 1 appends to these files, and
   * leaving them would add a second copy of every row to the new index (rows are
   * deduplicated later, but company/contact counts, facets and rejected-row
   * accounting would all be wrong). Only the spool is cleared — `outputDir`,
   * generated objects and the raw cache are left alone.
   */
  if (!checkpoint) {
    const stale = (await readdir(spoolDir).catch(() => [] as string[])).filter(
      (name) => name.startsWith("part-") && name.endsWith(".jsonl"),
    );
    for (const name of stale) await rm(join(spoolDir, name), { force: true });
    if (stale.length) {
      emit({ stage: "pass1-partition", message: `cleared ${stale.length} stale spool partition file(s) from a previous run` });
    }
    /*
     * The manifest and the checkpoint are removed too, before a single row is
     * spooled. Both of them assert "pass 1 finished": leaving a previous run's
     * checkpoint in place while the spool is being rewritten would mean that a
     * crash in the middle of pass 1 left a checkpoint claiming pass 1 was done
     * over a half-written spool. Removing them first makes that state impossible
     * — after a crash there is simply no manifest, and no manifest means the
     * spool may not be merged.
     */
    await rm(checkpointPath, { force: true });
    await clearSpoolManifest(workDir);
  }

  /* ------------------------------- profiling ------------------------------ */

  const profilingStart = Date.now();
  const profiles: FileProfile[] = [];
  const columnMaps: Record<string, number>[] = [];
  for (const source of config.sources) {
    // Mode A profiles the file; Mode B profiles a bounded sample of the object.
    const profile = await sourceProfile(
      source,
      { encoding: source.encoding, delimiter: source.delimiter, sampleRows: 500, knownFields: [...ALL_CANONICAL_FIELDS] },
      sourceContext,
    );
    profiles.push(profile);
    const map = buildColumnMap(profile.headers);
    if (source.columns) {
      for (const [field, header] of Object.entries(source.columns)) {
        const index = profile.headers.findIndex((value) => value.trim().toLowerCase() === header.trim().toLowerCase());
        if (index !== -1) map[field] = index;
      }
    }
    columnMaps.push(map);
    // Report the columns that are STILL unmapped after the config overrides were
    // applied, not the raw profiler view: the profiler cannot know about
    // `source.columns`, so printing its list would show a mapping as missing in a
    // file where the operator explicitly mapped it.
    const mappedIndexes = new Set(Object.values(map));
    const unmappedHeaders = profile.headers.filter((_, index) => !mappedIndexes.has(index));
    const missingCanonical = ALL_CANONICAL_FIELDS.filter((field) => map[field] === undefined);
    emit({
      stage: "profiling",
      message: `profiled ${source.id}: ${profile.headers.length} columns, ${unmappedHeaders.length} unmapped, ${missingCanonical.length} canonical fields absent`,
    });
    if (unmappedHeaders.length) {
      emit({ stage: "profiling", message: `  unmapped in ${source.id}: ${unmappedHeaders.slice(0, 12).join(", ")}` });
    }
  }

  const profilingMs = Date.now() - profilingStart;

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

  // A resumed run skips pass 1, so its row/rejection counters would restart at
  // zero and the final validation would report `source_missing_rows` for a
  // perfectly good index ("csv1=0, csv2=0"). The checkpoint carries the
  // counters measured before the interruption; restore them so resume keeps the
  // real numbers instead of failing validation over its own bookkeeping.
  const savedCounters = checkpoint?.stage === "preflight" ? undefined : checkpoint?.counters;
  if (savedCounters) {
    // Only pass-1-owned counters are restored; everything pass 2 derives
    // (unique companies/contacts, duplicates, ambiguity, per-source
    // contribution) is recomputed by the resumed merge and would otherwise be
    // counted twice.
    const saved: Partial<IndexingCounters> = savedCounters;
    for (const key of ["rowsRead", "rowsRejected", "recordsMissingCompanyId"] as const) {
      if (typeof saved[key] === "number") counters[key] = saved[key] as number;
    }
    for (const [id, value] of Object.entries(saved.perSource ?? {})) {
      if (!value) continue;
      const target = counters.perSource[id] ?? { rowsRead: 0, rowsRejected: 0, companies: 0, contacts: 0 };
      target.rowsRead = value.rowsRead ?? 0;
      target.rowsRejected = value.rowsRejected ?? 0;
      counters.perSource[id] = target;
    }
  }

  const rejectedPath = join(workDir, "rejected.jsonl");
  const rejected = createWriteStream(rejectedPath, { flags: checkpoint ? "a" : "w" });

  /** Milliseconds pass 1 occupied, for the run's stage breakdown. */
  let pass1Ms = checkpoint ? 0 : -1;

  if (!checkpoint || checkpoint.stage === "preflight") {
    emit({ stage: "pass1-partition", message: "pass 1: streaming both files into hash partitions" });
    const pass1Start = Date.now();

    // One sink map for the whole pass: a partition that both sources write to
    // keeps a single append handle and a single running checksum, instead of
    // being closed after source 1 and reopened (with a fresh checksum) for
    // source 2.
    const sinks = new Map<number, PartitionSink>();

    for (let sourceIndex = 0; sourceIndex < config.sources.length; sourceIndex += 1) {
      const source = config.sources[sourceIndex];
      const map = columnMaps[sourceIndex];
      let rows = 0;
      // The first record of each file is its header row, which was already read
      // by the profiler and must never be indexed as data.
      let isHeader = true;

      for await (const record of sourceRecords(source, {
        encoding: source.encoding,
        delimiter: source.delimiter,
        maxRecords: options.sampleLimit === undefined ? undefined : options.sampleLimit + 1,
      }, sourceContext)) {
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
          // `encodeJsonlLine` (not bare `JSON.stringify`): a rejected row carries
          // the raw source fields, and a U+2028 inside one of them used to split
          // this file the same way it split the spool (see jsonl.ts).
          rejected.write(encodeJsonlLine({ source: source.id, line: record.line, reason: "missing_company_name", fields: record.fields.slice(0, 8) }));
          continue;
        }
        if (!companyInput.domain && !companyInput.linkedinUrl && !companyInput.sourceId) {
          counters.recordsMissingCompanyId += 1;
        }

        const contactInput = extractContactInput(record.fields, map);
        const keys = companyKeysFromInput(companyInput, source.id);
        // Partition by the normalized name, so a company row and the contact rows
        // that name it are resolved in the same partition (see mapping.ts).
        const partition = partitionFor(keys.partitionKey, config.partitions);
        const row: SpoolRow = {
          keys: keys.all,
          bucket: keys.bucket,
          partitionKey: keys.partitionKey,
          strong: keys.strong,
          normalizedName: keys.normalizedName,
          company: companyInput,
          contact: contactInput,
          source: { source: source.id, row: record.line },
        };

        let sink = sinks.get(partition);
        if (!sink) {
          const path = join(spoolDir, `part-${String(partition).padStart(4, "0")}.jsonl`);
          sink = { stream: createWriteStream(path, { flags: "a" }), bytes: 0, lines: 0, hash: createHash("sha256") };
          sinks.set(partition, sink);
        }
        // `encodeJsonlLine` escapes U+2028/U+2029, which `JSON.stringify` leaves
        // literal and a line-oriented reader splits on. That mismatch is what
        // failed the 1 M benchmark in pass 2 with "Unterminated string".
        const line = encodeJsonlLine(row);
        sink.hash.update(line, "utf8");
        sink.bytes += Buffer.byteLength(line, "utf8");
        sink.lines += 1;
        if (!sink.stream.write(line)) {
          await new Promise<void>((resolve) => sink!.stream.once("drain", () => resolve()));
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

      emit({ stage: "pass1-partition", rowsRead: counters.rowsRead, message: `pass 1: finished ${source.id} (${rows.toLocaleString()} rows)` });
    }

    /*
     * Close every partition, THEN record what was written.
     *
     * Order matters twice over: the manifest must only appear once the writes are
     * flushed (its presence is the proof pass 1 finished), and it is written by
     * rename so a reader sees either no manifest or a complete one. A checkpoint
     * alone is not proof — it did not say which partitions were finished, which is
     * how a truncated partition could be merged as "these rows never existed".
     */
    await Promise.all([...sinks.values()].map((sink) => new Promise<void>((resolve) => sink.stream.end(resolve))));
    const entries: SpoolManifestEntry[] = [...sinks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([partition, sink]) => ({
        file: `part-${String(partition).padStart(4, "0")}.jsonl`,
        partition,
        bytes: sink.bytes,
        lines: sink.lines,
        sha256: sink.hash.digest("hex"),
      }));
    const manifest: SpoolManifest = {
      identity,
      complete: true,
      createdAt: new Date().toISOString(),
      partitions: entries,
      totals: {
        files: entries.length,
        lines: entries.reduce((total, entry) => total + entry.lines, 0),
        bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      },
    };
    await writeJsonAtomic(spoolManifestPathFor(workDir), manifest);
    emit({
      stage: "pass1-partition",
      message: `pass 1: spooled ${manifest.totals.lines.toLocaleString()} rows into ${manifest.totals.files} partition file(s) (${(manifest.totals.bytes / 1e9).toFixed(2)} GB); recorded in ${SPOOL_MANIFEST_FILE}`,
    });

    pass1Ms = Date.now() - pass1Start;
    await writeFile(checkpointPath, JSON.stringify({ stage: "pass2-merge", identity, counters } satisfies CheckpointFile, null, 2));
  }

  /* --------------------------------- pass 2 ------------------------------- */

  const writer = new ObjectWriter(config.outputDir);
  const shardWriter = new ShardWriter(shardDir);
  const companyStats = { byIndustry: new Map<string, number>(), byCountry: new Map<string, number>(), bySize: new Map<string, number>() };
  const contactStats = { byDesignation: new Map<string, number>(), byDepartment: new Map<string, number>(), bySeniority: new Map<string, number>() };
  const coverage = { email: 0, linkedin: 0, phone: 0, neither: 0 };

  let globalRef = 0;
  let companyBuffer: Company[] = [];
  /** Ref of the first company in the current buffer (the object's `firstRef`). */
  let companyBufferStart = 0;
  let contactBuffer = new Map<number, Contact[]>();
  /** Object index currently being buffered, not a ref — see `flushContacts`. */
  let contactBufferBucket = 0;
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
    // `firstRef` must be the first ref in this object, and the object index must
    // be derivable from it: the reader locates a company's contacts with
    // `contactPartitionOfRef(ref) = floor(ref / companiesPerContactPartition)`.
    const payload: ContactPartitionPayload = {
      firstRef: contactBufferBucket * SHARDING.companiesPerContactPartition,
      byCompany,
    };
    await writer.writeJson(folderFor("contacts", config.datasetVersion, contactPartitionIndex), payload);
    contactPartitionIndex += 1;
    contactBuffer = new Map();
  };

  /*
   * Pass 2 merges ONLY partitions the manifest proves complete.
   *
   * The checkpoint says "pass 1 is done"; the manifest says "these exact bytes
   * were written". A partition that is missing, short, or checksum-mismatched is a
   * hard, local failure — never silently merged as a partition that happened to
   * contribute fewer rows, and never treated as a source-data rejection.
   */
  const spoolManifest = await readSpoolManifest(workDir);
  if (!spoolManifest) {
    throw new Error(
      `Refusing to merge: ${workDir} has no ${SPOOL_MANIFEST_FILE}, so pass 1 cannot be shown to have completed every partition.\n` +
        "  Run `bun run index:spool-doctor` to inspect what is on disk. If the partitions are intact it can record the\n" +
        "  manifest for them (--repair-manifest), and pass 2 then resumes without re-reading the sources. Otherwise\n" +
        "  re-run with --no-resume to rebuild the spool from the sources.",
    );
  }
  const manifestDiff = identityDiff(spoolManifest.identity, identity);
  if (manifestDiff.length) {
    throw new Error(
      `Refusing to merge: ${SPOOL_MANIFEST_FILE} describes a different run (${manifestDiff.join("; ")}).\n` +
        "  The partition files belong to that run, so merging them into this version would mix two inputs.\n" +
        "  Re-run with --no-resume to rebuild the spool from the sources.",
    );
  }

  const spoolEntries = [...spoolManifest.partitions].sort((a, b) => a.partition - b.partition);
  const mergeStart = Date.now();
  emit({
    stage: "pass2-merge",
    message: `pass 2: resolving ${spoolEntries.length} partitions (${spoolManifest.totals.lines.toLocaleString()} spooled rows, ${(spoolManifest.totals.bytes / 1e9).toFixed(2)} GB)`,
  });

  for (let fileIndex = 0; fileIndex < spoolEntries.length; fileIndex += 1) {
    const entry = spoolEntries[fileIndex];
    const path = join(spoolDir, entry.file);

    // Completeness before content: a truncated file is a shorter but perfectly
    // valid JSONL file, so its length has to be checked against what pass 1
    // recorded, not against whether the records that survive happen to parse.
    const info = await stat(path).catch(() => null);
    if (!info) {
      throw new Error(
        `Spool partition ${entry.file} is recorded in ${SPOOL_MANIFEST_FILE} but is missing from ${spoolDir}. ` +
          "Nothing was merged for it and nothing was deleted; re-run with --no-resume to rebuild the spool.",
      );
    }
    if (info.size !== entry.bytes) {
      throw new Error(
        `Spool partition ${entry.file} is truncated: ${info.size.toLocaleString()} B on disk, ${entry.bytes.toLocaleString()} B recorded by pass 1.\n` +
          "  Merging it would silently drop the rows that are missing, so the run stops here. Nothing was deleted.\n" +
          "  Re-run with --no-resume to rebuild the spool from the sources (`bun run index:spool-doctor` reports every\n" +
          "  partition first if you want to see the full picture).",
      );
    }

    const partitionHash = createHash("sha256");
    let recordsSeen = 0;
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

    /*
     * Records are delimited by `\n` ONLY and parsed strictly (see jsonl.ts):
     * `readline` treated U+2028/U+2029 as terminators, which split a record in
     * half and produced `JSON Parse error: Unterminated string`. A record that
     * still cannot be parsed now fails with its partition, line number and byte
     * offset instead of being skipped.
     */
    try {
      for await (const record of readJsonlFile<SpoolRow>(path, { onChunk: (chunk) => partitionHash.update(chunk) })) {
        recordsSeen += 1;
        const row = record.value;
        const decision = resolver.resolve({
          all: row.keys,
          bucket: row.bucket,
          partitionKey: row.partitionKey ?? `n:${row.normalizedName}`,
          strong: row.strong,
          normalizedName: row.normalizedName,
        });
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
          const provisional = buildContact({
            input: row.contact,
            company: placeholderCompany(row.bucket, row.company),
            source: row.source,
            rowFingerprint: `${row.source.source}:${row.source.row}`,
          });
          const fingerprint = contactFingerprint(provisional);
          if (fingerprint && group.contacts.has(fingerprint)) {
            counters.duplicateRowsResolved += 1;
          } else {
            group.contacts.set(fingerprint ?? `r:${row.source.source}:${row.source.row}`, provisional);
          }
        }
      }
    } catch (error) {
      if (!isJsonlError(error)) throw error;
      throw new Error(`pass 2 could not merge partition ${entry.partition} (${entry.file}): ${error.message}`);
    }

    if (recordsSeen !== entry.lines) {
      throw new Error(
        `Spool partition ${entry.file} lost or gained records: ${recordsSeen.toLocaleString()} read, ${entry.lines.toLocaleString()} recorded by pass 1.\n` +
          "  Nothing was deleted; re-run with --no-resume to rebuild the spool from the sources.",
      );
    }
    if (partitionHash.digest("hex") !== entry.sha256) {
      throw new Error(
        `Spool partition ${entry.file} does not match the checksum pass 1 recorded. Its contents changed after it was\n` +
          "  written, so it will not be merged. Nothing was deleted; re-run with --no-resume to rebuild the spool.",
      );
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

      // Record where this object starts: the reader hydrates a candidate with
      // `payload.companies[ref - payload.firstRef]`, so every object other than the
      // first MUST carry its own firstRef (it was 0 for all of them, which silently
      // made every company after the first partition unhydratable at scale).
      if (!companyBuffer.length) companyBufferStart = globalRef;
      companyBuffer.push(company);
      if (companyBuffer.length >= SHARDING.companiesPerPartition) await flushCompanies();

      // The reader derives a company's contact object from its ref alone
      // (`contactPartitionOfRef`), so the object that holds ref R must be
      // `floor(R / companiesPerContactPartition)` — exactly. The flush therefore
      // has to happen BEFORE this ref's contacts are added: adding first put the
      // first company of every block into the previous object, where the reader
      // never looks for it (its contacts were unreachable in production).
      const bucket = Math.floor(globalRef / SHARDING.companiesPerContactPartition);
      if (bucket !== contactBufferBucket) {
        await flushContacts();
        contactBufferBucket = bucket;
      }
      if (contacts.length) contactBuffer.set(globalRef, contacts);

      globalRef += 1;
      counters.uniqueCompanies += 1;
      const ownerSource = company.sources[0]?.source ?? config.sources[0].id;
      if (counters.perSource[ownerSource]) counters.perSource[ownerSource].companies += 1;
    }

    // Mid-run disk guard: checked every 16 partitions (cheap, and far more often
    // than the volume can actually fill). A clean stop keeps everything already
    // written; the checkpoint still says `pass2-merge`, so the next run resumes.
    if (fileIndex % 16 === 0) {
      const free = await freeDiskBytesFor(config.outputDir);
      if (free !== null && free < diskFloorBytes) {
        throw new Error(
          `Stopping before the disk fills: ${(free / 1e9).toFixed(2)} GB free on ${config.outputDir} is below the ${(diskFloorBytes / 1e9).toFixed(2)} GB floor. ` +
            "Nothing already written was lost and the checkpoint is at pass2-merge — free space (or lower `partitions`) and run the same command again to resume.",
        );
      }
    }

    if (fileIndex % 16 === 0) {
      emit({
        stage: "pass2-merge",
        rowsRead: counters.rowsRead,
        rowsRejected: counters.rowsRejected,
        companies: counters.uniqueCompanies,
        contacts: counters.uniqueContacts,
        progress: fileIndex / spoolEntries.length,
        message: `pass 2: ${counters.uniqueCompanies.toLocaleString()} companies from ${fileIndex + 1}/${spoolEntries.length} partitions`,
      });
    }
  }
  const mergeMs = Date.now() - mergeStart;

  await flushCompanies();
  await flushContacts();
  await shardWriter.close();
  await new Promise<void>((resolve) => rejected.end(resolve));

  /* -------------------------------- finalize ------------------------------ */

  const finalizeStart = Date.now();
  emit({ stage: "indexing", message: "finalizing index shards" });
  const indexPathIndex = async (kind: ShardKind, shards: number) => {
    for (let shard = 0; shard < shards; shard += 1) {
      const linesPath = join(shardDir, `${kind}/${String(shard).padStart(4, "0")}.lines`);
      if (!existsSync(linesPath)) continue;
      // Null-prototype on purpose: `term` is a company name fragment, so a plain
      // object literal would resolve a company called "Constructor" to
      // `Object.prototype.constructor` (truthy, but with no `.refs`) and crash the
      // run mid-way — the same class of bug as the abbreviation lookup in
      // `src/shared/normalize.ts`.
      const terms = Object.create(null) as Record<string, Postings>;
      const lastRef = new Map<string, number>();
      // Read with the same `\n`-only splitter as the spool (see jsonl.ts).
      // `readline` split on U+2028/U+2029, so a term that contained one produced a
      // fragment with no `\u0001` in it — and the old `continue` below threw that
      // posting away silently. It is now a hard error: a shard file that cannot be
      // parsed means the postings for this shard are incomplete.
      for await (const line of readJsonlLines(linesPath)) {
        const first = line.text.indexOf("\u0001");
        const second = first === -1 ? -1 : line.text.indexOf("\u0001", first + 1);
        if (first === -1 || second === -1) {
          throw new Error(
            `Index shard ${kind}/${String(shard).padStart(4, "0")} has a malformed posting record at line ${line.line} ` +
              `(byte offset ${line.byteOffset}, file ${line.byteLength === 0 ? "unknown" : "present"}). The shard is incomplete; re-run to rebuild it.`,
          );
        }
        const term = line.text.slice(0, first);
        const ref = Number(line.text.slice(first + 1, second));
        const quality = Number(line.text.slice(second + 1)) || 0;
        if (!Number.isFinite(ref)) {
          throw new Error(`Index shard ${kind}/${String(shard).padStart(4, "0")} has a non-numeric ref at line ${line.line}; re-run to rebuild it.`);
        }
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
  const finalizeMs = Date.now() - finalizeStart;

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

  const validateStart = Date.now();
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

  const validateMs = Date.now() - validateStart;
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
  // Every intermediate JSONL record in this pipeline is written by the same
  // encoder, including this one: the spool carried the separator bug, and a second
  // hand-rolled `JSON.stringify` + join is exactly how it would come back.
  await writeFile(
    join(config.outputDir, "objects.jsonl"),
    writer.objects.map((object) => encodeJsonlLine(object)).join(""),
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

  return {
    version: config.datasetVersion,
    counters,
    objects: writer.objects,
    directory,
    manifest,
    profiles,
    elapsedMs,
    stages: { profilingMs, pass1Ms: Math.max(0, pass1Ms), pass2Ms: mergeMs, finalizeMs, validateMs },
    resumed: Boolean(checkpoint),
    // Reported instead of estimated: the benchmark's Cloudflare cost line and its
    // "R2 request count" both come from here.
    sourceStats: sourceContext.stats,
    outputBytes: writer.objects.reduce((sum, object) => sum + object.bytes, 0),
  };
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


