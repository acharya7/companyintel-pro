/**
 * Cloud Pass 1 — stream both R2 source objects into compact, partitioned
 * segments, with a durable checkpoint after every chunk.
 *
 * The row encoding and the partition function are the SAME ones the local v2
 * spool uses (`encodeSpoolV2Row`, `companyKeysFromInput`, `partitionFor`), so a
 * cloud-built spool is byte-compatible with the verified local format: segments
 * for one partition, concatenated in chunk order, are a valid v2 partition file.
 * That is what lets the existing, tested Pass 2 merge consume cloud output
 * without a second implementation of identity resolution or association.
 *
 * Failure model:
 *   - a chunk is uploaded before its manifest, and the checkpoint only advances
 *     after every segment of that chunk is verified;
 *   - a crash mid-chunk leaves no checkpoint change, so the chunk is re-read and
 *     its deterministic keys are overwritten (idempotent, never duplicated);
 *   - `pause`/`abort` are read from an object in R2 before each chunk, so a
 *     control action takes effect within one chunk instead of killing a process.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { buildColumnMap, capturedColumns, companyKeysFromInput, extractCompanyInput, partitionFor } from "../indexer/src/mapping";
import { encodeJsonlLine } from "../indexer/src/jsonl";
import { encodeSpoolV2Row, normalizeValues, SPOOL_FORMAT_VERSION, type SpoolSchema } from "../indexer/src/spool-v2";
import type { IndexerConfig } from "../indexer/src/build";
import {
  CLOUD_CONTROL_VERSION,
  CLOUD_ENGINE_VERSION,
  cloudKeys,
  type CloudChunkManifest,
  type CloudControl,
  type CloudInterruption,
  type CloudJobState,
  type CloudSegmentRef,
  type CloudSourceState,
} from "../../src/shared/cloud/types";

import { readChunk, readHeader } from "./chunker";
import type { BlobStore } from "./store";

export const CLOUD_PASS1_DEFAULTS = {
  /** Source bytes per chunk. 128 MiB keeps a chunk's uncompressed row buffer small. */
  chunkBytes: 128 << 20,
  sliceBytes: 4 << 20,
  verifySegments: true,
} as const;

/** R2 list price, used for the running estimate (see docs/cost.md). */
export const R2_PRICES = {
  classAPerMillion: 4.5,
  classBPerMillion: 0.36,
  storagePerGbMonth: 0.015,
} as const;

/**
 * The single budget for a whole indexing job (Pass 1 + Pass 2).
 *
 * `CLOUD_JOB_BUDGET_USD` is the current name; `CLOUD_BUDGET_USD` is accepted as a
 * deprecated alias so an existing deployment does not silently lose its guard.
 * Zero, empty or non-numeric means "no automatic stop" — pause/abort still work.
 */
