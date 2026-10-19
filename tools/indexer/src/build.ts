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
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, type WriteStream, writeSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";

import type { AssociationCounts, Company, Contact, DatasetStats, DatasetVersionSummary, FacetBucket, IndexingCounters, SourceRef, UnassignedContact } from "../../../src/shared/models";
import { NO_CLAIM_REF, associateContact, type AssociationCandidate, type AssociationRecord } from "../../../src/shared/association";
import { NORMALIZER_VERSION, normalizeAttribute, normalizeDomain, normalizeQuery } from "../../../src/shared/normalize";
import {
  INDEX_FORMAT_VERSION,
  SHARDING,
  folderFor,
  qualityByte,
  unassignedPartitionKey,
  type CompanyPartitionPayload,
  type ContactPartitionPayload,
  type CompanyDetailPayload,
  type CompanyDetailRecord,
  type ContactDetailPayload,
  type IndexDirectory,
  type ContactPostings,
  type ContactShardPayload,
  type Postings,
  type ShardPayload,
  type UnassignedPartitionPayload,
} from "../../../src/shared/search/index-format";
import { companyId as companyIdFor, contactId as contactIdFor, shardOf, stableHash } from "../../../src/shared/hash";
import type { FileProfile } from "./csv";
import {
  ALL_CANONICAL_FIELDS,
  CompanyResolver,
  buildColumnMap,
  capturedColumns,
  type CapturedColumn,
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
  mergeAttributes,
  type RawContactInput,
  type RawCompanyInput,
} from "./mapping";
import { credentialsFromEnv, R2Client } from "./r2";
import { encodeJsonlLine, escapeTerminators, isJsonlError, readJsonlFile, readJsonlLines } from "./jsonl";
// `encodeJsonlLine` is used for every JSONL file this pipeline writes — the spool
// partitions, `rejected.jsonl` and `objects.jsonl` — so there is one place where the
// record encoding is defined and one place to fix it.
import type { SpoolImportSource } from "./spool-import";
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
  DEFAULT_CHECKPOINT_MS,
  DEFAULT_CHECKPOINT_ROWS,
  DEFAULT_FRAME_BYTES,
  SPOOL_FORMAT_VERSION,
  SPOOL_PROGRESS_FILE,
  SPOOL_V1_FILE_RE,
  SPOOL_V2_FILE_RE,
  assertSchema,
  encodeSpoolV2Row,
  normalizeValues,
  prepareResume,
  progressPathFor,
  readProgress,
  readSpoolV2Partition,
  SpoolV2Writer,
  spoolV2SidecarName,
  writeProgress,
  writeSchema,
  type ResumePlan,
  type SpoolProgress,
  type SpoolSchema,
  type SpoolSourceSchema,
} from "./spool-v2";
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
   * Pass 1 intermediate encoding.
   *
   * `v2` (default) writes one compact source-value array per row into framed
   * gzip partitions with a durable progress ledger — see `spool-v2.ts` for why
   * the old `jsonl` shape produced 217 GB for 66 M rows. `jsonl` is kept only
   * so the legacy format can still be built and tested.
   */
  spoolFormat?: "v2" | "jsonl";
  /**
   * Hard ceiling for the local spool, in bytes. Pass 1 stops cleanly (with a
   * resumable ledger) rather than filling the volume. Defaults to no explicit
   * cap: the preflight's estimate is enforced instead.
   */
  spoolMaxBytes?: number;
  spool?: {
    /** Uncompressed bytes buffered per partition before a gzip frame is sealed. */
    frameBytes?: number;
    /** Rows between durable checkpoints (default 100,000). */
    checkpointRows?: number;
    /** Milliseconds between durable checkpoints (default 60,000). */
    checkpointMs?: number;
    /** TEST-ONLY: simulate ENOSPC once committed bytes pass this value. */
    faultAfterCommittedBytes?: number;
  };
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
  /** Conservative upper bound for the spool term (measurement × headroom). */
  spoolBytesUpper: number;
  /** The number compared against free disk: the upper-bound sum × `safetyMargin`. */
  totalBytes: number;
  /** Largest local spool the design allows while Pass 1 runs (the cap, if any). */
  spoolCapBytes: number | null;
  /** Per-source ingestion the estimate assumes, for the report. */
  perSource: { id: string; mode: "file" | "r2"; bytes: number; rows: number | null }[];
}

/**
 * Measured storage constants. Each one is a measurement from this repository's own
 * runs against the real bucket, not a guess — see `docs/indexing.md`.
 */