export function cloudJobBudgetUsd(): number | null {
  const raw = process.env.CLOUD_JOB_BUDGET_USD ?? process.env.CLOUD_BUDGET_USD ?? "";
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Container standard-1 (0.5 vCPU, 4 GiB): provisioned CPU + memory per second. */
export const CONTAINER_PRICE = {
  vcpuPerSecond: 0.00002,
  gibPerSecond: 0.0000025,
  vcpu: 0.5,
  gib: 4,
} as const;

export interface SourceCheckpoint {
  engine: typeof CLOUD_ENGINE_VERSION;
  version: string;
  sourceId: string;
  sourceKey: string;
  sourceEtag: string | null;
  sourceSize: number;
  chunkBytes: number;
  partitions: number;
  nextOffset: number;
  nextLine: number;
  chunks: number;
  rows: number;
  rejected: number;
  segmentBytes: number;
  segments: number;
  complete: boolean;
  updatedAt: string;
}

export interface Pass1SourceSpec {
  id: string;
  key: string;
  delimiter: string;
  quote?: string;
  /** Header override map from the indexer config (canonical field → header text). */
  columns?: Record<string, string>;
}

export interface RunPass1Options {
  store: BlobStore;
  version: string;
  sources: Pass1SourceSpec[];
  partitions: number;
  chunkBytes?: number;
  sliceBytes?: number;
  verifySegments?: boolean;
  /** Bounded benchmark: stop each source after this many source bytes. */
  maxSourceBytes?: number;
  mode?: CloudJobState["mode"];
  onLog?: (line: string) => void;
  /**
   * Asked at every chunk boundary (before reading the next chunk). Returning a
   * reason stops cleanly — the chunk already written stays checkpointed — and
   * records that reason in `state.json`. The container CLI wires SIGTERM here, so a
   * platform stop does not need to kill the process mid-chunk.
   */
  shouldStop?: () => string | null;
  /** Called after every committed chunk; the CLI uses it to refresh run.json. */
  heartbeat?: (checkpoint: SourceCheckpoint) => Promise<void> | void;
  /** Injected for tests; defaults to real time. */
  now?: () => number;
}

export interface Pass1Result {
  state: CloudJobState;
  schema: SpoolSchema;
  checkpoints: SourceCheckpoint[];
  stopped: "complete" | "paused" | "aborted" | "bounded" | "interrupted";
}

/**
 * Run Pass 1, recording any failure in `state.json` before re-throwing it.
 *
 * The wrapper exists so the engine body below keeps its ordinary structure and the
 * failure path is one place: a thrown error would otherwise leave the job parked on
 * `stage: pass1` with an empty `errors[]` — the exact shape the staging dashboard
 * showed for a run that had actually stopped.
 */
export async function runPass1(options: RunPass1Options): Promise<Pass1Result> {
  try {
    return await runPass1Internal(options);
  } catch (error) {
    // Every chunk already written is committed and resumable. The CLI still exits
    // non-zero and the container runner still reports the stderr tail.
    await recordFailure(options.store, options.version, options.now ?? (() => Date.now()), error);
    throw error;
  }
}

async function runPass1Internal(options: RunPass1Options): Promise<Pass1Result> {
  const store = options.store;
  const version = options.version;
  const now = options.now ?? (() => Date.now());
  const startedAt = new Date(now()).toISOString();
  const chunkBytes = options.chunkBytes ?? CLOUD_PASS1_DEFAULTS.chunkBytes;
  const sliceBytes = options.sliceBytes ?? CLOUD_PASS1_DEFAULTS.sliceBytes;
  const verifySegments = options.verifySegments ?? CLOUD_PASS1_DEFAULTS.verifySegments;
  const log = options.onLog ?? (() => {});
  const mode = options.mode ?? (options.maxSourceBytes === undefined ? "full" : "benchmark");

  const schema = await ensureSchema(store, version, options.sources);
  const existing = await store.getJson<CloudJobState>(cloudKeys.state(version));
  const control = (await store.getJson<CloudControl>(cloudKeys.control(version))) ?? defaultControl(now());

  const state: CloudJobState = existing ?? {
    engine: CLOUD_ENGINE_VERSION,
    jobId: version,
    version,
    stage: "preflight",
    startedAt,
    updatedAt: startedAt,
    mode,
    partitions: options.partitions,
    sources: options.sources.map((source) => emptySourceState(source, 0)),
    totals: { rowsRead: 0, rowsRejected: 0, rowsIndexed: 0, segments: 0, segmentBytes: 0, sourceBytesRead: 0 },
    rate: { rowsPerSecond: null, bytesPerSecond: null, etaSeconds: null },
    accounting: { classA: 0, classB: 0, bytesRead: 0, bytesWritten: 0, estimatedUsd: 0, containerSeconds: 0, containerUsd: 0 },
    checkpoint: null,
    errors: [],
  };
  state.mode = mode;
  state.partitions = options.partitions;
  state.config = {
    stage: "pass1",
    mode,
    partitions: options.partitions,
    ...(options.maxSourceBytes === undefined ? {} : { maxSourceMb: Math.round(options.maxSourceBytes / (1024 * 1024)) }),
    chunkMb: Math.round((chunkBytes / (1024 * 1024)) * 100) / 100,
    requestedAt: new Date(now()).toISOString(),
  };
  state.stage = "pass1";
  // A new attempt supersedes the previous attempt's interruption record. The
  // message itself stays in `errors` (history), but a live job must not keep
  // advertising a stop that no longer describes it.
  state.interruption = undefined;
  state.note = existing ? "Resumed from the durable checkpoints in R2." : "Pass 1 started; progress is checkpointed after every chunk.";
  state.updatedAt = new Date(now()).toISOString();
  await store.putJson(cloudKeys.state(version), state);

  const startedMs = now();
  let stopped: Pass1Result["stopped"] = "complete";
  const checkpoints: SourceCheckpoint[] = [];

  for (const [sourceIndex, source] of options.sources.entries()) {
    const head = await store.head(source.key);
    if (!head.exists || head.size === null) {
      throw new Error(`Source ${source.id} is missing at ${source.key}; refusing to plan a run over an absent source.`);
    }
    let checkpoint = await loadCheckpoint(store, version, source, head.size, chunkBytes, options.partitions);
    /*
     * A resumed run trusts the checkpoint, not state.json.
     *
     * The engine uploads a chunk, then its checkpoint, then state.json. A process
     * killed in that last window leaves state.json one chunk behind — observed on
     * staging: csv2's chunk, manifest and checkpoint all existed while state.json
     * still said 0 rows. Publishing the checkpoint here means the panel can never
     * display less progress than R2 durably holds, and a resume never re-reads a
     * chunk it already committed.
     */
    if (checkpoint) {
      state.sources[sourceIndex] = { ...state.sources[sourceIndex]!, ...progressOf(checkpoint), key: source.key, size: head.size, etag: head.etag };
      updateTotals(state, options.sources, now(), startedMs);
      await store.putJson(cloudKeys.state(version), state);
    }
    if (checkpoint?.complete) {
      log(`${source.id}: already complete (${checkpoint.rows.toLocaleString()} rows); not read again`);
      checkpoints.push(checkpoint);
      continue;
    }
    if (!checkpoint) {
      checkpoint = {
        engine: CLOUD_ENGINE_VERSION,
        version,
        sourceId: source.id,
        sourceKey: source.key,
        sourceEtag: head.etag,
        sourceSize: head.size,
        chunkBytes,
        partitions: options.partitions,
        nextOffset: 0,
        nextLine: 1,
        chunks: 0,
        rows: 0,
        rejected: 0,
        segmentBytes: 0,
        segments: 0,
        complete: false,
        updatedAt: new Date(now()).toISOString(),
      };
    }

    const bound = options.maxSourceBytes === undefined ? head.size : Math.min(head.size, options.maxSourceBytes);
    // A resumed bounded benchmark whose checkpoint is already at the limit has no
    // chunk left to read; without this it would report no stop reason at all and
    // look like a job that started and did nothing.
    if (options.maxSourceBytes !== undefined && checkpoint.nextOffset >= bound) {
      stopped = "bounded";
      log(`${source.id}: already at the bounded limit (${checkpoint.nextOffset.toLocaleString()} B); nothing to read`);
    }
    const sourceSchema = schema.sources[sourceIndex]!;
    const map = sourceSchema.map;
    const columns = sourceSchema.columns;
    const captured = sourceSchema.captured.map((column) => ({ index: column.index, label: column.label }));

    while (checkpoint.nextOffset < bound) {
      const currentControl = (await store.getJson<CloudControl>(cloudKeys.control(version))) ?? control;
      if (currentControl.abort) {
        await pauseState(store, state, "aborted", now(), "abort requested", "interrupted");
        stopped = "aborted";
        checkpoints.push(checkpoint);
        return { state, schema, checkpoints, stopped };
      }
      if (currentControl.pause) {
        await pauseState(store, state, "paused", now(), "pause requested", "interrupted");
        stopped = "paused";
        checkpoints.push(checkpoint);
        return { state, schema, checkpoints, stopped };
      }
      // The container runner forwards SIGTERM here (via `shouldStop`): stop at a
      // record boundary with everything committed, instead of being killed while a
      // segment or state object is half written.
      const stopReason = options.shouldStop?.() ?? null;
      if (stopReason) {
        await pauseState(store, state, "paused", now(), stopReason, "interrupted");
        stopped = "interrupted";
        checkpoints.push(checkpoint);
        return { state, schema, checkpoints, stopped };
      }

      const remaining = bound - checkpoint.nextOffset;
      const targetBytes = Math.min(chunkBytes, remaining);
      const chunkIndex: number = checkpoint.chunks;
      const chunk = await readChunk({
        store,
        key: source.key,
        size: head.size,
        startOffset: checkpoint.nextOffset,
        baseLine: checkpoint.nextLine,
        chunkBytes: targetBytes,
        sliceBytes,
        delimiter: source.delimiter,
        quote: source.quote,
      });

      // The header is the first record of the first chunk only. It is never a row.
      const dataRecords = chunkIndex === 0 ? chunk.records.slice(1) : chunk.records;
      const buckets = new Map<number, string[]>();
      const rejected: string[] = [];
      let chunkRejected = 0;
      let chunkIndexed = 0;

      for (const record of dataRecords) {
        if (record.fields.every((field) => field.trim() === "")) continue;
        const input = extractCompanyInput(record.fields, map, captured);
        if (!input) {
          chunkRejected += 1;
          rejected.push(encodeJsonlLine({ source: source.id, line: record.line, reason: "missing_company_name", fields: record.fields.slice(0, 8) }));
          continue;
        }
        chunkIndexed += 1;
        const keys = companyKeysFromInput(input, source.id);
        const partition = partitionFor(keys.partitionKey, options.partitions);
        const line = encodeSpoolV2Row(sourceIndex, record.line, normalizeValues(record.fields, columns));
        const bucket = buckets.get(partition);
        if (bucket) bucket.push(line);
        else buckets.set(partition, [line]);
      }

      // Uploads are independent per partition and R2 is strongly consistent on
      // PUT, so they run with bounded concurrency. Verification re-reads the bytes
      // just written: the checksum is of what R2 holds, not of what we sent.
      const pending = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([partition, lines]) => {
        const body = gzipSync(Buffer.from(`${lines.join("\n")}\n`, "utf8"), { level: 6 });
        return { partition, body, key: cloudKeys.segment(version, source.id, chunkIndex, partition), rows: lines.length, digest: sha256(body) };
      });
      const segments: CloudSegmentRef[] = [];
      let segmentBytes = 0;
      await mapLimit(pending, 8, async (segment) => {
        await store.put(segment.key, segment.body, "application/gzip");
        if (verifySegments) {
          const readBack = await store.getRange(segment.key, 0, segment.body.length);
          if (readBack.length !== segment.body.length || sha256(readBack) !== segment.digest) {
            throw new Error(
              `Segment verification failed for ${segment.key}: uploaded ${segment.body.length} B, read back ${readBack.length} B.`,
            );
          }
        }
        segmentBytes += segment.body.length;
        segments.push({ partition: segment.partition, key: segment.key, bytes: segment.body.length, rows: segment.rows, sha256: segment.digest });
      });
      segments.sort((a, b) => a.partition - b.partition);

      let rejectedKey: string | null = null;
      if (rejected.length) {
        const body = gzipSync(Buffer.from(`${rejected.join("\n")}\n`, "utf8"), { level: 6 });
        rejectedKey = cloudKeys.rejected(version, source.id, chunkIndex);
        await store.put(rejectedKey, body, "application/gzip");
      }

      const manifest: CloudChunkManifest = {
        engine: CLOUD_ENGINE_VERSION,
        jobId: version,
        version,
        sourceId: source.id,
        sourceKey: source.key,
        sourceEtag: head.etag,
        sourceSize: head.size,
        chunk: chunkIndex,
        range: { start: chunk.startOffset, end: chunk.endOffset },
        baseLine: chunk.baseLine,
        rows: chunkIndexed,
        rejected: chunkRejected,
        lines: chunk.lines,
        segments,
        rejectedKey,
        completedAt: new Date(now()).toISOString(),
        complete: true,
      };
      await store.putJson(cloudKeys.chunkManifest(version, source.id, chunkIndex), manifest);

      checkpoint = {
        ...checkpoint,
        nextOffset: chunk.endOffset,
        nextLine: chunk.baseLine + chunk.lines,
        chunks: chunkIndex + 1,
        rows: checkpoint.rows + manifest.rows,
        rejected: checkpoint.rejected + chunkRejected,
        segmentBytes: checkpoint.segmentBytes + segmentBytes,
        segments: checkpoint.segments + segments.length,
        updatedAt: new Date(now()).toISOString(),
      };
      await store.putJson(cloudKeys.checkpoint(version, source.id), checkpoint);

      state.sources[sourceIndex] = {
        ...state.sources[sourceIndex]!,
        key: source.key,
        size: head.size,
        etag: head.etag,
        nextOffset: checkpoint.nextOffset,
        nextLine: checkpoint.nextLine,
        chunks: checkpoint.chunks,
        rows: checkpoint.rows,
        rejected: checkpoint.rejected,
        sourceBytes: checkpoint.nextOffset,
        segments: checkpoint.segments,
        segmentBytes: checkpoint.segmentBytes,
        complete: checkpoint.complete,
      };
      updateTotals(state, options.sources, now(), startedMs);
      state.checkpoint = {
        at: checkpoint.updatedAt,
        sources: state.sources.map((entry) => ({ id: entry.id, nextOffset: entry.nextOffset, nextLine: entry.nextLine })),
      };
      await updateAccounting(store, state, now(), startedMs);
      await store.putJson(cloudKeys.state(version), state);
      // Proof of life for the panel and for a watchdog: a job whose heartbeat stops
      // is reported as stopped instead of "still running" forever.
      await options.heartbeat?.(checkpoint);

      /*
       * Conservative budget guard, not a hard billing cap.
       *
       * `CLOUD_JOB_BUDGET_USD` (30 by default in wrangler.toml) stops a full run at
       * the next chunk once the COMBINED running estimate (R2 + container, Pass 1
       * and Pass 2) reaches it. The estimate excludes R2 storage and any request
       * Cloudflare bills after the snapshot, so this is an operator protection, not
       * a guarantee — pause/abort remain authoritative. Benchmarks are never
       * stopped by it.
       */
      const budget = cloudJobBudgetUsd();
      const spent = state.accounting.estimatedUsd + state.accounting.containerUsd;
      if (mode === "full" && budget !== null && spent >= budget) {
        await pauseState(
          store,
          state,
          "paused",
          now(),
          `budget guard: combined estimate $${spent.toFixed(2)} (R2 + container, Pass 1 and Pass 2) ` +
            `reached CLOUD_JOB_BUDGET_USD=$${budget}. Raise the limit or resume deliberately.`,
          "interrupted",
        );
        stopped = "paused";
        checkpoints.push(checkpoint);
        return { state, schema, checkpoints, stopped };
      }

      const percent = head.size ? ((checkpoint.nextOffset / head.size) * 100).toFixed(1) : "0.0";
      log(
        `${source.id}: chunk ${chunkIndex + 1} · ${checkpoint.rows.toLocaleString()} rows · ` +
          `${percent}% of source · ${(checkpoint.segmentBytes / 1e9).toFixed(2)} GB spool`,
      );

      if (chunk.endOffset <= checkpoint.nextOffset && chunk.records.length === 0) break;
      if (options.maxSourceBytes !== undefined && checkpoint.nextOffset >= bound) {
        stopped = "bounded";
        break;
      }
    }

    if (checkpoint.nextOffset >= head.size) checkpoint.complete = true;
    await store.putJson(cloudKeys.checkpoint(version, source.id), checkpoint);
    state.sources[sourceIndex] = { ...state.sources[sourceIndex]!, ...progressOf(checkpoint) };
    checkpoints.push(checkpoint);
    // One durable state write per source boundary: a job that processes csv1 and is
    // then stopped still shows csv1's real progress, not the run's first snapshot.
    updateTotals(state, options.sources, now(), startedMs);
    await updateAccounting(store, state, now(), startedMs);
    await store.putJson(cloudKeys.state(version), state);
    // A bounded benchmark stops each source at its own limit; it must still visit
    // the next source instead of ending the job after the first one.
  }

  const complete = checkpoints.length === options.sources.length && checkpoints.every((entry) => entry.complete);
  /*
   * A bounded benchmark is "complete" when every source reached its limit, even
   * though the checkpoints are deliberately `complete: false` (they describe a
   * prefix, not the whole object). Without this the job stayed on `stage: pass1`
   * with a note, which the dashboard — correctly — could only read as unfinished.
   */
  const boundedReached =
    !complete &&
    options.maxSourceBytes !== undefined &&
    checkpoints.length === options.sources.length &&
    checkpoints.every((entry) => entry.nextOffset >= Math.min(entry.sourceSize, options.maxSourceBytes!));
  state.stage = complete || boundedReached ? "pass1-complete" : "pass1";
  state.coverage = complete ? "full" : boundedReached ? "bounded" : state.coverage;
  state.note = complete
    ? "Pass 1 complete: every source read to EOF and every segment verified."
    : boundedReached
      ? `Bounded benchmark complete: ${(options.maxSourceBytes! / 1024 / 1024).toFixed(0)} MB per source, every segment verified. Pass 2 merges that prefix; activation stays disabled for a benchmark.`
      : options.maxSourceBytes !== undefined
        ? `Bounded benchmark stopped before its ${(options.maxSourceBytes / 1024 / 1024).toFixed(0)} MB limit; re-running the same version resumes at the recorded offsets.`
        : "Partially processed. Re-running the same version resumes at the recorded offsets.";
  state.interruption = undefined;
  if (complete) state.finishedAt = new Date(now()).toISOString();
  updateTotals(state, options.sources, now(), startedMs);
  await updateAccounting(store, state, now(), startedMs);
  await store.putJson(cloudKeys.state(version), state);
  return { state, schema, checkpoints, stopped };
}

/**
 * Persist a failed attempt in the job state (best effort).
 *
 * The throw is re-raised by the caller, so the CLI still exits non-zero and the
 * runner still reports the stderr tail; this only makes the failure visible in R2.
 * A job that is already complete is never relabelled.
 */
async function recordFailure(store: BlobStore, version: string, now: () => number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const state = await store.getJson<CloudJobState>(cloudKeys.state(version));
    if (!state || state.stage === "complete" || state.stage === "pass1-complete") return;
    const at = new Date(now()).toISOString();
    state.stage = "failed";
    state.updatedAt = at;
    state.errors = [...state.errors, { at, stage: state.stage, message }].slice(-10);
    state.interruption = { at, outcome: "failed", reason: message };
    state.note = "Pass 1 failed. Every completed chunk is checkpointed; fix the cause and re-run the same version to resume.";
    await store.putJson(cloudKeys.state(version), state);
  } catch (secondary) {
    // Recording the failure must not mask the failure itself.
    if (secondary instanceof Error) {
      // eslint-disable-next-line no-console
      console.error(`could not record the failure in ${cloudKeys.state(version)}: ${secondary.message}`);
    }
  }
}

/**
 * Publish the durable checkpoints' progress in a job state.
 *
 * Used when a run is found stopped: the checkpoint is the last committed truth, and
 * state.json can legitimately lag it by one chunk (the process was killed between the
 * two writes). This only ever moves progress forward, and never invents a row count.
 * Returns true when something changed and the caller should write the state back.
 */