export const STORAGE = {
  /**
   * MEASURED v2 spool bytes per source byte, compressed.
   *
   * Measured on the real 20,000-records-per-source sample (2026-10-19):
   *
   *   csv1  18,605 spooled rows → 13.65 MB compressed / 46.8 MB uncompressed
   *         (733.6 B/row compressed; source row 1,734 B) → **0.423**;
   *   csv2  19,524 spooled rows →  3.91 MB compressed / 12.9 MB uncompressed
   *         (200.4 B/row compressed; source row 580 B)  → **0.346**;
   *   both  38,129 rows → 17.56 MB compressed (460.6 B/row; 1,565 B/row before
   *         gzip) — against v1's **3,273 B/row** (217 GB for 66.3 M rows).
   *
   * The per-source map is used first; the default covers a corpus whose ids are
   * not the production ones. Source type matters: contact rows compress far better
   * because they are narrow and highly repetitive.
   */
  spoolBytesPerSourceByte: 0.40,
  spoolBytesPerSourceByteById: { csv1: 0.423, csv2: 0.346 } as Record<string, number>,
  /** Conservative upper bound used for the preflight decision (measurement + ~30%). */
  spoolBytesPerSourceByteUpper: 0.52,
  /** Legacy v1 sample: 3,778 spool rows occupy 1,981,398 B → 524.5 B/row. */
  measuredSpoolBytesPerRow: 525,
  /**
   * v2: measured 460.6 B/row compressed on the real sample. Used only when the
   * estimate has a row count (a `--sample` run) but no source byte count.
   */
  spoolBytesPerRow: 480,
  spoolBytesPerRowUpper: 620,
  /** v1 rows, kept for the legacy scorer so a legacy build can still be estimated. */
  legacySpoolBytesPerRow: 700,
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
  /**
   * Bookkeeping cost of a run: checkpoint, spool manifest, rejected rows, objects.jsonl.
   *
   * Ceiling for a full-corpus run (the three files that scale with rows are all small —
   * the rejected list is the largest, and the measured full run's total was well under
   * this). It is a CEILING, not a flat term: `estimateWorkingSet` scales it down with the
   * number of rows, because a 3 MB fixture run does not need 256 MB of headroom and must
   * not be refused for lack of it on a volume that is merely busy.
   */
  fixedOverheadBytes: 256 * 1024 * 1024,
  /** Per-row share of that bookkeeping, so the estimate tracks the run's real size. */
  overheadBytesPerRow: 8,
  /** Floor for the bookkeeping term, so a tiny run still budgets a few MB. */
  minimumOverheadBytes: 4 * 1024 * 1024,
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
 * Pass-2 progress thresholds.
 *
 * A partition is read whole and merged before the next one starts, so "how long
 * has THIS step been running" is the only honest way to tell working from slow
 * from stuck:
 *
 *   - `PARTITION_HEARTBEAT_RECORDS` / `PARTITION_HEARTBEAT_MS`: while a partition
 *     is being consumed, report where inside it the merge is (at most every 15 s),
 *     so a large partition cannot look like a stall;
 *   - `SLOW_PARTITION_MS`: a single partition taking longer than this is reported
 *     as slow, with its row count and how far above the average it is — a partition
 *     is buffered whole before it is written, so a skewed one really is slower;
 *   - `STALL_PARTITION_MS`: beyond this the message says plainly that no other
 *     explanation is available and points at the volume.
 */
const PARTITION_HEARTBEAT_RECORDS = 25_000;
const PARTITION_HEARTBEAT_MS = 15_000;
const SLOW_PARTITION_MS = 10_000;
const STALL_PARTITION_MS = 120_000;

/**
 * Classify one completed pass-2 partition in plain language.
 *
 * Pass 2 has exactly one unit of work that can be slow — one partition, read whole
 * and merged before the next one starts — so "how long did that step take, and how
 * big was it" is the whole diagnostic. Kept pure and exported so the wording for
 * working / slow / stalled is asserted directly instead of by waiting ten seconds
 * for a real partition to trip the threshold.
 */
export function pass2StepNotes(params: { partitionMs: number; rows: number; averageRows: number }): string[] {
  const { partitionMs, rows, averageRows } = params;
  const skew = averageRows > 0 ? rows / averageRows : 1;
  if (partitionMs >= STALL_PARTITION_MS) {
    return [
      `this partition took ${(partitionMs / 1000).toFixed(0)}s and nothing in the merge loop explains that (${rows.toLocaleString()} rows), ` +
        "so treat it as a stall: check the volume the spool is on and the one the output is written to, and whether another process is using them",
    ];
  }
  if (partitionMs >= SLOW_PARTITION_MS) {
    return [
      skew >= 1.5
        ? `slow step, and expected: ${rows.toLocaleString()} rows is ${skew.toFixed(1)}x the ${Math.round(averageRows).toLocaleString()}-row average, and a partition is buffered whole before it is merged — not a stall`
        : `slow step at ${(partitionMs / 1000).toFixed(1)}s for ${rows.toLocaleString()} rows of an average size: I/O contention or a cold cache rather than a stall, unless it keeps growing`,
    ];
  }
  if (skew >= 3 && rows >= 1_000) {
    return [
      `${rows.toLocaleString()} rows in this partition, ${skew.toFixed(1)}x the average — merge cost grows with partition size, so expect the large ones to take longer`,
    ];
  }
  return [];
}

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

/**
 * The identity of the run about to start, compared against a stored checkpoint.
 *
 * Exported for the one explicit workflow that separates the SOURCE RUN IDENTITY
 * from the OUTPUT INDEX VERSION (`tools/indexer/src/spool-import.ts`): it needs to
 * build the same identity from the operator's config, with only the version
 * replaced. Ordinary resume keeps using it unchanged, version included.
 */
export function identityFor(config: IndexerConfig, sampleLimit: number | undefined): CheckpointIdentity {
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
export function identityDiff(stored: CheckpointIdentity, current: CheckpointIdentity): string[] {
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

/**
 * Read `workDir/checkpoint.json`.
 *
 * A damaged checkpoint is a hard stop and NOT the same thing as "no checkpoint".
 * If it were treated as absent, pass 1 would run again and APPEND a second copy of
 * every row to the spool partitions that are already there (they are opened with
 * flag `a`), silently doubling the dataset. Stopping leaves the spool untouched and
 * says exactly what to inspect. It is written atomically (`writeJsonAtomic`), so
 * this should be unreachable for anything written by this build.
 */
async function readCheckpoint(path: string): Promise<CheckpointFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read ${path} (${error instanceof Error ? error.message : String(error)}).\n` +
        "  Pass 1 cannot be shown to belong to this run without it, and re-reading the sources would append a second\n" +
        "  copy of every row to the existing spool. The spool itself is untouched: `bun run index:spool-doctor`\n" +
        "  inspects it read-only, and --no-resume rebuilds it from the sources if that is what you want.",
    );
  }
  try {
    return JSON.parse(text) as CheckpointFile;
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}), so the run it describes is\n` +
        "  unknown. The spool is untouched: `bun run index:spool-doctor` inspects it read-only, and --no-resume\n" +
        "  rebuilds it from the sources.",
    );
  }
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
  /**
   * Spooled rows for a Pass 2 rebuild from an existing spool.
   *
   * When set, the sources are NOT probed at all — no `stat`, no R2 HEAD, no
   * ranged read — because the rows are already on disk in the source spool. The
   * space estimate is then just this run's output plus bookkeeping (the spool is
   * not rewritten), which is also the honest number for that workflow.
   */
  importedRows?: number;
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
  const format: "v2" | "jsonl" = config.spoolFormat ?? "v2";
  let spoolBytes = 0;
  let spoolBytesUpper = 0;
  let outputBytes = 0;
  let rawCachePeakBytes = 0;
  /** Rows the estimate is based on; `null` as soon as one source's total is unknown. */
  let totalRows: number | null = 0;

  for (const source of measured) {
    const bytes = source.bytes ?? 0;
    const mode = parseR2Source(config.sources.find((entry) => entry.id === source.id)?.path ?? "") ? "r2" : "file";
    // A sample run knows its row count; a full run derives one from the measured
    // corpus average bytes/row. `null` (unknown object size) falls back to a
    // bytes-based estimate below rather than pretending the source is empty.
    const rows = options.sampleLimit ?? (source.bytes === null ? null : Math.round(bytes / STORAGE.averageSourceBytesPerRow));
    perSource.push({ id: source.id, mode, bytes, rows });
    if (rows === null) totalRows = null;
    else if (totalRows !== null) totalRows += rows;

    /*
     * The spool is estimated from SOURCE BYTES, not from a row count times an
     * average row size. That is the fix for the 217 GB surprise: the old model
     * multiplied an assumed row count by a 700 B/row constant measured before
     * full-column capture existed, so it missed a 4.7x expansion that depended on
     * how wide the source records are. A ratio per source byte cannot drift from
     * the data's own width.
     */
    if (options.sampleLimit === undefined && source.bytes !== null && format === "v2") {
      const ratio = STORAGE.spoolBytesPerSourceByteById[source.id] ?? STORAGE.spoolBytesPerSourceByte;
      spoolBytes += Math.round(bytes * ratio);
      spoolBytesUpper += Math.round(bytes * Math.max(ratio * 1.3, STORAGE.spoolBytesPerSourceByteUpper));
    } else {
      const rowCount = rows ?? Math.round(bytes / STORAGE.averageSourceBytesPerRow);
      const perRow = format === "v2" ? STORAGE.spoolBytesPerRow : STORAGE.legacySpoolBytesPerRow;
      const perRowUpper = format === "v2" ? STORAGE.spoolBytesPerRowUpper : STORAGE.legacySpoolBytesPerRow * 1.3;
      spoolBytes += rowCount * perRow;
      spoolBytesUpper += rowCount * perRowUpper;
    }

    if (rows === null) {
      outputBytes += Math.round(bytes * 0.12);
    } else {
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

  /*
   * Scale the bookkeeping term with the run.
   *
   * `rows` is the same figure the other terms are computed from (a sample's row count,
   * an import's recorded rows, or the whole corpus derived from object sizes), so the
   * overhead tracks it: 4 MB for a fixture, 256 MB for a full 100 M-row corpus.
   */
  const overheadBytes =
    totalRows === null
      ? STORAGE.fixedOverheadBytes
      : Math.min(STORAGE.fixedOverheadBytes, Math.max(STORAGE.minimumOverheadBytes, totalRows * STORAGE.overheadBytesPerRow));
  /*
   * The decision uses the UPPER bound, not the expected value. The failed run
   * passed a preflight computed from a best-case average; a full 6-hour job must
   * be refused on the number that can actually fill the disk. `totalBytes` also
   * includes the output written DURING pass 2, because the spool is still on disk
   * at that moment.
   */
  const sum = spoolBytesUpper + rawCachePeakBytes + outputBytes + overheadBytes;
  const cap = config.spoolMaxBytes ?? null;
  return {
    spoolBytes,
    spoolBytesUpper,
    rawCachePeakBytes,
    outputBytes,
    overheadBytes,
    safetyMargin: STORAGE.safetyMargin,
    totalBytes: Math.ceil(sum * STORAGE.safetyMargin),
    // A hard cap lowers the high-water mark only if it is below the upper bound;
    // the run refuses to exceed it, so the two numbers cannot disagree silently.
    spoolCapBytes: cap === null ? null : Math.min(cap, spoolBytesUpper),
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
  const importedRows = options.importedRows;

  if (importedRows === undefined) {
    for (const source of config.sources) {
      // Mode A reads the local file size; Mode B asks R2 for the object size with a
      // bounded HEAD. An unknown size stays unknown (`null`) rather than 0.
      const bytes = await sourceBytes(source, context);
      const exists = bytes !== null;
      if (!exists) warnings.push(`Source ${source.id} was not found at ${source.path}`);
      sources.push({ id: source.id, path: source.path, bytes, exists });
      totalInputBytes += bytes ?? 0;
    }
  } else {
    /*
     * An experimental Pass 2 rebuild: the spool already holds the rows, so the
     * sources are not touched. Marking them `exists` (unknown size) rather than
     * probing keeps this path free of R2 requests — the whole point of importing a
     * spool — and stops a machine whose objects are unreachable from failing a run
     * it could complete.
     */
    for (const source of config.sources) sources.push({ id: source.id, path: source.path, bytes: null, exists: true });
    warnings.push("Pass 2 rebuild from a verified spool: the source objects are not read and no spool is written.");
  }

  const freeDiskBytes = await freeDiskBytesFor(config.workDir);
  const estimate: WorkEstimate =
    importedRows === undefined
      ? estimateWorkingSet(config, sources, { sampleLimit: options.sampleLimit, chunkBytes: context.chunkBytes })
      : {
          spoolBytes: 0,
          spoolBytesUpper: 0,
          spoolCapBytes: null,
          rawCachePeakBytes: 0,
          outputBytes: Math.round(importedRows * STORAGE.outputBytesPerRow),
          overheadBytes: STORAGE.fixedOverheadBytes,
          safetyMargin: STORAGE.safetyMargin,
          totalBytes: Math.ceil((Math.round(importedRows * STORAGE.outputBytesPerRow) + STORAGE.fixedOverheadBytes) * STORAGE.safetyMargin),
          perSource: [],
        };
  const estimatedWorkBytes = estimate.totalBytes;
  const estimatedOutputBytes = estimate.outputBytes;
  const sampleRows = options.sampleLimit === undefined ? null : options.sampleLimit * config.sources.length;
  const estimatedRows = importedRows ?? sampleRows;
  const estimatedDurationSeconds = estimatedRows === null ? null : estimatedRows / ROWS_PER_SECOND_MEASURED;
  const cpuCount = cpus().length || 1;

  if (freeDiskBytes !== null && freeDiskBytes < estimatedWorkBytes) {
    warnings.push(
      `Temporary space looks insufficient: about ${(freeDiskBytes / 1e9).toFixed(1)} GB free vs ${(estimatedWorkBytes / 1e9).toFixed(1)} GB for the ` +
        `UPPER bound of spool + raw cache + output${sampleRows === null ? "" : ` in a ${options.sampleLimit?.toLocaleString()}-record sample per source`}.`,
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

type ShardKind = "exact" | "prefix" | "token" | "trigram" | "ids" | "contactToken" | "contactPrefix" | "contactTrigram";

const SHARD_KINDS: ShardKind[] = [
  "exact",
  "prefix",
  "token",
  "trigram",
  "ids",
  "contactToken",
  "contactPrefix",
  "contactTrigram",
];
const SHARD_KIND_INDEX: Record<ShardKind, number> = {
  exact: 0,
  prefix: 1,
  token: 2,
  trigram: 3,
  ids: 4,
  contactToken: 5,
  contactPrefix: 6,
  contactTrigram: 7,
};
/** Room for every shard number under one kind; keys stay small integers. */
const SHARD_KEY_STRIDE = 1 << 20;

/**
 * How much posting text one buffer may hold before it is written out.
 *
 * This is the only posting state the writer keeps in memory, and it is bounded in
 * BYTES rather than in postings, so the footprint is the same whether a company
 * emits 40 short postings or 4 long ones. 8 MiB is a rounding error next to the
 * per-partition `groups` map pass 2 already holds (~200 MB for a 1 M-row run) and
 * it is written out as one append per shard file — see `ShardWriter.flush`.
 */
export const SHARD_FLUSH_BYTES = 8 * 1024 * 1024;

/** What the posting writer did, so the cost claim is measurable, not asserted. */
export interface ShardWriteStats {
  /** Posting lines handed to the writer. */
  appends: number;
  /** Bytes of posting text written. */
  bytes: number;
  /** Shard files opened for append: one per (kind, shard) per flush. */
  fileOpens: number;
  /** Times a buffered batch was written out. */
  flushes: number;
  /** Highest number of buffered bytes at once (the memory bound). */
  peakBufferedBytes: number;
  /** Highest number of file handles open at once. */
  peakOpenHandles: number;
  /** Bytes of posting-shard objects flushed to R2 (Cloud Pass 2 only). */
  cloudPartBytes: number;
  /** Posting-shard objects flushed to R2 (Cloud Pass 2 only). */
  cloudParts: number;
}

/**
 * Appends `term␁ref␁quality` lines to one file per shard, batched by shard.
 *
 * WHY BATCHED (this is the 1 M benchmark's other half of being "extremely slow")
 * -----------------------------------------------------------------------------
 * The previous writer opened a `WriteStream` (asynchronously, with a `mkdir` in
 * front of it) for a shard that was not already in a 64-entry LRU cache, and the
 * real config has 1,792 shard files. One company's postings are spread across all
 * of them, so the cache could never hold the working set: measured on a 10,000-
 * company corpus with the real shard counts, the merge opened and closed
 * **550,958 streams for ~1.15 M postings**. On Windows each of those is an open,
 * a buffered write and a close against NTFS, which is why pass 2 appeared stalled.
 *
 * The fix is to decide where each line goes first and write each shard file once:
 * lines are buffered in memory grouped by shard, keys are visited in ascending
 * order when the buffer fills, and each group becomes ONE append of one Buffer to
 * one file descriptor. The file system sees ~1,800 large appends per flush instead
 * of ~280,000 small ones, and because the keys are always visited in the same
 * order the produced shard files are a pure function of the input.
 *
 * It also closes two correctness holes in the old writer:
 *   - `stream.end()` on an evicted handle was never awaited, so `close()` could
 *     return while a shard file was still being flushed (and the process could exit
 *     before it was); `flush()` here is synchronous and every fd is closed before
 *     it returns;
 *   - posting order within a shard used to depend on which streams happened to be
 *     open, where now it depends only on the emission order, which is itself
 *     deterministic (partitions in order, companies in ref order).
 */
class ShardWriter {
  private readonly groups = new Map<number, string[]>();
  private readonly readyDirs = new Set<string>();
  private bufferedBytes = 0;
  private openHandles = 0;
  readonly stats: ShardWriteStats = {
    appends: 0,
    bytes: 0,
    fileOpens: 0,
    flushes: 0,
    peakBufferedBytes: 0,
    peakOpenHandles: 0,
    cloudPartBytes: 0,
    cloudParts: 0,
  };

  constructor(
    private readonly root: string,
    private readonly flushBytes = SHARD_FLUSH_BYTES,
    /**
     * False in Cloud Pass 2: postings are flushed to R2 at the end of each
     * partition (or every few partitions) by the driver, so a size-triggered local
     * flush would create files nobody reads.
     */
    private readonly autoFlush = true,
  ) {}

  /**
   * Buffer one posting. Synchronous on purpose: the merge loop is one hot path and
   * an `await` per posting cost a microtask hop per posting on top of the I/O.
   */
  write(kind: ShardKind, shard: number, term: string, ref: number, quality: number): void {
    this.push(kind, shard, `${escapeTerminators(term)}\u0001${ref}\u0001${quality}`);
  }

  /**
   * Buffer one posting of the contact name index.
   *
   * Same file format as a company posting (`term␁target␁quality`) but the target is
   * a `p_…` contact id instead of a document ref, because a contact's position is
   * not derivable from its id: it lives inside its company's contact object.
   */
  writeContact(kind: ShardKind, shard: number, term: string, contactId: string, quality: number): void {
    this.push(kind, shard, `${escapeTerminators(term)}\u0001${contactId}\u0001${quality}`);
  }

  private push(kind: ShardKind, shard: number, record: string): void {
    const key = SHARD_KIND_INDEX[kind] * SHARD_KEY_STRIDE + shard;
    let group = this.groups.get(key);
    if (!group) {
      group = [];
      this.groups.set(key, group);
    }
    // `escapeTerminators` keeps U+2028/U+2029 out of the record for the same
    // reason `encodeJsonlLine` does for the spool: a term containing one used to
    // split the posting across two "lines" and lose it.
    const line = `${record}\n`;
    group.push(line);
    this.bufferedBytes += line.length;
    this.stats.appends += 1;
    this.stats.bytes += line.length;
    if (this.stats.peakBufferedBytes < this.bufferedBytes) this.stats.peakBufferedBytes = this.bufferedBytes;
    if (this.autoFlush && this.bufferedBytes >= this.flushBytes) this.flush();
  }

  /**
   * Send every buffered (kind, shard) group to R2 as one batch object.
   *
   * Posting order inside a group is preserved, and groups are written in the same
   * key order a local flush used, so the final shard is byte-identical to the
   * local build — that equality is what the cloud equivalence test asserts.
   */
  async flushToCloud(io: CloudMergeIo, batch: number): Promise<void> {
    if (!this.groups.size) return;
    const keys = [...this.groups.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      const lines = this.groups.get(key)!;
      const kind = SHARD_KINDS[Math.floor(key / SHARD_KEY_STRIDE)];
      const shard = key % SHARD_KEY_STRIDE;
      const body = Buffer.from(lines.join(""), "utf8");
      await io.writeShardPart(batch, kind, shard, body);
      this.stats.cloudPartBytes += body.length;
      this.stats.cloudParts += 1;
    }
    this.groups.clear();
    this.bufferedBytes = 0;
    this.stats.flushes += 1;
  }

  /** Write every buffered shard file: one open, one append, one close each. */
  flush(): void {
    if (!this.groups.size) return;
    const keys = [...this.groups.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      const lines = this.groups.get(key)!;
      const kind = SHARD_KINDS[Math.floor(key / SHARD_KEY_STRIDE)];
      const shard = key % SHARD_KEY_STRIDE;
      const dir = join(this.root, kind);
      if (!this.readyDirs.has(dir)) {
        mkdirSync(dir, { recursive: true });
        this.readyDirs.add(dir);
      }
      const path = join(dir, `${String(shard).padStart(4, "0")}.lines`);
      const body = Buffer.from(lines.join(""), "utf8");
      const fd = openSync(path, "a");
      this.stats.fileOpens += 1;
      this.openHandles += 1;
      if (this.stats.peakOpenHandles < this.openHandles) this.stats.peakOpenHandles = this.openHandles;
      try {
        // `writeSync` may write fewer bytes than requested, so the remainder is
        // written in a loop rather than assumed away.
        let written = 0;
        while (written < body.length) written += writeSync(fd, body, written, body.length - written);
      } finally {
        closeSync(fd);
        this.openHandles -= 1;
      }
    }
    this.groups.clear();
    this.bufferedBytes = 0;
    this.stats.flushes += 1;
  }

  /** Flush what is buffered. Synchronous: there is no pending write to wait for. */
  close(): void {
    if (this.autoFlush) this.flush();
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

/**
 * Serialise a shard payload as a stream of JSON fragments.
 *
 * WHY THIS EXISTS (the Pass 2 memory bound)
 * -----------------------------------------
 * `JSON.stringify(payload)` builds the WHOLE shard as one JavaScript string, and
 * `gzipSync` then holds it plus the raw Buffer plus the compressed output at once —
 * roughly 2.2x the payload in peak memory, on top of the payload itself. A
 * `token`/`contactToken` shard for a very common term is the worst case, and it is
 * exactly the case that would be measured last.
 *
 * This generator emits one term at a time, and frees each term's arrays as it
 * goes, so the peak is the largest SINGLE term plus the compressor state instead
 * of the largest whole shard plus two copies of it. The bytes are identical: the
 * `terms` object keys are emitted in insertion (posting) order, which JSON does
 * not care about, and every string goes through `JSON.stringify` so a term
 * containing a quote, a backslash or U+2028 stays correctly escaped.
 */
export async function* shardJsonParts(terms: Record<string, unknown>): AsyncIterable<Buffer> {
  const keys = Object.keys(terms);
  yield Buffer.from('{"terms":{', "utf8");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const value = terms[key];
    // Released before the next term is written: the payload shrinks as it streams.
    delete terms[key];
    yield Buffer.from(`${index ? "," : ""}${JSON.stringify(key)}:${JSON.stringify(value)}`, "utf8");
  }
  yield Buffer.from("}}", "utf8");
}

class ObjectWriter {
  readonly objects: WrittenObject[] = [];

  /**
   * `put` replaces the local write with a cloud write (Cloud Pass 2). The bytes,
   * checksum and manifest accounting are identical either way — only the
   * destination changes.
   */
  constructor(
    private readonly outputDir: string,
    private readonly put?: (key: string, body: Buffer, gzip: boolean) => Promise<void>,
  ) {}

  /**
   * Write a JSON document assembled from fragments, compressing as it streams.
   *
   * Same destination, same bytes and same accounting as `writeJson`, but the peak
   * memory is the compressor plus one fragment instead of the whole document (see
   * `shardJsonParts`). Used for the index shards, which are the only objects whose
   * size is driven by data the run cannot pre-size.
   */
  async writeJsonParts(key: string, parts: AsyncIterable<Buffer>, gzip = true): Promise<WrittenObject> {
    const body = gzip ? await gzipBufferFrom(parts) : Buffer.concat(await collectBuffers(parts));
    if (this.put) await this.put(key, body, gzip);
    else {
      const path = join(this.outputDir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
    const object: WrittenObject = {
      key,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      gzip,
    };
    this.objects.push(object);
    return object;
  }

  async writeJson(key: string, value: unknown, gzip = true): Promise<WrittenObject> {
    const raw = Buffer.from(JSON.stringify(value), "utf8");
    const body = gzip ? gzipSync(raw) : raw;
    if (this.put) await this.put(key, body, gzip);
    else {
      const path = join(this.outputDir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
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
    const body = Buffer.from(value, "utf8");
    if (this.put) await this.put(key, body, false);
    else {
      const path = join(this.outputDir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
    const object: WrittenObject = { key, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), gzip: false };
    this.objects.push(object);
    return object;
  }
}

/** Stream a sequence of buffers through gzip and return the compressed bytes. */
async function gzipBufferFrom(parts: AsyncIterable<Buffer>): Promise<Buffer> {
  const stream = createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolveDone, rejectDone) => {
    stream.on("end", () => resolveDone());
    stream.on("error", rejectDone);
  });
  for await (const part of parts) {
    // Respect backpressure so the compressor's own buffers stay bounded.
    if (!stream.write(part)) await new Promise<void>((resolveDrain) => stream.once("drain", () => resolveDrain()));
  }
  stream.end();
  await finished;
  return Buffer.concat(chunks);
}

async function collectBuffers(parts: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const part of parts) chunks.push(part);
  return chunks;
}

/* -------------------------------------------------------------------------- */
/* Pass-2 restart safety                                                      */
/* -------------------------------------------------------------------------- */

type Emit = (event: Partial<ProgressEvent> & { stage: ProgressEvent["stage"]; message: string }) => void;

/** What a pass-2 restart deleted before replaying the merge. */
export interface Pass2ResetReport {
  /** Temporary shard posting files removed from `workDir/shards` (all of them). */
  shardFiles: number;
  /** Generated output files removed for this version. */
  outputFiles: number;
  /** Bytes those output files occupied (for the disk-space report). */
  outputBytes: number;
  /** Version-scoped paths that were cleared, relative to `outputDir`. */
  cleared: string[];
}

/** Recursively count files and bytes under a path. A missing path counts as zero. */
async function measureTree(root: string): Promise<{ files: number; bytes: number }> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await measureTree(path);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += (await stat(path).catch(() => null))?.size ?? 0;
    }
  }
  return { files, bytes };
}

/**
 * A spool partition's length is a recorded fact, so check it before merging.
 *
 * Completeness before content: a truncated partition is a shorter but perfectly
 * valid JSONL file, so its length has to be compared with what pass 1 recorded,
 * not with whether the records that survive happen to parse.
 */
async function assertPartitionLength(entry: SpoolManifestEntry, spoolDir: string): Promise<void> {
  const info = await stat(join(spoolDir, entry.file)).catch(() => null);
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
}

/**
 * Delete everything pass 2 is about to regenerate, and nothing else.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * There is no partition-level resume: after an interruption pass 2 is replayed
 * from partition 1. But pass 2 *appends* and *overwrites*, and two kinds of state
 * survive an interrupted merge:
 *
 *   1. `workDir/shards/<kind>/<NNNN>.lines`, the temporary per-shard posting
 *      files. They are opened with flag `a`, so replaying partitions 1..k appended
 *      a second copy of every posting already written for them. The finalize step
 *      only drops a posting that repeats the *previous* line, so the duplicate
 *      refs survived into the published shard payloads: a company could be
 *      returned twice, and its quality byte counted twice;
 *   2. the generated output of the abandoned attempt — `companies|contacts|indexes|
 *      manifests/<version>/` and `objects.jsonl`. Anything left there is picked up
 *      by `validate`, by `upload` and by the local manifest even though this run
 *      never produced it, and a company/contact object from a *different* run of
 *      the same version would be hydrated as if it belonged to this one.
 *
 * Both are outputs of pass 2, so both are wiped before it runs again.
 *
 * WHAT IT MUST NOT TOUCH
 * ----------------------
 * The whole point of this path is that 5-6 hours of pass 1 survives, so the spool
 * (`workDir/spool`), `spool-manifest.json`, `checkpoint.json`, `rejected.jsonl`,
 * the raw cache, the credentials and every OTHER dataset version are inputs and are
 * left exactly as they are. Only paths this run's own pass 2 will rewrite are
 * removed, every path is checked to be inside `outputDir` (a dataset version is
 * operator-supplied, so `..` must not be able to point the delete elsewhere), and
 * `manifests/active.json` is never in the list.
 *
 * INTERRUPTION IS SAFE
 * --------------------
 * Each removal is an idempotent whole-tree delete and a missing path is not an
 * error, so a cleanup that is itself interrupted is simply finished by the next
 * start: the same paths are removed again before the merge begins. The deletions
 * also happen BEFORE any of this run's output is written, so an interrupted
 * cleanup can never leave "new" files mixed with "old" ones.
 */
async function resetPass2Output(
  config: IndexerConfig,
  paths: { shardDir: string },
  emit: Emit,
): Promise<Pass2ResetReport> {
  const report: Pass2ResetReport = { shardFiles: 0, outputFiles: 0, outputBytes: 0, cleared: [] };

  // 1. Temporary shard postings: pure pass-2 scratch, rebuilt from the spool.
  report.shardFiles = (await measureTree(paths.shardDir)).files;
  await rm(paths.shardDir, { recursive: true, force: true });
  await mkdir(paths.shardDir, { recursive: true });

  // 2. Generated output for THIS version only.
  const outputRoot = resolve(config.outputDir);
  const targets = [
    `companies/${config.datasetVersion}`,
    `contacts/${config.datasetVersion}`,
    `indexes/${config.datasetVersion}`,
    `manifests/${config.datasetVersion}`,
    "objects.jsonl",
  ];
  for (const relative of targets) {
    const target = resolve(outputRoot, relative);
    if (target === outputRoot || !target.startsWith(outputRoot + sep)) {
      throw new Error(
        `Refusing to reset ${target}: a dataset version may not point outside the output directory (${outputRoot}).\n` +
          "  Nothing was deleted by this run.",
      );
    }
    const measured = await measureTree(target);
    report.outputFiles += measured.files;
    report.outputBytes += measured.bytes;
    if (measured.files) report.cleared.push(relative);
    await rm(target, { recursive: true, force: true });
  }

  if (report.shardFiles || report.outputFiles) {
    emit({
      stage: "pass2-merge",
      message:
        `pass 2: reset ${report.shardFiles.toLocaleString()} temporary shard file(s) and ` +
        `${report.outputFiles.toLocaleString()} generated output file(s) (${(report.outputBytes / 1e9).toFixed(2)} GB) ` +
        `for version ${config.datasetVersion}; ${report.cleared.length ? report.cleared.join(", ") : "no generated objects"}`,
    });
  }
  return report;
}

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Cloud merge hooks: run Pass 2 from segment objects in R2 with bounded local disk.
 *
 * The merge itself is unchanged. This interface only relocates the three things
 * that used to require a whole-corpus local filesystem: the spool partition (one
 * partition is materialised at a time), the posting shards (flushed to R2 as
 * batch objects instead of local `.lines` files) and the generated index objects
 * (written straight to their final versioned keys).
 */
export interface CloudMergeIo {
  /** Materialise one partition into `workDir/spool/part-NNNN.jsonl`; return its bytes/rows/sha. */
  preparePartition(entry: { partition: number; file: string }): Promise<{ bytes: number; lines: number; sha256: string; segments: number }>;
  /** Delete the local partition after it has been merged (peak disk stays one partition). */
  releasePartition(entry: { partition: number; file: string }): Promise<void>;
  /** Update the durable cloud job state after a partition, and honour pause/abort. */
  onPartition(info: { partitionsDone: number; partitionsTotal: number; rows: number; companies: number; contacts: number; elapsedMs: number }): Promise<void>;
  /** One flushed posting-shard group, gzipped by the driver. */
  writeShardPart(batch: number, kind: ShardKind, shard: number, body: Buffer): Promise<void>;
  /** Read a shard's parts back, in batch order, as posting lines. */
  readShardParts(kind: ShardKind, shard: number): AsyncIterable<string>;
  /** Generated index object, written to its final versioned R2 key. */
  writeObject(key: string, body: Buffer, gzip: boolean): Promise<void>;
  /** Read one written object back for validation. */
  readObject(key: string): Promise<Buffer>;
  /**
   * Called when the merge has finished and every posting shard has been flushed,
   * before the index shards are built. The driver stores this so a restart during
   * the (long, R2-bound) finalize and validation phases can skip the merge.
   */
  onMergeComplete?(snapshot: CloudMergeResume): Promise<void>;
}

/**
 * Everything the finalize phase needs after the merge, serialisable to R2.
 *
 * Document refs are assigned sequentially while merging, so the merge itself
 * cannot be resumed half-way without producing a different index. Once the merge
 * has finished, though, the expensive part is behind us: this snapshot is the
 * whole input of finalize + validation, and a restart from it is exact.
 */
export interface CloudMergeResume {
  counters: IndexingCounters;
  companyStats: { byIndustry: [string, number][]; byCountry: [string, number][]; bySize: [string, number][] };
  contactStats: { byDesignation: [string, number][]; byDepartment: [string, number][]; bySeniority: [string, number][] };
  coverage: { email: number; linkedin: number; phone: number; neither: number };
  companyBuffer: Company[];
  companyBufferStart: number;
  contactBuffer: [number, Contact[]][];
  contactBufferBucket: number;
  companyPartitionIndex: number;
  contactPartitionIndex: number;
  companyDetailPartitions: number;
  contactDetailPartitions: number;
  globalRef: number;
  objects: WrittenObject[];
}



export interface RunOptions {
  /** Hard cap on records per source (sample runs). */
  sampleLimit?: number;
  onProgress?: (event: ProgressEvent) => void;
  /** Resume from the checkpoint when present (default true). */
  resume?: boolean;
  /** Free-space floor on the output volume; the run stops cleanly below it. */
  diskFloorBytes?: number;
  /**
   * Explicit permission to delete an existing spool before rebuilding it.
   *
   * `--no-resume` used to imply this, which is how an unclaimed 217 GB spool could
   * be cleared by a command whose purpose was to finish the index. Deletion now
   * needs its own flag; without it an existing spool is refused, never removed.
   */
  discardSpool?: boolean;
  /**
   * Merge a VERIFIED Pass 1 spool that lives in another work directory, without
   * profiling or reading any source.
   *
   * Only `pass2-from-spool` sets this, and only after
   * `prepareSpoolImport` (spool-import.ts) has validated the source checkpoint,
   * manifest, source configuration, partition count and every partition's length
   * and checksum. The experimental work directory already holds a derived
   * checkpoint and manifest for this output version, so `reuseSpool` is true and
   * the source spool is opened for reading only — this run never writes there.
   */
  spoolImport?: SpoolImportSource;
  /**
   * Rows already in the spool/segments, when Pass 2 runs without re-reading the
   * sources (Cloud Pass 2). Used only for the preflight estimate, so the merge does
   * not HEAD or stream the 64 GB sources again just to size a warning.
   */
  importedRows?: number;
  /**
   * Cloud Pass 2: merge R2 partition segments and write the index to R2 without a
   * full local spool or index. Set only by `tools/cloud/pass2.ts`.
   */
  cloud?: CloudMergeIo;
  /**
   * Resume a Cloud Pass 2 whose merge already finished: skip the partition loop and
   * rebuild only the index shards, manifests and validation from the R2 state the
   * snapshot records. Set only by `tools/cloud/pass2.ts` from its durable
   * checkpoint, and only after the shard parts have been verified to exist.
   */
  cloudResume?: CloudMergeResume;
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
  /** True when this run skipped pass 1 because it resumed a completed spool. */
  resumed: boolean;
  /**
   * What the pass-2 restart deleted before replaying the merge. All zeroes on a
   * run that started from an empty work directory.
   */
  pass2Reset: Pass2ResetReport;
  /** Posting-writer counters (lines, shard appends, peak buffer), measured. */
  shardWrite: ShardWriteStats;
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

/**
 * One contact row waiting for its Stage B decision.
 *
 * The decision is deliberately deferred until the whole partition has been read:
 * a contact can only be judged against *every* credible company in its name
 * family (including ones that appear later in the file), which is the whole
 * point of separating company resolution from contact association.
 */
interface PendingContact {
  /** Company record the row's own company name resolved to — the claim. */
  claimedRef: number;
  /** Normalized name of the row's own claim (defines the candidate family). */
  claimedName: string;
  /** Company name exactly as the source row carried it. */
  claimedCompanyName: string;
  input: RawContactInput;
  source: SourceRef;
  /** True when the row's own employer identity is owned by its company record. */
  identityClaimed: boolean;
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

/** One posting line plus its position, for the same diagnostics in both modes. */
interface PostingLine {
  text: string;
  line: number;
}

/**
 * Assemble one company index shard from posting lines.
 *
 * Shared by the local build (lines from `workDir/shards/*.lines`) and Cloud Pass 2
 * (lines from R2 batch objects), so both paths apply the exact same validation and
 * ordering. Returning the payload instead of writing it keeps the writer — local or
 * R2 — outside this function.
 */
async function companyShardPayload(lines: AsyncIterable<PostingLine>, label: string): Promise<ShardPayload> {
  // Null-prototype on purpose: `term` is a company name fragment, so a plain
  // object literal would resolve a company called "Constructor" to
  // `Object.prototype.constructor` (truthy, but with no `.refs`) and crash the
  // run mid-way — the same class of bug as the abbreviation lookup in
  // `src/shared/normalize.ts`.
  const terms = Object.create(null) as Record<string, Postings>;
  const lastRef = new Map<string, number>();
  for await (const line of lines) {
    const first = line.text.indexOf("\u0001");
    const second = first === -1 ? -1 : line.text.indexOf("\u0001", first + 1);
    if (first === -1 || second === -1) {
      throw new Error(
        `Index shard ${label} has a malformed posting record at line ${line.line}. The shard is incomplete; re-run to rebuild it.`,
      );
    }
    const term = line.text.slice(0, first);
    const ref = Number(line.text.slice(first + 1, second));
    const quality = Number(line.text.slice(second + 1)) || 0;
    if (!Number.isFinite(ref)) {
      throw new Error(`Index shard ${label} has a non-numeric ref at line ${line.line}; re-run to rebuild it.`);
    }
    if (lastRef.get(term) === ref) continue; // same company already recorded
    lastRef.set(term, ref);
    const postings = terms[term] ?? { refs: [], q: [] };
    postings.refs.push(ref);
    postings.q!.push(quality);
    terms[term] = postings;
  }
  return { terms };
}

/**
 * Assemble one contact-name shard. Same format, but the target is a `p_…` contact
 * id. A malformed line is a hard error: silently dropping it would make a person
 * unfindable while the index still claims to cover every contact.
 */
async function contactShardPayload(lines: AsyncIterable<PostingLine>, label: string): Promise<ContactShardPayload> {
  const terms = Object.create(null) as Record<string, ContactPostings>;
  const lastId = new Map<string, string>();
  for await (const line of lines) {
    const first = line.text.indexOf("\u0001");
    const second = first === -1 ? -1 : line.text.indexOf("\u0001", first + 1);
    if (first === -1 || second === -1) {
      throw new Error(`Contact index shard ${label} has a malformed posting record at line ${line.line}. The index is incomplete; re-run the build.`);
    }
    const term = line.text.slice(0, first);
    const id = line.text.slice(first + 1, second);
    const quality = Number(line.text.slice(second + 1)) || 0;
    if (!id) throw new Error(`Contact index shard ${label} has an empty contact id at line ${line.line}.`);
    if (lastId.get(term) === id) continue;
    lastId.set(term, id);
    const postings = terms[term] ?? { ids: [], q: [] };
    postings.ids.push(id);
    postings.q!.push(quality);
    terms[term] = postings;
  }
  return { terms };
}

/** Adapt R2 shard part strings to the same `{text, line}` shape local reading uses. */
async function* linesFromParts(parts: AsyncIterable<string>): AsyncIterable<PostingLine> {
  let line = 0;
  for await (const text of parts) {
    line += 1;
    yield { text, line };
  }
}

export async function runIndex(config: IndexerConfig, options: RunOptions = {}): Promise<RunResult> {
  const startedAt = Date.now();
  // One context for the whole run: it owns the Mode B cache and credentials.
  const sourceContext = createSourceContext({
    cacheDir: config.rawCacheDir === undefined ? undefined : config.rawCacheDir,
    onNotice: (message) => options.onProgress?.({ stage: "preflight", message, rowsRead: 0, rowsRejected: 0, companies: 0, contacts: 0, progress: null, rowsPerSecond: null, etaSeconds: null }),
  });
  const report = await preflight(config, sourceContext, {
    sampleLimit: options.sampleLimit,
    importedRows: options.spoolImport?.rows ?? options.importedRows,
  });
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
  // An experimental import merges a spool that stays in the SOURCE work directory;
  // this run's own workDir holds only its bookkeeping and shards.
  const spoolDir = options.spoolImport?.spoolDir ?? join(workDir, "spool");
  const shardDir = join(workDir, "shards");
  const checkpointPath = join(workDir, "checkpoint.json");
  /*
   * Free-space floor for the merge.
   *
   * An explicit `--disk-floor` always wins. Otherwise the default is ADAPTIVE: a flat
   * 512 MB reserve is the right protection for a run whose output is gigabytes, but it
   * is meaningless for a run whose whole output is 3 MB — it would refuse to finish on
   * a volume that is merely busy, which is how a full-but-healthy disk turns into a
   * failed build. The floor is therefore the smaller of the configured default and
   * 1.5x this run's own estimated output, with a 16 MB absolute minimum so a run can
   * never grind the volume to zero.
   */
  const adaptiveFloorBytes = Math.min(
    DISK_FLOOR_BYTES,
    Math.max(16 * 1024 * 1024, Math.round(report.estimatedOutputBytes * 1.5)),
  );
  const diskFloorBytes = options.diskFloorBytes ?? adaptiveFloorBytes;
  const resume = options.resume !== false;
  const stored: CheckpointFile | null = resume && existsSync(checkpointPath) ? await readCheckpoint(checkpointPath) : null;
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

  /*
   * Is pass 1 being reused, or is it about to run?
   *
   * Only a checkpoint that records the `pass2-merge` stage means "this spool is
   * complete" — that is the stage written after the spool manifest, which is the
   * file that actually proves it. This single flag decides three things that used
   * to be decided separately and inconsistently: whether the stale spool is
   * cleared, whether pass 1 runs at all, and whether `rejected.jsonl` is appended
   * to or rewritten. Getting them out of step is what could double every row in a
   * new spool.
   */
  let reuseSpool = checkpoint?.stage === "pass2-merge";
  /*
   * Belt-and-braces for the experimental import: an imported spool is NEVER cleared
   * or rebuilt by this run. Without this guard, a missing derived checkpoint (which
   * `pass2-from-spool` writes immediately before calling here) would take the
   * ordinary "starting fresh" path — and that path deletes `part-*.jsonl` in
   * `spoolDir`, which for an import is the SOURCE Pass 1 spool. The source/output
   * path check is the same class of protection for the generated index.
   */
  if (options.spoolImport) {
    const sameResolved = (a: string, b: string) => {
      const left = resolve(a);
      const right = resolve(b);
      return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    };
    if (!reuseSpool) {
      throw new Error(
        `Refusing to run: ${workDir} has no pass2-merge checkpoint, so the imported spool in ${spoolDir} cannot be shown to be ready to merge.\n` +
          "  An imported spool is never cleared or rebuilt, and nothing was read or written by this attempt. Re-run pass2-from-spool.",
      );
    }
    if (sameResolved(config.workDir, options.spoolImport.sourceWorkDir) || sameResolved(config.outputDir, options.spoolImport.sourceOutputDir)) {
      throw new Error(
        "Refusing to run: an experimental import must use its own work directory and output directory.\n" +
          "  Writing into the source locations would replace the original checkpoint or the validated index. Nothing was written.",
      );
    }
  }
  if (reuseSpool) {
    emit({
      stage: "pass2-merge",
      message: options.spoolImport
        ? `pass 2: experimental rebuild — merging the verified Pass 1 spool in ${spoolDir} into version ${identity.version}; ` +
          "the sources are NOT read and the source spool is not written."
        : `pass 2: reusing the Pass 1 spool in ${spoolDir} (checkpoint ${checkpointPath} records stage pass2-merge` +
          `${identity.version ? `, version ${identity.version}` : ""}); the sources are NOT read again.`,
    });
  }

  // `spoolDir` is read-only for an import; creating it is the ordinary run's job.
  if (!options.spoolImport) await mkdir(spoolDir, { recursive: true });
  await mkdir(shardDir, { recursive: true });
  await mkdir(config.outputDir, { recursive: true });

  /*
   * Pass 1 may only start on an EMPTY spool, or on one its own durable ledger
   * proves it was writing. Anything else is refused.
   *
   * This is the guard that fixes the destructive behaviour of the first full
   * run: a work directory with 217 GB of `part-*.jsonl` and no checkpoint used to
   * take the "starting fresh" path, which deleted every partition before reading
   * a row. An unclaimed spool is not stale — it is unrecovered work — so the run
   * stops and names the read-only inspection and recovery commands instead.
   */
  const spoolFormat: "v2" | "jsonl" = config.spoolFormat ?? "v2";
  const spoolFilesOnDisk = (await readdir(spoolDir).catch(() => [] as string[])).filter(
    (name) => SPOOL_V1_FILE_RE.test(name) || SPOOL_V2_FILE_RE.test(name),
  );
  let progress: SpoolProgress | null = null;
  let resumePlan: ResumePlan | null = null;
  let schema: SpoolSchema | null = null;

  if (!reuseSpool && resume && !options.discardSpool && spoolFormat === "v2") {
    progress = await readProgress(workDir);
    if (progress) {
      const differences = identityDiff(progress.identity, identity);
      if (differences.length) {
        throw new Error(
          `workDir already holds a Pass 1 progress ledger for a different run: ${differences.join("; ")}.\n` +
            "  The rows in that spool belong to the recorded run, so this run will not resume or overwrite them.\n" +
            "  Either use the matching configuration/version, point `workDir` at an empty directory, or — only if you\n" +
            "  really mean to delete the spool — pass --discard-spool. Nothing was read or written.",
        );
      }
      schema = progress.schema;
      if (progress.status === "pass1-complete" && existsSync(spoolManifestPathFor(workDir))) {
        // Pass 1 finished but the crash landed between the manifest and the
        // checkpoint. The manifest is the proof, so merge instead of rebuilding.
        reuseSpool = true;
      } else {
        resumePlan = await prepareResume(workDir, progress);
        emit({
          stage: "pass1-partition",
          message:
            `pass 1: resuming from ${progressPathFor(workDir)} — ` +
            progress.schema.sources
              .map((entry) => `${entry.id}: ${(progress!.sources[entry.id]?.rowsRead ?? 0).toLocaleString()} rows${progress!.sources[entry.id]?.complete ? " (complete)" : ""}`)
              .join(", ") +
            `; ${Object.keys(progress.partitions).length} partition(s), ${(Object.values(progress.partitions).reduce((total, entry) => total + entry.bytes, 0) / 1e6).toFixed(1)} MB committed`,
        });
      }
    }
  }

  if (!reuseSpool && !resumePlan) {
    if (spoolFilesOnDisk.length && !options.discardSpool) {
      throw new Error(
        `Refusing to start: ${spoolDir} already holds ${spoolFilesOnDisk.length} spool partition file(s), and there is no\n` +
          "  durable progress ledger or checkpoint that proves what they contain.\n" +
          "\n" +
          "  This is exactly the state a disk-full Pass 1 leaves behind. Deleting or rebuilding it automatically is how\n" +
          "  66 million parsed rows were almost lost once, so nothing will be touched.\n" +
          "\n" +
          "  Inspect it read-only:        bun run index:spool-doctor\n" +
          "  Assess recoverability:       bun tools/indexer/src/cli.ts recover-spool --assess --work-dir .indexer-work\n" +
          "  Convert a proven prefix:     bun tools/indexer/src/cli.ts recover-spool --apply --work-dir .indexer-work\n" +
          "                               --target-work-dir .indexer-work-v2\n" +
          "  Delete deliberately:         add --discard-spool (and only then is anything removed)",
      );
    }
    /*
     * Only an explicit --discard-spool removes rows. The manifest and the
     * checkpoint go too, before a single row is spooled: both assert "pass 1
     * finished", and leaving them over a half-written spool would let a crash
     * produce a checkpoint that claims a rewrite it never completed.
     */
    if (options.discardSpool) {
      const removable = (await readdir(spoolDir).catch(() => [] as string[])).filter(
        (name) => SPOOL_V1_FILE_RE.test(name) || SPOOL_V2_FILE_RE.test(name) || name.endsWith(".frames"),
      );
      for (const name of removable) await rm(join(spoolDir, name), { force: true });
      for (const name of [SPOOL_PROGRESS_FILE, "schema.json"]) await rm(join(spoolDir, name), { force: true });
      await rm(checkpointPath, { force: true });
      await clearSpoolManifest(workDir);
      progress = null;
      if (removable.length) {
        emit({ stage: "pass1-partition", message: `--discard-spool: removed ${removable.length} explicitly discarded spool file(s)` });
      }
    } else if (spoolFormat === "jsonl" && spoolFilesOnDisk.length) {
      // The legacy encoder has no ledger to resume from; an empty spool is the
      // only safe starting point without an explicit discard.
      throw new Error(
        `Refusing to start: ${spoolDir} holds spool files and spoolFormat is "jsonl", which has no resumable ledger.\n` +
          "  Inspect them (index:spool-doctor), or pass --discard-spool to remove them deliberately.",
      );
    }
  }

  /* ------------------------------- profiling ------------------------------ */

  const profilingStart = Date.now();
  const profiles: FileProfile[] = [];
  const columnMaps: Record<string, number>[] = [];
  /**
   * Unmapped columns of each source, in the file's own order.
   *
   * Recorded next to the column map because both are derived from the header row:
   * the map says which columns the canonical model consumes, and this says which
   * ones are carried verbatim on every record so no source field is lost.
   */
  const capturedBySource: CapturedColumn[][] = [];
  /*
   * A resumed run does not profile the sources, and that is not just a saving: the
   * column map exists to build the spool, and the spool is already built. Profiling
   * is a real read of every source (a bounded sample of a Mode B object is still a
   * ranged GET), so skipping it is what makes "pass 2 reuses Pass 1 without reading
   * the source data again" literally true — the merge then completes even if the
   * source files or objects are unreachable, which is exactly when an operator wants
   * to finish the index they already paid hours for.
   */
  if (reuseSpool) {
    emit({
      stage: "profiling",
      message: `profiling skipped: pass 1 is reused from ${spoolDir}, and the column mapping it used is already recorded in the spool`,
    });
  }
  if (schema) {
    // A resumed v2 run rebuilds the mapping from `spool/schema.json` instead of
    // profiling: the spool already contains rows written under that exact mapping,
    // and re-deriving it from a source that may have changed is the one thing that
    // could decode them differently.
    for (const recorded of schema.sources) {
      columnMaps.push(recorded.map);
      capturedBySource.push(recorded.captured.map((column) => ({ index: column.index, label: column.label })));
    }
    emit({ stage: "profiling", message: `profiling skipped: resuming with the column mapping recorded in spool/${"schema.json"}` });
  }
  for (const source of schema || reuseSpool ? [] : config.sources) {
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
    capturedBySource.push(capturedColumns(profile.headers, map));
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

  if (!schema) {
    /*
     * The schema is what makes a v2 row decodable: the source's column count, the
     * canonical field → column map, and the captured labels in file order. It is
     * written once, before the first row, so a resume never has to profile (and
     * cannot profile differently) — and it is what lets a recovered legacy spool be
     * read without its original config.
     */
    schema = {
      format: SPOOL_FORMAT_VERSION,
      sources: config.sources.map((source, index) => ({
        id: source.id,
        delimiter: profiles[index]?.delimiter ?? source.delimiter ?? "\t",
        columns: profiles[index]?.headers.length ?? 0,
        map: columnMaps[index] ?? {},
        captured: (capturedBySource[index] ?? []).map((column) => ({ index: column.index, label: column.label })),
      })),
    };
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
  const savedCounters = reuseSpool ? checkpoint?.counters : undefined;
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

  /*
   * A resumed v2 Pass 1 restores its counters from the progress ledger, which is
   * written at every checkpoint. The rows it skips were counted before the
   * interruption, so counting them again would inflate `rows read` and the
   * per-source contribution validation.
   */
  if (resumePlan && progress) {
    counters.rowsRead = resumePlan.rowsRead;
    counters.rowsRejected = resumePlan.rowsRejected;
    for (const source of progress.schema.sources) {
      const state = progress.sources[source.id];
      const target = counters.perSource[source.id] ?? { rowsRead: 0, rowsRejected: 0, companies: 0, contacts: 0 };
      target.rowsRead = state?.rowsRead ?? 0;
      target.rowsRejected = state?.rowsRejected ?? 0;
      counters.perSource[source.id] = target;
    }
  }

  const rejectedPath = join(workDir, "rejected.jsonl");
  // Appended only when this run reuses the spool it belongs to (nothing is written
  // to it in that case); a run that re-reads the sources starts the list over.
  const rejected = createWriteStream(rejectedPath, { flags: reuseSpool || resumePlan ? "a" : "w" });

  /** Milliseconds pass 1 occupied, for the run's stage breakdown. */
  let pass1Ms = reuseSpool ? 0 : -1;

  if (!reuseSpool) {
    const usingV2 = spoolFormat === "v2";
    if (usingV2 && !schema) throw new Error("internal: pass 1 has no spool schema");
    if (usingV2) writeSchema(workDir, schema!);
    emit({
      stage: "pass1-partition",
      message: usingV2
        ? "pass 1: streaming both files into framed-gzip hash partitions (format v2, compact rows + durable checkpoints)"
        : "pass 1: streaming both files into hash partitions (legacy jsonl encoding)",
    });
    const pass1Start = Date.now();

    // One sink map for the whole pass: a partition that both sources write to
    // keeps a single append handle and a single running checksum, instead of
    // being closed after source 1 and reopened (with a fresh checksum) for
    // source 2.
    const sinks = new Map<number, PartitionSink>();
    const writer = usingV2
      ? new SpoolV2Writer(spoolDir, schema!, {
          frameBytes: config.spool?.frameBytes ?? DEFAULT_FRAME_BYTES,
          faultAfterCommittedBytes: config.spool?.faultAfterCommittedBytes,
        })
      : null;
    // A resumed run must own the partitions it already committed, or its final
    // manifest would describe only the rows added after the restart.
    if (writer && progress) writer.adopt(Object.values(progress.partitions));
    const checkpointRows = config.spool?.checkpointRows ?? DEFAULT_CHECKPOINT_ROWS;
    const checkpointMs = config.spool?.checkpointMs ?? DEFAULT_CHECKPOINT_MS;
    const spoolLimit = config.spoolMaxBytes ?? null;

    /**
     * The ledger this run writes. A resume adopts the existing one (it is also the
     * proof the spool belongs to this run) and keeps appending to it.
     */
    const ledger: SpoolProgress | null = writer
      ? (progress ?? {
          format: SPOOL_FORMAT_VERSION,
          identity,
          schema: schema!,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "pass1",
          sources: Object.fromEntries(
            config.sources.map((source) => [source.id, { rowsRead: 0, rowsRejected: 0, complete: false }]),
          ),
          partitions: {},
          totals: { files: 0, rows: 0, bytes: 0 },
        })
      : null;
    if (ledger) writeProgress(workDir, ledger);

    /** Flush, fsync and record exactly which rows are now durable. */
    const checkpointNow = async (): Promise<void> => {
      if (!writer || !ledger) return;
      await writer.checkpoint();
      const partitions = writer.progress();
      ledger.partitions = Object.fromEntries(partitions.map((entry) => [String(entry.partition), entry]));
      ledger.totals = {
        files: partitions.length,
        rows: partitions.reduce((total, entry) => total + entry.rows, 0),
        bytes: partitions.reduce((total, entry) => total + entry.bytes, 0),
      };
      for (const source of config.sources) {
        const previous = ledger.sources[source.id];
        ledger.sources[source.id] = {
          rowsRead: counters.perSource[source.id]?.rowsRead ?? 0,
          rowsRejected: counters.perSource[source.id]?.rowsRejected ?? 0,
          complete: previous?.complete ?? false,
        };
      }
      writeProgress(workDir, ledger);
    };

    const diskFull = new Error(
      `Stopping before the volume fills: the local spool has reached ${(spoolLimit! / 1e9).toFixed(2)} GB (spoolMaxBytes).\n` +
        "  Everything committed is verified and the progress ledger is durable; re-run the same command to resume from\n" +
        "  that source row (it truncates only the uncommitted tail). Raise spoolMaxBytes, free space, or set\n" +
        "  `spoolFormat` to \"v2\" (the default) so the spool is compact.",
    );

    for (let sourceIndex = 0; sourceIndex < config.sources.length; sourceIndex += 1) {
      const source = config.sources[sourceIndex];
      const sourceSchema: SpoolSourceSchema | undefined = schema!.sources[sourceIndex];
      const map = columnMaps[sourceIndex] ?? sourceSchema?.map ?? {};
      const captured = capturedBySource[sourceIndex] ?? [];
      const columns = sourceSchema?.columns ?? 0;
      if (resumePlan?.completeSources.includes(source.id)) {
        emit({ stage: "pass1-partition", message: `pass 1: ${source.id} was already complete in the ledger (${(progress?.sources[source.id]?.rowsRead ?? 0).toLocaleString()} rows); not read again` });
        continue;
      }
      const skipRows = resumePlan?.skipRows[source.id] ?? 0;
      let rows = 0;
      let seen = 0;
      let rowsSinceCheckpoint = 0;
      let lastCheckpointAt = Date.now();
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
        seen += 1;
        /*
         * Rows below the durable checkpoint were already spooled and counted.
         * Skipping them (rather than re-writing and de-duplicating later) is what
         * makes a restart impossible to turn into a double-counted dataset.
         */
        if (seen <= skipRows) continue;
        rows += 1;
        counters.rowsRead += 1;
        counters.perSource[source.id].rowsRead += 1;
        rowsSinceCheckpoint += 1;

        const companyInput = extractCompanyInput(record.fields, map, captured);
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

        const keys = companyKeysFromInput(companyInput, source.id);
        // Partition by the normalized name, so a company row and the contact rows
        // that name it are resolved in the same partition (see mapping.ts).
        const partition = partitionFor(keys.partitionKey, config.partitions);

        if (writer) {
          writer.add(partition, encodeSpoolV2Row(sourceIndex, record.line, normalizeValues(record.fields, columns)));
        } else {
          const contactInput = extractContactInput(record.fields, map, captured);
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
        }

        if (writer && spoolLimit !== null && writer.committedBytes() + writer.bufferedBytes() > spoolLimit) {
          // Flush what is already buffered so no work is lost, then stop cleanly.
          await checkpointNow();
          throw diskFull;
        }

        if (writer && (rowsSinceCheckpoint >= checkpointRows || Date.now() - lastCheckpointAt >= checkpointMs)) {
          await checkpointNow();
          rowsSinceCheckpoint = 0;
          lastCheckpointAt = Date.now();
          emit({
            stage: "pass1-partition",
            rowsRead: counters.rowsRead,
            message: `pass 1: checkpoint — ${counters.rowsRead.toLocaleString()} rows durable across ${Object.keys(ledger!.partitions).length} partition(s), ${(ledger!.totals.bytes / 1e6).toFixed(1)} MB`,
          });
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

      if (ledger) {
        ledger.sources[source.id] = {
          rowsRead: counters.perSource[source.id]?.rowsRead ?? 0,
          rowsRejected: counters.perSource[source.id]?.rowsRejected ?? 0,
          complete: true,
        };
        await checkpointNow();
      }
      emit({ stage: "pass1-partition", rowsRead: counters.rowsRead, message: `pass 1: finished ${source.id} (${rows.toLocaleString()} rows this attempt)` });
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
    let entries: SpoolManifestEntry[];
    if (writer) {
      await writer.checkpoint();
      await writer.close();
      entries = writer.finalize().map((entry) => ({
        file: entry.file,
        partition: entry.partition,
        bytes: entry.bytes,
        lines: entry.rows,
        sha256: entry.sha256,
        frames: entry.frames,
      }));
      if (ledger) {
        const partitions = writer.progress();
        ledger.partitions = Object.fromEntries(partitions.map((entry) => [String(entry.partition), entry]));
        ledger.totals = {
          files: partitions.length,
          rows: partitions.reduce((total, entry) => total + entry.rows, 0),
          bytes: partitions.reduce((total, entry) => total + entry.bytes, 0),
        };
        ledger.status = "pass1-complete";
      }
    } else {
      await Promise.all([...sinks.values()].map((sink) => new Promise<void>((resolve) => sink.stream.end(resolve))));
      entries = [...sinks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([partition, sink]) => ({
          file: `part-${String(partition).padStart(4, "0")}.jsonl`,
          partition,
          bytes: sink.bytes,
          lines: sink.lines,
          sha256: sink.hash.digest("hex"),
        }));
    }
    const manifest: SpoolManifest = {
      format: writer ? SPOOL_FORMAT_VERSION : 1,
      ...(writer ? { schema: schema! } : {}),
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
    if (ledger) writeProgress(workDir, ledger);
    emit({
      stage: "pass1-partition",
      message: `pass 1: spooled ${manifest.totals.lines.toLocaleString()} rows into ${manifest.totals.files} partition file(s) (${(manifest.totals.bytes / 1e9).toFixed(2)} GB, ${(manifest.totals.bytes / Math.max(1, manifest.totals.lines)).toFixed(0)} B/row); recorded in ${SPOOL_MANIFEST_FILE}`,
    });

    pass1Ms = Date.now() - pass1Start;
    // Written through a temporary file and renamed: a checkpoint that is half
    // written (a crash, a full disk) is not a checkpoint, and the next start would
    // have no way to tell "pass 1 completed" from "this file is damaged".
    await writeJsonAtomic(checkpointPath, { stage: "pass2-merge", identity, counters } satisfies CheckpointFile);
  }

  /* --------------------------------- pass 2 ------------------------------- */

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
  const totalPartitions = spoolEntries.length;
  /** Mean rows per partition; a partition far above it is why one step is slower. */
  const averageLines = spoolManifest.totals.lines / Math.max(1, totalPartitions);
  const cloud = options.cloud;
  const mergeStart = Date.now();
  emit({
    stage: "pass2-merge",
    message: `pass 2: resolving ${totalPartitions} partitions (${spoolManifest.totals.lines.toLocaleString()} spooled rows, ${(spoolManifest.totals.bytes / 1e9).toFixed(2)} GB)`,
  });
  if (reuseSpool) {
    emit({
      stage: "pass2-merge",
      message:
        `pass 2: restarting at partition 1 of ${totalPartitions} on the preserved Pass 1 spool ` +
        `(${SPOOL_MANIFEST_FILE} verified: ${spoolManifest.totals.lines.toLocaleString()} rows in ${totalPartitions} files). ` +
        "This is a full replay, not a mid-partition resume, and the previous attempt's partial output is reset first, " +
        "so no company, contact or posting can be counted twice.",
    });
  }

  // Everything pass 2 is about to write is cleared BEFORE it writes anything, so
  // an interrupted merge can never be appended to (see `resetPass2Output`).
  //
  // Every partition's recorded length is checked first: the reset below deletes the
  // previous attempt's output, and discovering a truncated partition afterwards
  // would cost the operator a working artifact for nothing. (Record counts and
  // checksums still have to be verified while merging — those need a read.)
  if (cloud) {
    emit({
      stage: "pass2-merge",
      message: `pass 2: cloud mode — each of the ${totalPartitions} verified partitions is materialised alone from its R2 segments, merged, then deleted`,
    });
  } else {
    for (const entry of spoolEntries) await assertPartitionLength(entry, spoolDir);
  }
  /*
   * The manifest says how its rows are encoded. Format 2 rows are compact arrays
   * decoded through the recorded schema; format 1 rows are self-describing JSON
   * objects. Both go through the same merge below, so a legacy spool (including a
   * recovered one) produces the identical index.
   */
  const spoolEncoding: 1 | 2 = spoolManifest.format === 2 ? 2 : 1;
  const spoolSchema = spoolEncoding === 2 ? assertSchema(spoolManifest.schema, spoolManifestPathFor(workDir)) : null;
  emit({ stage: "pass2-merge", message: `pass 2: verified the recorded length of all ${totalPartitions} spool partitions (format ${spoolEncoding})` });
  // Cloud mode never writes a local index or local shards, so there is nothing to
  // reset locally; the driver refuses to run over a version whose manifest exists.
  const pass2Reset: Pass2ResetReport = cloud
    ? { shardFiles: 0, outputFiles: 0, outputBytes: 0, cleared: [] }
    : await resetPass2Output(config, { shardDir }, emit);

  const writer = new ObjectWriter(
    config.outputDir,
    cloud ? (key, body, gzip) => cloud.writeObject(key, body, gzip) : undefined,
  );
  const shardWriter = new ShardWriter(shardDir, undefined, !cloud);
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
  let companyDetailPartitions = 0;
  let contactDetailPartitions = 0;

  /*
   * Resume after a completed merge.
   *
   * The snapshot is only accepted when the driver has already verified that every
   * shard part it names is present in R2. Everything the finalize phase reads is
   * restored here, so finalize + validation produce exactly the objects a single
   * uninterrupted run would have produced, and the merge is not repeated.
   */
  const mergeResume = options.cloudResume;
  if (mergeResume) {
    Object.assign(counters, mergeResume.counters);
    companyStats.byIndustry = new Map(mergeResume.companyStats.byIndustry);
    companyStats.byCountry = new Map(mergeResume.companyStats.byCountry);
    companyStats.bySize = new Map(mergeResume.companyStats.bySize);
    contactStats.byDesignation = new Map(mergeResume.contactStats.byDesignation);
    contactStats.byDepartment = new Map(mergeResume.contactStats.byDepartment);
    contactStats.bySeniority = new Map(mergeResume.contactStats.bySeniority);
    coverage.email = mergeResume.coverage.email;
    coverage.linkedin = mergeResume.coverage.linkedin;
    coverage.phone = mergeResume.coverage.phone;
    coverage.neither = mergeResume.coverage.neither;
    companyBuffer = mergeResume.companyBuffer ?? [];
    companyBufferStart = mergeResume.companyBufferStart ?? 0;
    contactBuffer = new Map(mergeResume.contactBuffer ?? []);
    contactBufferBucket = mergeResume.contactBufferBucket ?? 0;
    companyPartitionIndex = mergeResume.companyPartitionIndex;
    contactPartitionIndex = mergeResume.contactPartitionIndex;
    companyDetailPartitions = mergeResume.companyDetailPartitions;
    contactDetailPartitions = mergeResume.contactDetailPartitions;
    globalRef = mergeResume.globalRef;
    writer.objects.push(...mergeResume.objects);
    emit({
      stage: "pass2-merge",
      message:
        `pass 2: resuming after a completed merge — ${mergeResume.counters.uniqueCompanies.toLocaleString()} companies, ` +
        `${mergeResume.counters.uniqueContacts.toLocaleString()} contacts and ${mergeResume.objects.length.toLocaleString()} objects were already ` +
        "written; only the index shards, manifests and validation are rebuilt.",
    });
  }

  /**
   * Write one company partition as a SEARCH PROJECTION plus its detail object.
   *
   * The two halves are written together so they cannot drift: same `firstRef`, same
   * record order, same object index. Everything a search matches, ranks, filters or
   * displays stays in the projection; `attributes` (every source column) and
   * `facets` go to `details/`, which only a record view reads. This is what makes
   * search bytes independent of the corpus's column count.
   */
  const flushCompanies = async () => {
    if (!companyBuffer.length) return;
    const records: (CompanyDetailRecord | null)[] = companyBuffer.map((company) => {
      const detail: CompanyDetailRecord = {};
      if (company.attributes) detail.attributes = company.attributes;
      if (company.facets) detail.facets = company.facets;
      return detail.attributes || detail.facets ? detail : null;
    });
    const projection = companyBuffer.map((company) => {
      const copy = { ...company };
      delete copy.attributes;
      delete copy.facets;
      return copy;
    });
    const payload: CompanyPartitionPayload = { firstRef: companyBufferStart, companies: projection };
    await writer.writeJson(folderFor("companies", config.datasetVersion, companyPartitionIndex), payload);
    if (records.some(Boolean)) {
      const detail: CompanyDetailPayload = { firstRef: companyBufferStart, records };
      await writer.writeJson(folderFor("companyDetails", config.datasetVersion, companyPartitionIndex), detail);
      companyDetailPartitions += 1;
    }
    companyPartitionIndex += 1;
    companyBuffer = [];
  };

  /**
   * Write one contact partition as a projection plus its detail object.
   *
   * Contacts lose only `attributes`; every canonical field, the association record
   * and the source ref stay in the projection, because lists, filters, ranking and
   * the result rows all use them.
   */
  const flushContacts = async () => {
    if (!contactBuffer.size) return;
    const byCompany: Record<string, Contact[]> = {};
    const detailsByCompany: Record<string, (Record<string, string> | null)[]> = {};
    for (const [ref, contacts] of contactBuffer) {
      detailsByCompany[String(ref)] = contacts.map((contact) => contact.attributes ?? null);
      byCompany[String(ref)] = contacts.map((contact) => {
        const copy = { ...contact };
        delete copy.attributes;
        return copy;
      });
    }
    // `firstRef` must be the first ref in this object, and the object index must
    // be derivable from it: the reader locates a company's contacts with
    // `contactPartitionOfRef(ref) = floor(ref / companiesPerContactPartition)`.
    const payload: ContactPartitionPayload = {
      firstRef: contactBufferBucket * SHARDING.companiesPerContactPartition,
      byCompany,
    };
    await writer.writeJson(folderFor("contacts", config.datasetVersion, contactPartitionIndex), payload);
    if (Object.values(detailsByCompany).some((list) => list.some(Boolean))) {
      const detail: ContactDetailPayload = { firstRef: payload.firstRef, byCompany: detailsByCompany };
      await writer.writeJson(folderFor("contactDetails", config.datasetVersion, contactPartitionIndex), detail);
      contactDetailPartitions += 1;
    }
    contactPartitionIndex += 1;
    contactBuffer = new Map();
  };

  /*
   * Pass 2 merges ONLY partitions the manifest proves complete — checked above,
   * before the restart reset, so an unverifiable spool can never cost the output
   * that is already on disk.
   */

  /** Timestamp of the last progress or heartbeat line, so heartbeats cannot spam. */
  let lastEmitAt = mergeStart;

  for (let fileIndex = mergeResume ? spoolEntries.length : 0; fileIndex < spoolEntries.length; fileIndex += 1) {
    const entry = spoolEntries[fileIndex];
    const path = join(spoolDir, entry.file);
    const partitionStart = Date.now();

    // Re-checked here as well as before the reset: the file could have changed
    // while earlier partitions were merging. In cloud mode the partition does not
    // exist yet: `preparePartition` concatenates its segment objects into this one
    // file and returns the length/rows/checksum those segments record, so the same
    // integrity rules still apply.
    let expectations = entry;
    if (cloud) {
      const prepared = await cloud.preparePartition(entry);
      expectations = { ...entry, bytes: prepared.bytes, lines: prepared.lines, sha256: prepared.sha256 };
      emit({
        stage: "pass2-merge",
        message: `pass 2: partition ${entry.partition} materialised from ${prepared.segments} segment(s) — ${prepared.bytes.toLocaleString()} bytes, ${prepared.lines.toLocaleString()} rows`,
      });
    } else {
      await assertPartitionLength(entry, spoolDir);
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
        /**
         * `source:row` of every source ref already in `sources`.
         *
         * A linear `sources.some(...)` scan per record is O(rows²) for one company
         * (a company with 5,000 contact rows does 12.5 M comparisons), which is the
         * kind of cost that only shows up on real data — the fixture has one or two
         * refs per company. A Set makes the same decision in constant time.
         */
        sourceKeys: Set<string>;
        ambiguous: boolean;
        strong: boolean;
        normalizedName: string;
      }
    >();
    /**
     * Every contact row of this partition, awaiting its association decision.
     *
     * Memory is the same as before — this is exactly the set of contact rows the
     * merge already had to hold to deduplicate them — but the decision itself now
     * happens after the last row of the partition has been read.
     */
    const pendingContacts: PendingContact[] = [];
    /**
     * Unresolved contacts already preserved in THIS partition, by claimed name and
     * fingerprint. A per-partition set: everything that can be a duplicate of the
     * same person is written to the same object, so the set is bounded by the
     * partition rather than by the dataset.
     */
    const unresolvedSeen = new Set<string>();

    /*
     * Records are delimited by `\n` ONLY and parsed strictly (see jsonl.ts):
     * `readline` treated U+2028/U+2029 as terminators, which split a record in
     * half and produced `JSON Parse error: Unterminated string`. A record that
     * still cannot be parsed now fails with its partition, line number and byte
     * offset instead of being skipped.
     */
    try {
      /** One iterator shape for both encodings, so the merge is written once. */
      const rowsForPartition = async function* (): AsyncGenerator<{ value: SpoolRow }> {
        if (spoolEncoding === 2) {
          const decoder = readSpoolV2Partition(
            path,
            join(spoolDir, spoolV2SidecarName(entry.partition)),
            spoolSchema!,
            entry.partition,
            { onChunk: (chunk) => partitionHash.update(chunk) },
          );
          for await (const row of decoder) yield { value: row as unknown as SpoolRow };
          return;
        }
        for await (const record of readJsonlFile<SpoolRow>(path, { onChunk: (chunk) => partitionHash.update(chunk) })) {
          yield { value: record.value };
        }
      };
      for await (const record of rowsForPartition()) {
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
            sourceKeys: new Set(),
            ambiguous: decision.ambiguous,
            strong: row.strong,
            normalizedName: row.normalizedName,
          };
          groups.set(decision.ref, group);
        } else {
          /*
           * A later row for an existing company must not lose its columns.
           *
           * The group's canonical input stays first-row-wins (that is the identity
           * evidence), but the captured attributes are unioned: a company seen in
           * both source files, or twice in one file, carries every column of every
           * row. `mergeAttributes` keeps a surname-free header for the first value
           * and suffixes only genuine collisions.
           */
          group.input.attributes = mergeAttributes(group.input.attributes, row.company.attributes, row.source.source);
        }
        for (const key of row.keys) group.keys.add(key);
        const sourceKey = `${row.source.source}\u0000${row.source.row}`;
        if (!group.sourceKeys.has(sourceKey)) {
          group.sourceKeys.add(sourceKey);
          group.sources.push(row.source);
        }
        if (row.contact) {
          /*
           * Stage B is deliberately deferred to the end of the partition.
           *
           * Attaching the contact here — to the record its own row resolved to —
           * was the defect this change removes: the row's company NAME was the
           * only thing deciding the employer, so a person row naming a company
           * that shares its name with five others was attached to whichever
           * record happened to be resolved first, and the email domain, country
           * and city that could distinguish them were never consulted.
           */
          pendingContacts.push({
            claimedRef: decision.ref,
            claimedName: row.normalizedName,
            claimedCompanyName: row.company.name,
            input: row.contact,
            source: row.source,
            identityClaimed: decision.identityClaimed,
          });
        }

        // Heartbeat: a partition is read and merged in one go, so without this a
        // very large partition looks exactly like a stall — no output, no update.
        // It reports the position INSIDE the partition, so the percentage keeps
        // moving (and is never "0% while work is progressing").
        if (recordsSeen % PARTITION_HEARTBEAT_RECORDS === 0 && Date.now() - lastEmitAt >= PARTITION_HEARTBEAT_MS) {
          lastEmitAt = Date.now();
          const within = entry.lines ? Math.min(1, recordsSeen / entry.lines) : 1;
          emit({
            stage: "pass2-merge",
            rowsRead: counters.rowsRead,
            rowsRejected: counters.rowsRejected,
            companies: counters.uniqueCompanies,
            contacts: counters.uniqueContacts,
            progress: (fileIndex + within) / totalPartitions,
            message:
              `pass 2: partition ${fileIndex + 1}/${totalPartitions} in progress — ${recordsSeen.toLocaleString()} rows read ` +
              `(${(within * 100).toFixed(0)}% of this partition), ${counters.uniqueCompanies.toLocaleString()} companies, ` +
              `${((Date.now() - partitionStart) / 1000).toFixed(0)}s in this partition`,
          });
        }
      }
    } catch (error) {
      if (!isJsonlError(error)) throw error;
      throw new Error(`pass 2 could not merge partition ${entry.partition} (${entry.file}): ${error.message}`);
    }

    if (recordsSeen !== expectations.lines) {
      throw new Error(
        `Spool partition ${entry.file} lost or gained records: ${recordsSeen.toLocaleString()} read, ${entry.lines.toLocaleString()} recorded by pass 1.\n` +
          "  Nothing was deleted; re-run with --no-resume to rebuild the spool from the sources.",
      );
    }
    if (partitionHash.digest("hex") !== expectations.sha256) {
      throw new Error(
        `Spool partition ${entry.file} does not match the checksum pass 1 recorded. Its contents changed after it was\n` +
          "  written, so it will not be merged. Nothing was deleted; re-run with --no-resume to rebuild the spool.",
      );
    }

    /*
     * Identifier-ownership conflicts observed while resolving this partition.
     * A non-zero count is expected on real data (two records of one name family
     * claiming the same domain); it is reported so a spike is visible, and each
     * conflict is still recorded against the record that owned the key first.
     */
    counters.identifierConflicts = (counters.identifierConflicts ?? 0) + resolver.stats().conflicts;

    // Several keys can share one normalized name (e.g. two subsidiaries with
    // different domains). Those are kept as separate records and flagged, never
    // merged — exactly what the specification requires.
    const nameCounts = new Map<string, number>();
    for (const group of groups.values()) nameCounts.set(group.normalizedName, (nameCounts.get(group.normalizedName) ?? 0) + 1);
    for (const group of groups.values()) {
      if ((nameCounts.get(group.normalizedName) ?? 0) > 1) group.ambiguous = true;
    }

    /*
     * ------------------------- Stage B: associate contacts -------------------------
     *
     * Every company record in this partition is now known, so a contact can be
     * judged against every credible company of ITS name rather than only against
     * the record its own row resolved to. See `src/shared/association.ts` for the
     * evidence hierarchy and the four categories.
     */
    const candidates = new Map<number, AssociationCandidate>();
    const refsByName = new Map<string, number[]>();
    /** Canonical identity key per company ref — the id both objects and search use. */
    const identityKeyByRef = new Map<number, string>();
    /** True when that identity is an identifier this record actually owns. */
    const identityIsStrongByRef = new Map<number, boolean>();
    for (const group of groups.values()) {
      const domain = normalizeDomain(group.input.domain ?? group.input.website);
      const identity = groupIdentity(group.keys, group.normalizedName, (key) => resolver.refFor(key) === group.ref);
      identityKeyByRef.set(group.ref, identity.key);
      identityIsStrongByRef.set(group.ref, identity.strong);
      candidates.set(group.ref, {
        ref: group.ref,
        id: companyIdFor(identity.key),
        name: group.input.name,
        normalizedName: group.normalizedName,
        domain: domain ?? null,
        linkedinUrl: normalizeAttribute(group.input.linkedinUrl) ?? null,
        country: normalizeAttribute(group.input.country) ?? null,
        state: normalizeAttribute(group.input.state) ?? null,
        city: normalizeAttribute(group.input.city) ?? null,
        // Identity this record OWNS. A contradicting row whose keys were all
        // already taken owns none, so it must not be offered to Stage B as a
        // credible employer — nor may its own count as one.
        hasStrongIdentity: identity.strong,
      });
      const list = refsByName.get(group.normalizedName);
      if (list) list.push(group.ref);
      else refsByName.set(group.normalizedName, [group.ref]);
    }

    /** Attached contacts per company ref, keyed by their dedup fingerprint. */
    const attached = new Map<number, Map<string, Contact>>();
    /** Contacts preserved without an employer — never dropped, never mis-attached. */
    const unresolvedContacts: UnassignedContact[] = [];

    for (const pending of pendingContacts) {
      const familyRefs = refsByName.get(pending.claimedName) ?? [];
      const family = (familyRefs.includes(pending.claimedRef) ? familyRefs : [...familyRefs, pending.claimedRef])
        .map((ref) => candidates.get(ref))
        .filter((candidate): candidate is AssociationCandidate => Boolean(candidate));
      /*
       * Only records with an identity of their own compete for a contact. A
       * name-only placeholder of the same name is not an employer: leaving it in
       * would let a person be attached to a company record that carries nothing
       * but the name — exactly the "presented as verified" failure the
       * specification forbids. When EVERY member is name-only there is nothing
       * better, so the placeholders are used (and the verdict stays `plausible`).
       */
      const credible = family.filter((candidate) => candidate.hasStrongIdentity);
      /*
       * A row whose only company field was a NAME has no employer claim.
       *
       * The resolver maps such a row to whichever record owns the shared `n:` key —
       * the first company of that name read from the sources. Passing that ref as a
       * claim attaches the contact to an arbitrary member and makes the verdict
       * depend on input order (country evidence that names the second member became
       * a "conflict" on the first). The row's name identifies a family, not an
       * employer, so Stage B gets the explicit no-claim sentinel and decides from
       * the contact's own evidence. `claimedIdentity` is exactly the fact that
       * distinguishes that case: the row carried a strong identifier it owns.
       */
      const claimedRef = pending.identityClaimed ? pending.claimedRef : NO_CLAIM_REF;
      const decision = associateContact({
        candidates: credible.length ? credible : family,
        contact: pending.input,
        claimedRef,
        claimedIdentity: pending.identityClaimed,
      });
      // Only an identity-bearing claim can be "moved from": a no-claim row has no
      // employer to record as the previous one.
      const claimedCompanyId = pending.identityClaimed ? (candidates.get(pending.claimedRef)?.id ?? "") : "";

      if (decision.assignedRef === null) {
        const contact = contactFromRow(pending, "", decision.record);
        const preserved: UnassignedContact = {
          ...contact,
          association: decision.record,
          claimedCompanyName: pending.claimedCompanyName,
          claimedNormalizedName: pending.claimedName,
        };
        const fingerprint = unassignedFingerprint(preserved);
        const key = fingerprint ?? `r:${pending.source.source}:${pending.source.row}`;
        if (fingerprint && unresolvedSeen.has(`${pending.claimedName}\u0000${key}`)) {
          counters.duplicateRowsResolved += 1;
        } else {
          if (fingerprint) unresolvedSeen.add(`${pending.claimedName}\u0000${key}`);
          unresolvedContacts.push(preserved);
          counters.uniqueContacts += 1;
          counters.contactsUnresolved = (counters.contactsUnresolved ?? 0) + 1;
          if (counters.perSource[pending.source.source]) counters.perSource[pending.source.source].contacts += 1;
          recordCoverage(coverage, preserved);
        }
        continue;
      }

      const assignedCompanyId = candidates.get(decision.assignedRef)?.id ?? "";
      const association = decision.moved && claimedCompanyId ? { ...decision.record, movedFrom: claimedCompanyId } : decision.record;
      const contact = contactFromRow(pending, assignedCompanyId, association);

      /*
       * Duplicate detection happens AFTER the decision, not before it: two rows
       * for the same person used to be deduplicated per claimed company, so the
       * same individual could survive as two contacts once reassignment put them
       * in the same place, or be merged with a different person who only shared a
       * name. The fingerprint is company-scoped and is computed from the FINAL
       * company id, which is what `buildContactId` uses as well.
       */
      const bucket = attached.get(decision.assignedRef) ?? new Map<string, Contact>();
      const fingerprint = contactFingerprint(contact);
      if (fingerprint && bucket.has(fingerprint)) {
        counters.duplicateRowsResolved += 1;
      } else {
        bucket.set(fingerprint ?? `r:${pending.source.source}:${pending.source.row}`, contact);
        attached.set(decision.assignedRef, bucket);
        if (decision.moved) counters.contactsMoved = (counters.contactsMoved ?? 0) + 1;
      }
    }

    if (unresolvedContacts.length) {
      // Deterministic order, so a re-run writes byte-identical objects.
      unresolvedContacts.sort((a, b) => a.claimedNormalizedName.localeCompare(b.claimedNormalizedName) || a.id.localeCompare(b.id));
      const payload: UnassignedPartitionPayload = { partition: entry.partition, contacts: unresolvedContacts };
      await writer.writeJson(unassignedPartitionKey(config.datasetVersion, entry.partition), payload);
      counters.unassignedObjects = (counters.unassignedObjects ?? 0) + 1;
      for (const contact of unresolvedContacts) {
        /*
         * A preserved contact is indexed like any other person, and its id index
         * posting points at NEGATIVE ref `-(partition + 1)`.
         *
         * The reader needs two facts to open a contact: which company owns it (a
         * non-negative document ref) and, for one with no employer, which
         * `unassigned/` object holds it. The object key is the Pass 1 partition of
         * the name the row claimed, which is not derivable from the contact id — so
         * the ids index carries it. A negative ref can never collide with a company
         * ref (those start at 0), and older readers that only know about companies
         * never see these postings.
         */
        shardWriter.write("ids", shardOf(contact.id, config.shards.ids), contact.id, -(entry.partition + 1), 255);
        emitContactNamePostings(shardWriter, config.shards, contact);
      }
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
          // The canonical identity is `identityKeyByRef` — built from what this
          // record OWNS plus the deterministic fallback — so two records can never
          // end up sharing one id because they both listed the same stolen key.
          key: identityKeyByRef.get(group.ref) ?? `n:${group.normalizedName}`,
          strong: identityIsStrongByRef.get(group.ref) ?? false,
          normalizedName: group.normalizedName,
          display: group.input.name,
        },
        sources: group.sources,
        ambiguous: group.ambiguous,
      });
      const facets = company.facets ?? { designations: [], departments: [], seniority: [], countries: [], cities: [], emailAvailable: 0, linkedinAvailable: 0 };
      const contacts: Contact[] = [...(attached.get(group.ref)?.values() ?? [])];
      /**
       * The trustworthy breakdown of this company's contacts, stored on the
       * record so a profile can be honest about it without reading a single
       * contact row. Recalculated from the FINAL associations, so it always adds
       * up to `contactCount`.
       */
      const associations: AssociationCounts = { highConfidence: 0, plausible: 0, conflicting: 0, total: 0 };
      for (const finalised of contacts) {
        accumulateFacets(facets, finalised);
        const category = finalised.association?.category;
        if (category === "high_confidence") {
          associations.highConfidence += 1;
          counters.contactsHighConfidence = (counters.contactsHighConfidence ?? 0) + 1;
        } else if (category === "plausible") {
          associations.plausible += 1;
          counters.contactsPlausible = (counters.contactsPlausible ?? 0) + 1;
        } else if (category === "conflicting") {
          associations.conflicting += 1;
          counters.contactsConflicting = (counters.contactsConflicting ?? 0) + 1;
        }
        associations.total += 1;
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
        recordCoverage(coverage, finalised);
      }
      company.contactCount = contacts.length;
      company.facets = finalizeFacets(facets);
      company.associations = associations;
      if (group.ambiguous) counters.ambiguousCompanies += 1;

      /*
       * Index postings.
       *
       * The writer batches these by shard, so writing is one call per posting and
       * no `await` is involved. Two of the five kinds can repeat a term for the SAME
       * company: two aliases of one company share their first letters (so they emit
       * the same prefix), and `trigrams("aaaa")` really does produce "aaa" twice. A
       * repeated `(term, ref)` pair inflates the posting and makes one company
       * appear twice in a result list, and the reader only collapses a repeat that
       * happens to be adjacent — which after batching is no longer guaranteed — so
       * the duplicates are removed here, where the term's owner is known.
       * (`exact` uses the variant Set, `token` a Set of tokens, `ids` are unique by
       * construction, so those three need no check.)
       */
      const quality = qualityByte(company.contactCount, company.normalizedName.length);
      const variants = new Set<string>([company.normalizedName, ...(company.aliases ?? [])]);
      const prefixSeen = new Set<string>();
      const trigramSeen = new Set<string>();
      for (const variant of variants) {
        shardWriter.write("exact", shardOf(variant, config.shards.exact), variant, globalRef, quality);
        // Indexed up to the reader's own prefix ceiling, so a query cannot be
        // truncated to a prefix that was never indexed.
        const maxPrefix = Math.min(SHARDING.maxPrefixLength, variant.length);
        for (let i = 1; i <= maxPrefix; i += 1) {
          const prefix = variant.slice(0, i);
          if (prefixSeen.has(prefix)) continue;
          prefixSeen.add(prefix);
          shardWriter.write("prefix", shardOf(prefix, config.shards.prefix), prefix, globalRef, quality);
        }
        for (const gram of trigrams(variant)) {
          if (trigramSeen.has(gram)) continue;
          trigramSeen.add(gram);
          shardWriter.write("trigram", shardOf(gram, config.shards.trigram), gram, globalRef, quality);
        }
      }
      for (const token of new Set(company.normalizedName.split(" "))) {
        shardWriter.write("token", shardOf(token, config.shards.token), token, globalRef, quality);
      }
      shardWriter.write("ids", shardOf(company.id, config.shards.ids), company.id, globalRef, 255);
      for (const contact of contacts) {
        shardWriter.write("ids", shardOf(contact.id, config.shards.ids), contact.id, globalRef, 255);
        emitContactNamePostings(shardWriter, config.shards, contact);
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

    /*
     * Mid-run disk guard. Checked after every partition now that the progress line
     * is emitted there too: one `statfs` per partition is nothing against a
     * partition's work, and the alternative (every 16 partitions) can write fifteen
     * partitions' output before noticing the volume is full. A clean stop keeps
     * everything already written and the checkpoint still says `pass2-merge`, so the
     * same command resumes — and now restarts pass 2 from a reset state.
     */
    const free = await freeDiskBytesFor(config.outputDir);
    if (free !== null && free < diskFloorBytes) {
      throw new Error(
        `Stopping before the disk fills: ${(free / 1e9).toFixed(2)} GB free on ${config.outputDir} is below the ${(diskFloorBytes / 1e9).toFixed(2)} GB floor. ` +
          "The Pass 1 spool is untouched and the checkpoint is still at pass2-merge, so re-running the same command " +
          "resumes pass 2 (its partial output is reset and replayed, not appended to). Free space (or lower `partitions`) first.",
      );
    }

    /*
     * Progress after EVERY partition, with the real completion fraction.
     *
     * This used to be `fileIndex / spoolEntries.length`, emitted once per 16
     * partitions: after finishing partition 1 it printed 0%, which read as "stuck"
     * on a job that was in fact working. It now reports the number of partitions
     * COMPLETED, the companies and contacts resolved so far, the elapsed time, the
     * throughput in companies/s and an ETA once there is a measurement to base one
     * on, plus how long this partition took.
     */
    const processedPartitions = fileIndex + 1;
    const elapsedMs = Date.now() - mergeStart;
    const partitionMs = Date.now() - partitionStart;
    const etaSeconds =
      processedPartitions > 0 && processedPartitions < totalPartitions && elapsedMs > 0
        ? Math.round(((elapsedMs / processedPartitions) * (totalPartitions - processedPartitions)) / 1000)
        : processedPartitions === totalPartitions
          ? 0
          : null;
    const companiesPerSecond = elapsedMs > 0 ? Math.round(counters.uniqueCompanies / (elapsedMs / 1000)) : null;
    const notes = pass2StepNotes({ partitionMs, rows: entry.lines, averageRows: averageLines });
    lastEmitAt = Date.now();
    emit({
      stage: "pass2-merge",
      rowsRead: counters.rowsRead,
      rowsRejected: counters.rowsRejected,
      companies: counters.uniqueCompanies,
      contacts: counters.uniqueContacts,
      progress: processedPartitions / totalPartitions,
      etaSeconds,
      message:
        `pass 2: ${processedPartitions}/${totalPartitions} partitions · ${counters.uniqueCompanies.toLocaleString()} companies · ` +
        `${counters.uniqueContacts.toLocaleString()} contacts (${(counters.contactsUnresolved ?? 0).toLocaleString()} kept without an employer) · ${(elapsedMs / 1000).toFixed(1)}s elapsed · ` +
        `${companiesPerSecond === null ? "-" : companiesPerSecond.toLocaleString()} companies/s · ` +
        `ETA ${etaSeconds === null || etaSeconds === 0 ? "-" : `${Math.floor(etaSeconds / 60)}m${String(etaSeconds % 60).padStart(2, "0")}s`}` +
        ` · this partition ${(partitionMs / 1000).toFixed(1)}s` +
        (notes.length ? ` — ${notes.join("; ")}` : ""),
    });

    /*
     * Cloud Pass 2: bounded batches.
     *
     *   - postings are flushed every few partitions as gzip objects instead of
     *     growing local `.lines` files (one small PUT per kind/shard/batch);
     *   - the materialised partition is deleted immediately, so peak local disk is
     *     one partition plus the flush buffer, never the corpus;
     *   - the durable job state is updated and pause/abort are honoured between
     *     partitions. Re-running after a stop replays from partition 1 (the output
     *     is deterministic, so replay overwrites rather than duplicates).
     */
    if (cloud) {
      const CLOUD_SHARD_BATCH = 4;
      const batch = Math.floor(fileIndex / CLOUD_SHARD_BATCH);
      if ((fileIndex + 1) % CLOUD_SHARD_BATCH === 0 || fileIndex === totalPartitions - 1) {
        await shardWriter.flushToCloud(cloud, batch);
      }
      await cloud.releasePartition(entry);
      await cloud.onPartition({
        partitionsDone: processedPartitions,
        partitionsTotal: totalPartitions,
        rows: counters.rowsRead,
        companies: counters.uniqueCompanies,
        contacts: counters.uniqueContacts,
        elapsedMs: Date.now() - mergeStart,
      });
    }
  }
  const mergeMs = Date.now() - mergeStart;

  await flushCompanies();
  await flushContacts();
  shardWriter.close();
  await new Promise<void>((resolve) => rejected.end(resolve));

  // The merge is finished and every shard part is in R2: record everything the
  // finalize phase needs, so a restart from here never repeats the merge.
  if (cloud?.onMergeComplete) {
    await cloud.onMergeComplete({
      counters,
      companyStats: {
        byIndustry: [...companyStats.byIndustry.entries()],
        byCountry: [...companyStats.byCountry.entries()],
        bySize: [...companyStats.bySize.entries()],
      },
      contactStats: {
        byDesignation: [...contactStats.byDesignation.entries()],
        byDepartment: [...contactStats.byDepartment.entries()],
        bySeniority: [...contactStats.bySeniority.entries()],
      },
      coverage: { ...coverage },
      companyBuffer,
      companyBufferStart,
      contactBuffer: [...contactBuffer.entries()],
      contactBufferBucket,
      companyPartitionIndex,
      contactPartitionIndex,
      companyDetailPartitions,
      contactDetailPartitions,
      globalRef,
      objects: writer.objects,
    });
  }

  /* -------------------------------- finalize ------------------------------ */

  const finalizeStart = Date.now();
  emit({ stage: "indexing", message: "finalizing index shards" });
  const indexPathIndex = async (kind: ShardKind, shards: number) => {
    for (let shard = 0; shard < shards; shard += 1) {
      const name = String(shard).padStart(4, "0");
      const linesPath = join(shardDir, `${kind}/${name}.lines`);
      if (!cloud && !existsSync(linesPath)) continue;
      // Read with the same `\n`-only splitter as the spool (see jsonl.ts):
      // `readline` split on U+2028/U+2029, so a term containing one produced a
      // fragment with no `\u0001` and the old code discarded the posting silently.
      const payload = cloud
        ? await companyShardPayload(linesFromParts(cloud.readShardParts(kind, shard)), `${kind}/${name}`)
        : await companyShardPayload(readJsonlLines(linesPath), `${kind}/${name}`);
      await writer.writeJsonParts(folderFor("indexes", config.datasetVersion, `${kind}/${name}.json`), shardJsonParts(payload.terms));
      if (!cloud) await rm(linesPath, { force: true });
    }
  };

  /*
   * Contact name shards: same line format, but the target is a contact id.
   *
   * A malformed line is a hard error for the same reason it is for a company
   * shard: silently dropping it would make a person unfindable while the index
   * still claims to cover every contact.
   */
  const indexContactShard = async (kind: ShardKind, shards: number) => {
    for (let shard = 0; shard < shards; shard += 1) {
      const name = String(shard).padStart(4, "0");
      const linesPath = join(shardDir, `${kind}/${name}.lines`);
      if (!cloud && !existsSync(linesPath)) continue;
      const payload = cloud
        ? await contactShardPayload(linesFromParts(cloud.readShardParts(kind, shard)), `${kind}/${name}`)
        : await contactShardPayload(readJsonlLines(linesPath), `${kind}/${name}`);
      await writer.writeJsonParts(folderFor("indexes", config.datasetVersion, `${kind}/${name}.json`), shardJsonParts(payload.terms));
      if (!cloud) await rm(linesPath, { force: true });
    }
  };

  await indexPathIndex("exact", config.shards.exact);
  await indexPathIndex("prefix", config.shards.prefix);
  await indexPathIndex("token", config.shards.token);
  await indexPathIndex("trigram", config.shards.trigram);
  await indexPathIndex("ids", config.shards.ids);
  await indexContactShard("contactToken", config.shards.token);
  await indexContactShard("contactPrefix", config.shards.prefix);
  await indexContactShard("contactTrigram", config.shards.trigram);

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
      else if (object.key.startsWith("details/")) total.details += object.bytes;
      else if (object.key.startsWith("companies/")) total.companies += object.bytes;
      else if (object.key.startsWith("contacts/")) total.contacts += object.bytes;
      else if (object.key.startsWith("unassigned/")) total.unassigned += object.bytes;
      return total;
    },
    { indexes: 0, details: 0, companies: 0, contacts: 0, unassigned: 0 },
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
      // Presence of this block is what enables a global person search: the reader
      // must be able to tell "no index was built" from "no such person".
      contactIndex: {
        token: config.shards.token,
        prefix: config.shards.prefix,
        trigram: config.shards.trigram,
      },
      // Recorded so the reader can locate an `unassigned/` object from a company
      // record alone: the object key is that company's Pass 1 partition, and only
      // the run that wrote the spool knows how many partitions there were.
      spoolPartitions: config.partitions,
    },
    counts: { companies: counters.uniqueCompanies, contacts: counters.uniqueContacts, indexedAliases: 0 },
    sources: config.sources.map((source) => source.id),
    bytes: {
      ...bytes,
      total: bytes.indexes + bytes.details + bytes.companies + bytes.contacts + bytes.unassigned,
    },
    objects: {
      companyProjections: companyPartitionIndex,
      companyDetails: companyDetailPartitions,
      contactProjections: contactPartitionIndex,
      contactDetails: contactDetailPartitions,
    },
    ...(counters.unassignedObjects
      ? { unassigned: { objects: counters.unassignedObjects, contacts: counters.contactsUnresolved ?? 0 } }
      : {}),
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
    let body: Buffer | null;
    if (cloud) {
      // Read the object back from R2: local validation only proves what is in the
      // writer's memory, not what a search will actually fetch.
      body = await cloud.readObject(object.key).catch(() => null);
    } else {
      const path = join(config.outputDir, object.key);
      const info = await stat(path).catch(() => null);
      body = info ? await readFile(path) : null;
    }
    if (!body) {
      missing.push(object.key);
      continue;
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== object.sha256) missing.push(object.key);
  }

  const validateMs = Date.now() - validateStart;
  const enoughShards = writer.objects.filter((object) => object.key.startsWith("indexes/")).length > 0;
  const bothSources = config.sources.every((source) => (counters.perSource[source.id]?.rowsRead ?? 0) > 0);
  /**
   * The projection/detail split is only lossless if BOTH halves exist.
   *
   * A format-v4 index whose `details/` objects were never written would still
   * search perfectly and then open every record with its source columns missing —
   * silent data loss that no checksum would notice. So a populated index MUST carry
   * detail objects, and a partition that lost its detail object is reported here
   * instead of being discovered by a user.
   */
  const missingDetails =
    (counters.uniqueCompanies > 0 && companyDetailPartitions === 0) ||
    (counters.uniqueContacts > 0 && contactDetailPartitions === 0);
  const validation = {
    version: config.datasetVersion,
    passed: missing.length === 0 && enoughShards && bothSources && !missingDetails,
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
      ...(missingDetails
        ? [
            {
              severity: "error" as const,
              code: "missing_detail_objects",
              message:
                "The search projections were written without their detail objects, so opening a record would lose its source columns. " +
                `(company details: ${companyDetailPartitions} of ${companyPartitionIndex} partitions, contact details: ${contactDetailPartitions} of ${contactPartitionIndex})`,
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
    resumed: reuseSpool,
    pass2Reset,
    shardWrite: shardWriter.stats,
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
/**
 * The slice of `R2Client` the upload and publish paths use.
 *
 * Declared as an interface so the ordering and rollback rules can be tested against a
 * fake bucket instead of only against the network — the properties that matter here
 * (manifests go last, the pointer is only flipped after R2 confirms the version) are
 * exactly the ones that are expensive to get wrong.
 */
export interface R2WriteClient {
  head(key: string): Promise<{ exists: boolean; size?: number | null }>;
  get(key: string): Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
  put(
    key: string,
    body: Uint8Array | string,
    contentType?: string,
    retries?: number,
    options?: { contentEncoding?: string },
  ): Promise<unknown>;
  putJson(key: string, value: unknown, cacheable?: boolean): Promise<unknown>;
}

export async function uploadOutput(
  config: IndexerConfig,
  result: RunResult,
  onProgress?: (message: string) => void,
  clientOverride?: R2WriteClient,
): Promise<UploadResult> {
  let client: R2WriteClient;
  if (clientOverride) {
    client = clientOverride;
  } else {
    const credentials = credentialsFromEnv(config.upload?.bucket);
    if (!credentials) {
      throw new Error(
        "R2 credentials are not set. Export R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, or upload the output directory with rclone instead.",
      );
    }
    client = new R2Client(credentials);
  }
  const output: UploadResult = { uploaded: 0, skipped: 0, bytes: 0 };

  /*
   * Upload the manifests LAST, always.
   *
   * `publish` and the Dataset page both treat the presence of
   * `manifests/<version>/manifest.json` as "this version is complete". Uploading it
   * in the middle of a 1,800-object run would make a half-uploaded version look
   * activatable if the process died — so the ordering is enforced here rather than
   * left to how `writer.objects` happens to be ordered. Within each group the order
   * stays the writer's (deterministic), so a resumed upload still skips what exists.
   */
  const manifestPrefix = `manifests/${config.datasetVersion}/`;
  const orderedObjects = [
    ...result.objects.filter((object) => !object.key.startsWith(manifestPrefix)),
    ...result.objects.filter((object) => object.key.startsWith(manifestPrefix)),
  ];

  for (const object of orderedObjects) {
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
 * Read every uploaded object back and compare its CONTENT with what the run wrote.
 *
 * `validate` alone only proves the local files still match their own record: it says
 * nothing about the bucket. This is the step that makes "uploaded" mean "uploaded
 * intact", and it is what the full-index pipeline runs before it activates anything.
 *
 * The comparison is defined on CONTENT, not stored bytes. `objects.jsonl` records the
 * hash of the file the indexer wrote, which for a gzipped payload is the hash of the
 * COMPRESSED bytes; R2 decodes a `content-encoding: gzip` object at the edge and the
 * HTTP client may decode again, so the same object legitimately comes back compressed
 * or plain. The only reliable signal is the magic bytes (1f 8b), so both sides are
 * normalised with it and then hashed.
 */
export async function verifyRemoteObjects(
  client: {
    get: (key: string) => Promise<{ ok: boolean; status?: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
    head: (key: string) => Promise<{ exists: boolean; size?: number | null }>;
  },
  objects: { key: string; bytes: number }[],
  options: { outputDir: string; offset?: number; limit?: number; onProgress?: (checked: number, total: number) => void },
): Promise<{ checked: number; bytes: number; problems: { key: string; problem: string }[] }> {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? objects.length;
  const problems: { key: string; problem: string }[] = [];

  const normalisedHash = (buffer: Uint8Array) => {
    const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    const plain = isGzip ? new Uint8Array(gunzipSync(buffer)) : buffer;
    return createHash("sha256").update(plain).digest("hex");
  };

  let checked = 0;
  let bytes = 0;
  for (const object of objects.slice(offset, offset + limit)) {
    const localPath = join(options.outputDir, object.key);
    if (!existsSync(localPath)) {
      problems.push({ key: object.key, problem: "not in the local output directory" });
      continue;
    }
    let local: Uint8Array;
    try {
      local = new Uint8Array(await readFile(localPath));
    } catch (error) {
      problems.push({ key: object.key, problem: `local read failed: ${error instanceof Error ? error.message : error}` });
      continue;
    }
    const head = await client.head(object.key);
    if (!head.exists) {
      problems.push({ key: object.key, problem: "missing from R2" });
      continue;
    }
    if (head.size !== object.bytes) {
      problems.push({ key: object.key, problem: `size ${head.size ?? "?"} on R2, ${object.bytes} expected` });
      continue;
    }
    const response = await client.get(object.key);
    if (!response.ok) {
      problems.push({ key: object.key, problem: `read failed (HTTP ${response.status ?? "?"})` });
      continue;
    }
    const remote = new Uint8Array(await response.arrayBuffer());
    if (normalisedHash(remote) !== normalisedHash(local)) {
      problems.push({ key: object.key, problem: "content differs from the local object" });
      continue;
    }
    bytes += object.bytes;
    checked += 1;
    options.onProgress?.(checked, objects.length);
  }
  return { checked, bytes, problems };
}

/**
 * Confirm a version is actually complete in R2 before anything points at it.
 *
 * `publish` used to trust the LOCAL validation report. That is wrong in two ways
 * that both end with the application serving nothing: the output directory can have
 * been deleted since the upload, and a version can be half-uploaded. Both are
 * questions only R2 can answer, so they are asked here — the uploaded manifest has
 * to exist and say the version passed, and the uploaded validation report has to
 * agree.
 */
export async function verifyRemoteVersion(
  client: { get: (key: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> },
  version: string,
): Promise<{ objectCount: number; bytes: number }> {
  const manifestResponse = await client.get(`manifests/${version}/manifest.json`);
  if (!manifestResponse.ok) {
    throw new Error(
      `Version ${version} is not complete in R2: manifests/${version}/manifest.json is missing. ` +
        "The upload never finished, or nothing was uploaded for this version. Nothing was activated.",
    );
  }
  const manifest = (await manifestResponse.json()) as {
    version?: string;
    validationPassed?: boolean;
    objectCount?: number;
    bytes?: number;
  };
  if (manifest.version && manifest.version !== version) {
    throw new Error(`manifests/${version}/manifest.json describes version ${manifest.version}. Nothing was activated.`);
  }
  if (manifest.validationPassed === false) {
    throw new Error(`Version ${version} recorded a FAILED validation in R2 and cannot be activated.`);
  }

  const validationResponse = await client.get(`manifests/${version}/validation.json`);
  if (!validationResponse.ok) {
    throw new Error(
      `Version ${version} has no uploaded validation report (manifests/${version}/validation.json). Nothing was activated.\n` +
        `  Re-run the upload: bun run index:full -- --version ${version} --upload-only --yes`,
    );
  }
  const validation = (await validationResponse.json()) as { passed?: boolean };
  if (validation.passed !== true) {
    throw new Error(`Version ${version} did not pass the validation report stored in R2. Nothing was activated.`);
  }
  return { objectCount: Number(manifest.objectCount ?? 0), bytes: Number(manifest.bytes ?? 0) };
}

/**
 * Publish a validated version by flipping the active pointer.
 *
 * The current pointer is read first so the version that was serving becomes
 * `previousVersion`: without that, the Dataset page would have no rollback
 * target and a bad publish could not be reverted in one click.
 */
export async function publishVersion(
  version: string,
  bucket?: string,
  clientOverride?: R2WriteClient,
): Promise<{ previousVersion: string | null }> {
  let client: R2WriteClient;
  if (clientOverride) {
    client = clientOverride;
  } else {
    const credentials = credentialsFromEnv(bucket);
    if (!credentials) throw new Error("R2 credentials are not set, so the active version cannot be published.");
    client = new R2Client(credentials);
  }

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

  // Ask R2, not the local directory.
  await verifyRemoteVersion(client, version);

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

/**
 * Canonical identity key of one resolved company record.
 *
 * Preference: an identifier the record actually owns (domain → LinkedIn → source
 * id), then the name key when it owns that, and only when it owns NOTHING — a row
 * whose every identifier was already owned elsewhere — a key derived from the
 * evidence pattern (normalized name + key set).
 *
 * That last case matters twice: the record still needs a deterministic id, and it
 * must not borrow the id of the company whose domain it was refused. Deriving it
 * from the pattern keeps ids unique (a pattern can only occur in the partition of
 * its own name) and identical between runs.
 */
function groupIdentity(
  keys: Set<string>,
  normalizedName: string,
  isOwned: (key: string) => boolean,
): { key: string; strong: boolean } {
  const owned = [...keys].filter((key) => isOwned(key));
  const ownedStrong = owned.filter((key) => !key.startsWith("n:"));
  if (ownedStrong.length) return { key: pickCanonicalKey(ownedStrong), strong: true };
  if (owned.length) return { key: pickCanonicalKey(owned), strong: false };
  const signature = [...keys].sort().join("|");
  return { key: `x:${normalizedName}:${stableHash(signature)}`, strong: false };
}

/**
 * Final contact record for a Stage B decision.
 *
 * One code path for attached and preserved contacts, so the two can never diverge
 * in the fields they copy. `companyId` is the empty string for a contact kept
 * without an employer, and the id is derived from the fingerprint in that case
 * (a company-scoped id would be a fabricated employer).
 */
function contactFromRow(pending: PendingContact, companyIdValue: string, association: AssociationRecord): Contact {
  const provisional = buildContact({
    input: pending.input,
    company: {
      id: companyIdValue,
      name: pending.claimedCompanyName,
      normalizedName: pending.claimedName,
      contactCount: 0,
      sources: [],
    },
    source: pending.source,
    rowFingerprint: `${pending.source.source}:${pending.source.row}`,
  });
  const contact: Contact = { ...provisional, companyId: companyIdValue, association };
  contact.id = companyIdValue ? buildContactId(companyIdValue, contact) : buildUnassignedContactId(contact);
  return contact;
}

/**
 * Identity of a preserved contact: email, then LinkedIn, then name + title within
 * the claimed name. Two rows that agree are one contact; two people with the same
 * name and different titles stay separate.
 */
function unassignedFingerprint(contact: Contact & { claimedNormalizedName: string }): string | null {
  if (contact.email) return `e:${contact.email}`;
  if (contact.linkedinUrl) return `l:${contact.linkedinUrl.replace(/^https?:\/\//, "")}`;
  if (contact.fullName) return `n:${contact.claimedNormalizedName}|${contact.fullName.toLowerCase()}|${(contact.title ?? "").toLowerCase()}`;
  return null;
}

/** Stable id for a contact that has no company. */
function buildUnassignedContactId(contact: Contact): string {
  const fingerprint = contact.email ?? contact.linkedinUrl ?? `${contact.fullName}|${contact.title ?? ""}|${contact.source.row}`;
  return contactIdFor(`unassigned|${fingerprint}`);
}

/** Contact coverage counters, shared by attached and preserved contacts. */
function recordCoverage(coverage: { email: number; linkedin: number; phone: number; neither: number }, contact: Contact): void {
  if (contact.email) coverage.email += 1;
  if (contact.linkedinUrl) coverage.linkedin += 1;
  if (contact.phone) coverage.phone += 1;
  if (!contact.email && !contact.linkedinUrl && !contact.phone) coverage.neither += 1;
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

/**
 * Person-name key used by the contact index.
 *
 * `normalizeQuery` is the same normalizer companies are indexed with (deaccent,
 * lowercase, punctuation → spaces), so "José O'Brien" and "jose obrien" are one
 * key. Legal-suffix stripping is a company rule and is a no-op on a person's
 * name.
 */
function contactNameKey(contact: Contact): string {
  return normalizeQuery(contact.fullName ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 0..255 prominence byte for a contact, used to pre-rank candidates before any
 * contact object is fetched. A reachable person (email, then LinkedIn) and one
 * with a known role wins a tie against a bare name.
 */
function contactQualityByte(contact: Contact): number {
  let score = 40;
  if (contact.email) score += 80;
  if (contact.linkedinUrl) score += 60;
  if (contact.phone) score += 30;
  if (contact.title || contact.designation) score += 20;
  return Math.min(255, score);
}

/**
 * Write every posting a contact contributes to the person-name index.
 *
 * Three kinds, mirroring the company index so the same retrieval logic applies:
 *   token   — any word of the name ("smith", "john")
 *   prefix  — the start of the whole name AND of each word ("john sm", "smi")
 *   trigram — the whole name, for a typo ("jhon smith")
 * Every posting carries the contact id, because a contact's position inside its
 * company's object is not part of its identity.
 */
function emitContactNamePostings(
  writer: ShardWriter,
  shards: IndexerConfig["shards"],
  contact: Contact,
): void {
  const name = contactNameKey(contact);
  if (!name) return;
  const quality = contactQualityByte(contact);
  const tokens = name.split(" ").filter(Boolean);
  const prefixes = new Set<string>();
  const maxPrefix = Math.min(SHARDING.maxPrefixLength, name.length);
  for (let i = 1; i <= maxPrefix; i += 1) prefixes.add(name.slice(0, i));
  for (const token of tokens) {
    const max = Math.min(SHARDING.maxPrefixLength, token.length);
    for (let i = 1; i <= max; i += 1) prefixes.add(token.slice(0, i));
  }
  for (const prefix of prefixes) {
    writer.writeContact("contactPrefix", shardOf(prefix, shards.prefix), prefix, contact.id, quality);
  }
  for (const token of new Set(tokens)) {
    writer.writeContact("contactToken", shardOf(token, shards.token), token, contact.id, quality);
  }
  for (const gram of trigrams(name)) {
    writer.writeContact("contactTrigram", shardOf(gram, shards.trigram), gram, contact.id, quality);
  }
}