export async function syncStateFromCheckpoints(store: BlobStore, state: CloudJobState): Promise<boolean> {
  let changed = false;
  for (const [index, source] of state.sources.entries()) {
    const checkpoint = await store.getJson<SourceCheckpoint>(cloudKeys.checkpoint(state.version, source.id));
    if (!checkpoint || checkpoint.sourceId !== source.id) continue;
    if (checkpoint.chunks <= source.chunks && checkpoint.nextOffset <= source.sourceBytes) {
      // Progress is not behind. The one thing that can still be missing is the source
      // metadata: a state created before the source was HEADed carries `size: 0`.
      if (source.size === checkpoint.sourceSize && source.etag === checkpoint.sourceEtag) continue;
      state.sources[index] = { ...source, size: checkpoint.sourceSize, etag: checkpoint.sourceEtag };
      changed = true;
      continue;
    }
    state.sources[index] = { ...source, ...progressOf(checkpoint) };
    changed = true;
  }
  if (!changed) return false;
  const sum = (pick: (source: CloudSourceState) => number) => state.sources.reduce((total, source) => total + pick(source), 0);
  state.totals = {
    rowsRead: sum((source) => source.rows + source.rejected),
    rowsRejected: sum((source) => source.rejected),
    rowsIndexed: sum((source) => source.rows),
    segments: sum((source) => source.segments),
    segmentBytes: sum((source) => source.segmentBytes),
    sourceBytesRead: sum((source) => source.sourceBytes),
  };
  return true;
}

/** Per-source progress fields copied from a checkpoint into the job state. */
function progressOf(checkpoint: SourceCheckpoint): Pick<
  CloudSourceState,
  "size" | "etag" | "nextOffset" | "nextLine" | "chunks" | "rows" | "rejected" | "sourceBytes" | "segments" | "segmentBytes" | "complete"
> {
  return {
    // A checkpoint records the object it was read from; a state created before the
    // source was HEADed (the staging job) otherwise keeps `size: 0, etag: null`.
    size: checkpoint.sourceSize,
    etag: checkpoint.sourceEtag,
    nextOffset: checkpoint.nextOffset,
    nextLine: checkpoint.nextLine,
    chunks: checkpoint.chunks,
    rows: checkpoint.rows,
    rejected: checkpoint.rejected,
    sourceBytes: checkpoint.nextOffset,
    segments: checkpoint.segments,
    segmentBytes: checkpoint.segmentBytes,
    complete: checkpoint.complete,
  };
}

/**
 * Build (or read) the spool schema for a version.
 *
 * Exported because the swarm's range tasks need the identical schema: the spool
 * format is positional (`schema.sources[i]` belongs to `sources[i]`), so a range
 * task that invented its own mapping would write rows Pass 2 cannot merge.
 */
export async function ensureSchema(store: BlobStore, version: string, sources: Pass1SourceSpec[]): Promise<SpoolSchema> {
  const existing = await store.getJson<SpoolSchema>(cloudKeys.schema(version));
  if (existing) return existing;
  const schema: SpoolSchema = { format: SPOOL_FORMAT_VERSION, sources: [] };
  for (const source of sources) {
    const head = await store.head(source.key);
    if (!head.exists || head.size === null) throw new Error(`Source ${source.id} is missing at ${source.key}.`);
    const header = await readHeader({ store, key: source.key, size: head.size, delimiter: source.delimiter, quote: source.quote });
    const map = buildColumnMap(header.fields);
    for (const [field, text] of Object.entries(source.columns ?? {})) {
      const index = header.fields.findIndex((value) => value.trim().toLowerCase() === text.trim().toLowerCase());
      if (index !== -1) map[field] = index;
    }
    schema.sources.push({
      id: source.id,
      delimiter: source.delimiter,
      columns: header.fields.length,
      map,
      captured: capturedColumns(header.fields, map),
    });
  }
  await store.putJson(cloudKeys.schema(version), schema);
  return schema;
}

async function loadCheckpoint(
  store: BlobStore,
  version: string,
  source: Pass1SourceSpec,
  size: number,
  chunkBytes: number,
  partitions: number,
): Promise<SourceCheckpoint | null> {
  const checkpoint = await store.getJson<SourceCheckpoint>(cloudKeys.checkpoint(version, source.id));
  if (!checkpoint) return null;
  const mismatch = [
    checkpoint.engine !== CLOUD_ENGINE_VERSION ? "engine" : null,
    checkpoint.sourceKey !== source.key ? "source object" : null,
    checkpoint.sourceSize !== size ? "source size" : null,
    checkpoint.chunkBytes !== chunkBytes ? "chunk size" : null,
    checkpoint.partitions !== partitions ? "partition count" : null,
  ].filter(Boolean);
  if (mismatch.length) {
    throw new Error(
      `Checkpoint for ${source.id} does not belong to this run (${mismatch.join(", ")}). ` +
        "Refusing to resume over a different source or layout; start a new --version or use the recorded settings.",
    );
  }
  return checkpoint;
}

function defaultControl(nowMs: number): CloudControl {
  return {
    version: CLOUD_CONTROL_VERSION,
    pause: false,
    abort: false,
    approvedFullRun: false,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function emptySourceState(source: Pass1SourceSpec, size: number): CloudSourceState {
  return {
    id: source.id,
    key: source.key,
    size,
    etag: null,
    nextOffset: 0,
    nextLine: 1,
    chunks: 0,
    rows: 0,
    rejected: 0,
    sourceBytes: 0,
    segments: 0,
    segmentBytes: 0,
    complete: false,
  };
}

function updateTotals(state: CloudJobState, sources: Pass1SourceSpec[], nowMs: number, startedMs: number): void {
  state.totals = {
    rowsRead: state.sources.reduce((total, entry) => total + entry.rows + entry.rejected, 0),
    rowsRejected: state.sources.reduce((total, entry) => total + entry.rejected, 0),
    rowsIndexed: state.sources.reduce((total, entry) => total + entry.rows, 0),
    segments: state.sources.reduce((total, entry) => total + entry.segments, 0),
    segmentBytes: state.sources.reduce((total, entry) => total + entry.segmentBytes, 0),
    sourceBytesRead: state.sources.reduce((total, entry) => total + entry.sourceBytes, 0),
  };
  const seconds = Math.max(0.001, (nowMs - startedMs) / 1000);
  const expected = sources.reduce((total, entry) => total + (state.sources.find((item) => item.id === entry.id)?.size ?? 0), 0);
  const bytesPerSecond = state.totals.sourceBytesRead / seconds;
  state.rate = {
    rowsPerSecond: state.totals.rowsRead / seconds,
    bytesPerSecond,
    etaSeconds: bytesPerSecond && expected > state.totals.sourceBytesRead ? (expected - state.totals.sourceBytesRead) / bytesPerSecond : 0,
  };
  state.updatedAt = new Date(nowMs).toISOString();
}

async function updateAccounting(store: BlobStore, state: CloudJobState, nowMs: number, startedMs: number): Promise<void> {
  const counters =
    "countersSnapshot" in store && typeof (store as { countersSnapshot?: () => unknown }).countersSnapshot === "function"
      ? ((store as { countersSnapshot: () => { classA: number; classB: number; bytesRead: number; bytesWritten: number } }).countersSnapshot())
      : null;
  if (counters) {
    state.accounting.classA = counters.classA;
    state.accounting.classB = counters.classB;
    state.accounting.bytesRead = counters.bytesRead;
    state.accounting.bytesWritten = counters.bytesWritten;
  }
  const seconds = Math.max(0, (nowMs - startedMs) / 1000);
  state.accounting.containerSeconds = seconds;
  state.accounting.estimatedUsd =
    (state.accounting.classA / 1e6) * R2_PRICES.classAPerMillion +
    (state.accounting.classB / 1e6) * R2_PRICES.classBPerMillion +
    (state.accounting.bytesWritten / 1e9) * R2_PRICES.storagePerGbMonth;
  state.accounting.containerUsd =
    seconds * (CONTAINER_PRICE.vcpu * CONTAINER_PRICE.vcpuPerSecond + CONTAINER_PRICE.gib * CONTAINER_PRICE.gibPerSecond);
}

async function pauseState(
  store: BlobStore,
  state: CloudJobState,
  stage: CloudJobState["stage"],
  nowMs: number,
  note: string,
  outcome: CloudInterruption["outcome"],
): Promise<void> {
  state.stage = stage;
  state.note = note;
  const at = new Date(nowMs).toISOString();
  state.updatedAt = at;
  state.interruption = { at, outcome, reason: note };
  await store.putJson(cloudKeys.state(state.version), state);
}

export interface VerifyReport {
  ok: boolean;
  version: string;
  chunks: number;
  rows: number;
  rejected: number;
  segments: number;
  segmentBytes: number;
  problems: string[];
}

/**
 * Independently re-verify a cloud run from R2 alone: every chunk manifest is
 * read, every segment is hashed, ranges must be contiguous from 0 to the source
 * size, and per-chunk row counts must equal the segments' row counts.
 */
export async function verifyRun(options: {
  store: BlobStore;
  version: string;
  sources: Pass1SourceSpec[];
}): Promise<VerifyReport> {
  const problems: string[] = [];
  const report: VerifyReport = { ok: false, version: options.version, chunks: 0, rows: 0, rejected: 0, segments: 0, segmentBytes: 0, problems };

  for (const source of options.sources) {
    const head = await options.store.head(source.key);
    const manifests = (await options.store.list(`${cloudKeys.jobRoot(options.version)}/chunks/${source.id}/`)).filter((entry) =>
      entry.key.endsWith(".json"),
    );
    let expectedOffset = 0;
    let expectedLine = 1;
    let previousChunk = -1;
    for (const entry of manifests.sort((a, b) => a.key.localeCompare(b.key))) {
      const manifest = await options.store.getJson<CloudChunkManifest>(entry.key);
      if (!manifest) {
        problems.push(`${entry.key}: manifest unreadable`);
        continue;
      }
      if (manifest.chunk !== previousChunk + 1) problems.push(`${source.id}: chunk ${manifest.chunk} is out of sequence`);
      if (manifest.range.start !== expectedOffset) {
        problems.push(`${source.id}: chunk ${manifest.chunk} starts at ${manifest.range.start}, expected ${expectedOffset}`);
      }
      if (manifest.baseLine !== expectedLine) {
        problems.push(`${source.id}: chunk ${manifest.chunk} starts at line ${manifest.baseLine}, expected ${expectedLine}`);
      }
      if (manifest.sourceEtag !== head.etag) {
        problems.push(`${source.id}: chunk ${manifest.chunk} was read from a different source version (etag)`);
      }
      let manifestRows = 0;
      for (const segment of manifest.segments) {
        const info = await options.store.head(segment.key);
        if (!info.exists || info.size !== segment.bytes) {
          problems.push(`${segment.key}: ${info.exists ? `size ${info.size} != ${segment.bytes}` : "missing"}`);
          continue;
        }
        const body = await options.store.getRange(segment.key, 0, segment.bytes);
        if (sha256(body) !== segment.sha256) problems.push(`${segment.key}: checksum mismatch`);
        manifestRows += segment.rows;
      }
      if (manifestRows !== manifest.rows) {
        problems.push(`${source.id}: chunk ${manifest.chunk} records ${manifest.rows} rows but its segments hold ${manifestRows}`);
      }
      report.chunks += 1;
      report.rows += manifest.rows;
      report.rejected += manifest.rejected;
      report.segments += manifest.segments.length;
      report.segmentBytes += manifest.segments.reduce((total, segment) => total + segment.bytes, 0);
      expectedOffset = manifest.range.end;
      expectedLine = manifest.baseLine + manifest.lines;
      previousChunk = manifest.chunk;
    }
    const checkpoint = await options.store.getJson<SourceCheckpoint>(cloudKeys.checkpoint(options.version, source.id));
    if (manifests.length === 0) problems.push(`${source.id}: no chunk manifests`);
    else if (checkpoint?.complete && expectedOffset !== head.size) {
      problems.push(`${source.id}: chunks cover ${expectedOffset} of ${head.size} bytes`);
    }
    // A bounded benchmark stops at a prefix; its checkpoint says `complete:false`,
    // so "the chunks cover the whole object" is not a property it can have.
  }

  report.ok = problems.length === 0;
  return report;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order of results. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]!);
    }
  });
  await Promise.all(workers);
}

/** Build Pass1 sources from the indexer config (paths must be r2://bucket/key). */
export function cloudSourcesFromConfig(config: IndexerConfig): Pass1SourceSpec[] {
  return config.sources.map((source) => {
    const match = /^r2:\/\/([^/]+)\/(.+)$/.exec(source.path);
    if (!match) {
      throw new Error(
        `Cloud indexing reads sources from R2 only; ${source.id} is ${source.path}. ` +
          "Upload it once, or set its path to r2://<bucket>/<key>.",
      );
    }
    return {
      id: source.id,
      key: match[2]!,
      delimiter: source.delimiter ?? "\t",
      quote: '"',
      columns: source.columns,
    };
  });
}
