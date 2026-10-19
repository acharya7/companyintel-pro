/**
 * Cloud Pass 2: merge verified Pass 1 segments into a v4 index without ever
 * materialising the full spool or the full index locally.
 *
 * The merge logic itself is the production one from `tools/indexer/src/build.ts`;
 * this module only relocates its inputs and outputs:
 *
 *   - one partition at a time is concatenated from its R2 segment objects into
 *     `workDir/spool/part-NNNN.jsonl`, merged, and deleted. Peak local disk is the
 *     largest partition (tens of MB with the default 256 partitions), not the ~23 GB
 *     spool and definitely not the ~20 GB index;
 *   - posting shards are flushed every few partitions as gzip objects under
 *     `cloud/jobs/<version>/pass2/shards/…`;
 *   - generated projections, details, indexes and manifests are PUT straight to
 *     their final versioned keys.
 *
 * What is still enforced, unchanged:
 *
 *   - every partition's segment checksums and byte lengths are verified before its
 *     rows are merged, and the merged partition is re-hashed against what the
 *     segments recorded;
 *   - the manifest is written last, so an interrupted run can never look complete;
 *   - a version whose manifest already exists is refused (never overwritten);
 *   - pause/abort are honoured between partitions and recorded durably in R2.
 *
 * Restart semantics: the merge is deterministic and replays from partition 1.
 * Every output key is overwritten with identical bytes, so a restart cannot
 * duplicate a company, contact or posting. The Pass 1 segments are read-only.
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { identityFor, runIndex, type CloudMergeResume, type IndexerConfig, type ProgressEvent } from "../indexer/src/build";
import type { SpoolManifest } from "../indexer/src/spool";
import { spoolV2SidecarName, type SpoolFrameEntry, type SpoolSchema } from "../indexer/src/spool-v2";
import {
  cloudKeys,
  type CloudChunkManifest,
  type CloudControl,
  type CloudJobState,
  type CloudPass2Checkpoint,
  type CloudSegmentRef,
} from "../../src/shared/cloud/types";

import { CONTAINER_PRICE, R2_PRICES, cloudJobBudgetUsd, type SourceCheckpoint } from "./pass1";
import type { BlobStore } from "./store";

export interface CloudPass2Result {
  state: CloudJobState;
  stopped: "complete" | "paused" | "aborted";
  partitions: number;
  rows: number;
  companies: number;
  contacts: number;
  indexObjects: number;
  indexBytes: number;
  shardParts: number;
  elapsedMs: number;
}

/** Thrown between partitions when the operator asked the job to stop. */
class CloudStop extends Error {
  constructor(
    readonly kind: "paused" | "aborted",
    readonly reason?: string,
  ) {
    super(reason ?? (kind === "paused" ? "paused by operator" : "aborted by operator"));
  }
}

interface SegmentSource {
  sourceId: string;
  chunk: number;
  segment: CloudSegmentRef;
}

export interface RunCloudPass2Options {
  store: BlobStore;
  version: string;
  config: IndexerConfig;
  /** Scratch directory for one partition at a time. Must not be a source spool. */
  workDir: string;
  onLog?: (line: string) => void;
  onProgress?: (event: ProgressEvent) => void;
  /** Hard local-disk floor during the merge (default 64 MB). */
  diskFloorBytes?: number;
  /**
   * Merge a bounded benchmark's segments. Pass 1 stops a benchmark at a byte prefix,
   * so its checkpoints are deliberately `complete:false`; this flag accepts that
   * prefix, but only for a job already marked `mode: "benchmark"`.
   */
  allowBounded?: boolean;
  now?: () => number;
}

export async function runCloudPass2(options: RunCloudPass2Options): Promise<CloudPass2Result> {
  const { store, version } = options;
  const config = { ...options.config, datasetVersion: version };
  const now = options.now ?? (() => Date.now());
  const log = options.onLog ?? (() => {});
  const startedMs = now();
  const workDir = resolve(options.workDir);

  /* ------------------------------- guards -------------------------------- */

  // A manifest means this version is complete. Writing into it would replace a
  // verified index in place, so it is refused; use a new version id.
  const existingManifest = await store.getJson<{ validationPassed?: boolean }>(`manifests/${version}/manifest.json`);
  if (existingManifest && existingManifest.validationPassed !== false) {
    throw new Error(
      `Refusing to build ${version}: manifests/${version}/manifest.json already exists and is validated. ` +
        "A completed version is immutable — choose a new version id.",
    );
  }
  if (existingManifest) {
    log(`replacing a previous attempt of ${version} that failed validation; no validated object is overwritten`);
  }

  const state = await store.getJson<CloudJobState>(cloudKeys.state(version));
  if (!state) throw new Error(`No cloud job state at ${cloudKeys.state(version)}; run Pass 1 first.`);
  // `pass2` means an earlier attempt was interrupted; `paused` means the operator
  // stopped between partitions. Both replay deterministically from partition 1.
  // `failed` is recoverable: an operator fixes the cause and re-runs; nothing was
  // activated and Pass 1 is untouched. The version is still immutable once a
  // manifest exists (checked above).
  const boundedReady = options.allowBounded === true && state.mode === "benchmark" && state.stage === "pass1";
  if (state.stage !== "pass1-complete" && state.stage !== "pass2" && state.stage !== "paused" && state.stage !== "failed" && !boundedReady) {
    throw new Error(
      `Refusing Cloud Pass 2: the job is at stage "${state.stage}", not "pass1-complete". Finish or resume Pass 1 first.`,
    );
  }

  const schema = await store.getJson<SpoolSchema>(cloudKeys.schema(version));
  if (!schema) throw new Error(`No Pass 1 schema at ${cloudKeys.schema(version)}.`);

  const checkpoints: SourceCheckpoint[] = [];
  for (const source of config.sources) {
    const checkpoint = await store.getJson<SourceCheckpoint>(cloudKeys.checkpoint(version, source.id));
    if (!checkpoint) throw new Error(`No Pass 1 checkpoint for ${source.id}.`);
    if (!checkpoint.complete) {
      if (!options.allowBounded || state.mode !== "benchmark") {
        throw new Error(
          `${source.id} is incomplete (${checkpoint.nextOffset.toLocaleString()} of ${checkpoint.sourceSize.toLocaleString()} bytes); ` +
            "Cloud Pass 2 only merges a complete, verified Pass 1 (or a benchmark with --allow-bounded).",
        );
      }
      log(`${source.id}: bounded benchmark prefix of ${checkpoint.nextOffset.toLocaleString()} bytes; merging that prefix only`);
    }
    if (checkpoint.partitions !== config.partitions) {
      throw new Error(
        `Refusing to merge: Pass 1 used ${checkpoint.partitions} partitions but this run is configured for ${config.partitions}. ` +
          "The partition count is part of the spool identity.",
      );
    }
    checkpoints.push(checkpoint);
  }

  /*
   * Verify the segment chain before writing anything. This re-reads chunk
   * manifests (small JSON) and every segment's HEAD, not its body: Pass 1 already
   * verified every uploaded segment byte-for-byte, and the merge re-verifies each
   * segment's checksum as it concatenates it. Doing both would double the read
   * cost for no additional guarantee.
   */
  const manifests = await loadChunkManifests(store, version, checkpoints);
  const problems: string[] = [];
  let totalRows = 0;
  let totalSegmentBytes = 0;
  for (const source of config.sources) {
    const checkpoint = checkpoints.find((entry) => entry.sourceId === source.id)!;
    let expectedChunk = 0;
    for (const [key, manifest] of manifests) {
      if (manifest.sourceId !== source.id) continue;
      if (manifest.chunk !== expectedChunk) problems.push(`${source.id}: chunk ${manifest.chunk} is out of sequence`);
      expectedChunk = manifest.chunk + 1;
      let manifestRows = 0;
      for (const segment of manifest.segments) {
        const head = await store.head(segment.key);
        if (!head.exists || head.size !== segment.bytes) {
          problems.push(`${segment.key}: ${head.exists ? `size ${head.size} != ${segment.bytes}` : "missing"}`);
          continue;
        }
        manifestRows += segment.rows;
        totalRows += segment.rows;
        totalSegmentBytes += segment.bytes;
      }
      if (manifestRows !== manifest.rows) {
        problems.push(`${source.id}: chunk ${manifest.chunk} records ${manifest.rows} rows but its segments hold ${manifestRows}`);
      }
      void key;
    }
    if (expectedChunk !== checkpoint.chunks) {
      problems.push(`${source.id}: ${expectedChunk} chunk manifests but the checkpoint records ${checkpoint.chunks}`);
    }
  }
  if (problems.length) {
    throw new Error(`Refusing Cloud Pass 2: Pass 1 verification failed.\n  ${problems.slice(0, 20).join("\n  ")}`);
  }
  log(`Pass 1 verified: ${totalRows.toLocaleString()} rows in ${manifests.size} chunks, ${(totalSegmentBytes / 1e9).toFixed(2)} GB of segments`);

  /* --------------------------- local bookkeeping -------------------------- */

  assertScratchDir(workDir, version, config);
  prepareWorkDir(workDir, version);
  const spoolDir = join(workDir, "spool");
  mkdirSync(spoolDir, { recursive: true });

  const identity = identityFor(config, undefined);
  const createdAt = new Date(now()).toISOString();
  const partitionEntries: SpoolManifest["partitions"] = Array.from({ length: config.partitions }, (_, partition) => ({
    file: `part-${String(partition).padStart(4, "0")}.jsonl.gz`,
    partition,
    bytes: 0,
    lines: 0,
    sha256: "",
    frames: 0,
  }));

  // The merge only needs the manifest and a pass2-merge checkpoint; partitions are
  // materialised one at a time and are NOT all present at any moment.
  const manifest: SpoolManifest = {
    format: 2,
    schema,
    identity,
    complete: true,
    createdAt,
    partitions: partitionEntries,
    totals: { files: partitionEntries.length, lines: totalRows, bytes: 0 },
  };
  writeJsonSync(join(workDir, "spool-manifest.json"), manifest);
  writeJsonSync(join(workDir, "checkpoint.json"), {
    stage: "pass2-merge",
    identity,
    counters: {
      rowsRead: totalRows,
      rowsRejected: checkpoints.reduce((total, entry) => total + entry.rejected, 0),
      // Per-source row accounting is restored from Pass 1. Without it the merge's
      // validation reports `source_missing_rows` (csv1=0, csv2=0) and a perfectly
      // good index is marked failed — measured on the first real-R2 Pass 2 run.
      perSource: Object.fromEntries(
        checkpoints.map((entry) => [
          entry.sourceId,
          { rowsRead: entry.rows, rowsRejected: entry.rejected, companies: 0, contacts: 0 },
        ]),
      ),
    },
    // Provenance: this checkpoint is derived from R2 segments, not a local spool.
    cloud: { version, segments: manifests.size, segmentBytes: totalSegmentBytes },
  });
  writeJsonSync(join(spoolDir, "schema.json"), schema);

  const segmentsByPartition = new Map<number, SegmentSource[]>();
  for (const source of config.sources) {
    const checkpoint = checkpoints.find((entry) => entry.sourceId === source.id)!;
    for (let chunk = 0; chunk < checkpoint.chunks; chunk += 1) {
      const manifest = manifests.get(`${source.id}/${chunk}`);
      if (!manifest) continue;
      for (const segment of manifest.segments) {
        const list = segmentsByPartition.get(segment.partition);
        const entry = { sourceId: source.id, chunk, segment };
        if (list) list.push(entry);
        else segmentsByPartition.set(segment.partition, [entry]);
      }
    }
  }
  // Chunk order, then source order: identical to `assembleRun`, so the partition
  // hash — and therefore the index — matches a local merge of the same segments.
  for (const list of segmentsByPartition.values()) {
    list.sort((a, b) => a.chunk - b.chunk || config.sources.findIndex((s) => s.id === a.sourceId) - config.sources.findIndex((s) => s.id === b.sourceId));
  }

  let shardParts = 0;
  const stateControl = async (): Promise<CloudControl | null> => store.getJson<CloudControl>(cloudKeys.control(version));

  let accountingCursor = countersOf(store);
  let accountingClock = startedMs;
  const outputDir = join(workDir, "out");
  mkdirSync(outputDir, { recursive: true });
  const projectConfig: IndexerConfig = { ...config, workDir, outputDir, datasetVersion: version };
  /** Persist R2 + container cost for the partitions merged since the last call. */
  const reconcileAccounting = async (current: CloudJobState): Promise<number> => {
    const at = now();
    await updateAccounting(store, current, accountingCursor, (at - accountingClock) / 1000);
    accountingCursor = countersOf(store);
    accountingClock = at;
    return current.accounting.estimatedUsd + current.accounting.containerUsd;
  };

  /*
   * Durable Pass 2 checkpoint.
   *
   * `stage: "merge"` records progress after every partition. When the merge has
   * finished, `mergeComplete: true` plus the finalize snapshot is written: a
   * restart after that point rebuilds only the index shards, manifests and
   * validation, and skips the merge entirely — but only after the shard parts it
   * refers to have been verified to exist with the recorded count and size. If
   * anything disagrees the run falls back to the full deterministic replay, which
   * overwrites every output with identical bytes.
   */
  const existingCheckpoint = await store.getJson<CloudPass2Checkpoint>(cloudKeys.pass2Checkpoint(version));
  let resumeState: CloudMergeResume | null = null;
  if (existingCheckpoint?.mergeComplete && existingCheckpoint.resume) {
    const problems = await verifyShardParts(store, version, existingCheckpoint.shardParts, existingCheckpoint.shardPartBytes);
    if (problems.length) {
      log(
        `pass 2: a previous merge completed, but its posting shards do not check out (${problems[0]}); ` +
          "replaying the merge from partition 1 instead.",
      );
    } else {
      resumeState = existingCheckpoint.resume as CloudMergeResume;
      log(
        `pass 2: restarting AFTER a completed merge (${existingCheckpoint.partitionsDone}/${existingCheckpoint.partitionsTotal} partitions, ` +
          `${existingCheckpoint.shardParts.toLocaleString()} shard parts verified in R2). The merge is not repeated; ` +
          "the index shards, manifests and validation are rebuilt.",
      );
    }
  }

  const writeCheckpoint = async (checkpoint: CloudPass2Checkpoint) => {
    await store.putJson(cloudKeys.pass2Checkpoint(version), checkpoint);
  };

  let stopped: CloudPass2Result["stopped"] = "complete";
  let result: Awaited<ReturnType<typeof runIndex>> | null = null;

  try {
    result = await runIndex(projectConfig, {
      resume: true,
      importedRows: totalRows,
      diskFloorBytes: options.diskFloorBytes ?? 64 * 1024 * 1024,
      onProgress: options.onProgress,
      ...(resumeState ? { cloudResume: resumeState } : {}),
      cloud: {
        onMergeComplete: async (snapshot) => {
          await writeCheckpoint({
            version,
            stage: "merge",
            partitionsDone: config.partitions,
            partitionsTotal: config.partitions,
            shardParts: snapshot.shardParts,
            shardPartBytes: snapshot.shardPartBytes,
            rowsMerged: totalRows,
            updatedAt: new Date(now()).toISOString(),
            mergeComplete: true,
            // Everything finalize needs, so a restart in that phase is exact.
            resume: snapshot,
          });
        },
        preparePartition: async (entry) => {
          const target = join(spoolDir, entry.file);
          const sources = segmentsByPartition.get(entry.partition) ?? [];
          const hash = createHash("sha256");
          const stream = createWriteStream(target);
          const ledger: SpoolFrameEntry[] = [];
          let bytes = 0;
          let rows = 0;
          let frames = 0;
          const writeFrame = async (body: Buffer, frameRows: number, sha256: string) => {
            ledger.push({ offset: bytes, bytes: body.length, rows: frameRows, sha256 });
            hash.update(body);
            frames += 1;
            bytes += body.length;
            rows += frameRows;
            await new Promise<void>((resolveWrite, rejectWrite) => {
              stream.write(body, (error) => (error ? rejectWrite(error) : resolveWrite()));
            });
          };
          for (const { segment } of sources) {
            const body = await store.getRange(segment.key, 0, segment.bytes);
            if (body.length !== segment.bytes) {
              throw new Error(`${segment.key}: expected ${segment.bytes} bytes, read ${body.length}. Nothing was merged from this partition.`);
            }
            const actual = createHash("sha256").update(body).digest("hex");
            if (actual !== segment.sha256) {
              throw new Error(`${segment.key}: checksum mismatch (segment changed after Pass 1 verified it). Refusing to merge it.`);
            }
            // Each segment is one gzip frame; its ledger entry is exactly the frame
            // the merge will verify, so a changed segment cannot slip through the
            // partition checksum either.
            await writeFrame(body, segment.rows, segment.sha256);
          }
          if (!frames) {
            // An empty partition is legal. The merge expects a gzip member; write one
            // empty member and record it, exactly as local assembly does.
            const empty = gzipSync(Buffer.alloc(0));
            await writeFrame(empty, 0, createHash("sha256").update(empty).digest("hex"));
          }
          await new Promise<void>((resolveEnd, rejectEnd) => stream.end((error?: Error | null) => (error ? rejectEnd(error) : resolveEnd())));
          const onDisk = statSync(target).size;
          if (onDisk !== bytes) throw new Error(`Materialised ${target} is ${onDisk} bytes, expected ${bytes}.`);
          writeFileSync(
            join(spoolDir, spoolV2SidecarName(entry.partition)),
            ledger.map((frame) => `${JSON.stringify(frame)}\n`).join(""),
          );
          const sha256 = hash.digest("hex");
          return { bytes: onDisk, lines: rows, sha256, segments: frames };
        },

        releasePartition: async (entry) => {
          rmSync(join(spoolDir, entry.file), { force: true });
          rmSync(join(spoolDir, spoolV2SidecarName(entry.partition)), { force: true });
        },

        onPartition: async (info) => {
          const control = await stateControl();
          if (control?.abort) throw new CloudStop("aborted");
          if (control?.pause) throw new CloudStop("paused");

          const current = (await store.getJson<CloudJobState>(cloudKeys.state(version))) ?? state;
          current.stage = "pass2";
          current.updatedAt = new Date(now()).toISOString();
          current.totals.rowsIndexed = info.rows;
          current.rate = {
            rowsPerSecond: info.elapsedMs > 0 ? Math.round(info.rows / (info.elapsedMs / 1000)) : null,
            bytesPerSecond: null,
            etaSeconds:
              info.partitionsDone > 0 && info.partitionsDone < info.partitionsTotal
                ? Math.round(((info.elapsedMs / info.partitionsDone) * (info.partitionsTotal - info.partitionsDone)) / 1000)
                : 0,
          };
          await writeCheckpoint({
            version,
            stage: "merge",
            partitionsDone: info.partitionsDone,
            partitionsTotal: info.partitionsTotal,
            shardParts,
            shardPartBytes: 0,
            rowsMerged: info.rows,
            updatedAt: current.updatedAt,
            mergeComplete: false,
          });
          const indexObjects = (await store.list(`indexes/${version}/`)).length;
          current.pass2 = {
            partitionsDone: info.partitionsDone,
            partitionsTotal: info.partitionsTotal,
            shardParts,
            indexObjects,
            indexBytes: 0,
            rowsPerSecond: current.rate.rowsPerSecond,
            updatedAt: current.updatedAt,
          };
          await store.putJson(cloudKeys.state(version), current);

          // Combined job budget: R2 requests + container time, across BOTH stages.
          // Checked at the partition boundary, which is also where a restart is
          // safe. Benchmarks are never stopped by it.
          const spent = await reconcileAccounting(current);
          const budget = cloudJobBudgetUsd();
          current.accounting.budgetUsd = budget ?? undefined;
          current.accounting.combinedUsd = spent;
          if (state.mode === "full" && budget !== null && spent >= budget) {
            throw new CloudStop(
              "paused",
              `budget guard: combined estimate $${spent.toFixed(2)} (R2 + container, Pass 1 and Pass 2) ` +
                `reached CLOUD_JOB_BUDGET_USD=$${budget}. Raise the limit or resume deliberately.`,
            );
          }
          await store.putJson(cloudKeys.state(version), current);
        },

        writeShardPart: async (batch, kind, shard, body) => {
          const key = `${cloudKeys.jobRoot(version)}/pass2/shards/${kind}/${String(shard).padStart(4, "0")}/${String(batch).padStart(6, "0")}.lines.gz`;
          // No `content-encoding` on intermediate parts: it would make every ranged
          // GET an HTTP-level decompression of a byte range (which is not a gzip
          // stream) and the read-back fails with a ZlibError. The driver gunzips
          // these itself; the Worker never reads them.
          await store.put(key, gzipSync(body, { level: 6 }), "application/gzip");
          shardParts += 1;
          void batch;
        },

        readShardParts: async function* (kind, shard) {
          const prefix = `${cloudKeys.jobRoot(version)}/pass2/shards/${kind}/${String(shard).padStart(4, "0")}/`;
          const parts = (await store.list(prefix)).sort((a, b) => a.key.localeCompare(b.key));
          for (const part of parts) {
            const body = await store.getRange(part.key, 0, part.size);
            const text = gunzipSync(body).toString("utf8");
            for (const line of text.split("\n")) if (line) yield line;
          }
        },

        writeObject: async (key, body, gzip) => {
          // Deliberately no `content-encoding` even for gzip bytes. R2's S3 endpoint
          // auto-decodes a response that carries it, which breaks both ranged reads
          // (the validation read-back) and the byte-for-byte checksum comparison. The
          // Worker detects gzip by its magic bytes (`worker/src/store.ts`), so the
          // header is not needed for serving, and the local uploader's files remain
          // readable the same way.
          await store.put(key, body, gzip ? "application/gzip" : "application/json");
        },

        readObject: async (key) => {
          const head = await store.head(key);
          if (!head.exists || head.size === null) throw new Error(`Generated object is missing after upload: ${key}`);
          return store.getRange(key, 0, head.size);
        },
      },
    });
  } catch (error) {
    if (error instanceof CloudStop) {
      stopped = error.kind;
      const current = (await store.getJson<CloudJobState>(cloudKeys.state(version))) ?? state;
      current.stage = error.kind;
      current.updatedAt = new Date(now()).toISOString();
      current.note =
        error.kind === "paused"
          ? `${error.reason ?? "Paused by operator."} Resume replays Cloud Pass 2 from partition 1; outputs are deterministic and overwritten.`
          : "Aborted. Pass 1 segments are untouched; no activation happened.";
      await reconcileAccounting(current);
      current.accounting.budgetUsd = cloudJobBudgetUsd() ?? undefined;
      current.accounting.combinedUsd = current.accounting.estimatedUsd + current.accounting.containerUsd;
      await store.putJson(cloudKeys.state(version), current);
      return {
        state: current,
        stopped,
        partitions: current.pass2?.partitionsDone ?? 0,
        rows: current.totals.rowsIndexed,
        companies: 0,
        contacts: 0,
        indexObjects: current.pass2?.indexObjects ?? 0,
        indexBytes: 0,
        shardParts,
        elapsedMs: now() - startedMs,
      };
    }
    const current = (await store.getJson<CloudJobState>(cloudKeys.state(version))) ?? state;
    current.stage = "failed";
    current.updatedAt = new Date(now()).toISOString();
    current.errors = [
      ...current.errors,
      { at: current.updatedAt, stage: "pass2" as const, message: error instanceof Error ? error.message : String(error) },
    ].slice(-10);
    current.note = "Cloud Pass 2 failed. Pass 1 segments are untouched; inspect the error, fix it, and re-run.";
    await reconcileAccounting(current);
    current.accounting.budgetUsd = cloudJobBudgetUsd() ?? undefined;
    current.accounting.combinedUsd = current.accounting.estimatedUsd + current.accounting.containerUsd;
    await store.putJson(cloudKeys.state(version), current);
    throw error;
  }

  if (!result) throw new Error("Cloud Pass 2 finished without a result.");

  /* ------------------------------ completion ------------------------------ */

  const output = result.objects;
  const indexBytes = output.reduce((total, object) => total + object.bytes, 0);
  const current = (await store.getJson<CloudJobState>(cloudKeys.state(version))) ?? state;
  current.stage = result.manifest.validationPassed ? "complete" : "failed";
  current.updatedAt = new Date(now()).toISOString();
  current.finishedAt = current.updatedAt;
  current.totals.rowsIndexed = result.counters.rowsRead - result.counters.rowsRejected;
  current.rate = { rowsPerSecond: null, bytesPerSecond: null, etaSeconds: 0 };
  current.pass2 = {
    partitionsDone: config.partitions,
    partitionsTotal: config.partitions,
    shardParts,
    indexObjects: output.length,
    indexBytes,
    rowsPerSecond:
      result.counters.rowsRead > 0 && result.stages.pass2Ms > 0
        ? Math.round(result.counters.rowsRead / (result.stages.pass2Ms / 1000))
        : null,
    updatedAt: current.updatedAt,
  };
  current.note = result.manifest.validationPassed
    ? `Cloud Pass 2 complete: ${result.counters.uniqueCompanies.toLocaleString()} companies, ${result.counters.uniqueContacts.toLocaleString()} contacts. Version ${version} is built and verified but NOT activated.`
    : "Cloud Pass 2 wrote the index but validation reported problems; the version is not activatable.";
  await reconcileAccounting(current);
  current.accounting.budgetUsd = cloudJobBudgetUsd() ?? undefined;
  current.accounting.combinedUsd = current.accounting.estimatedUsd + current.accounting.containerUsd;
  await store.putJson(cloudKeys.state(version), current);
  await writeCheckpoint({
    version,
    stage: "complete",
    partitionsDone: config.partitions,
    partitionsTotal: config.partitions,
    shardParts,
    shardPartBytes: 0,
    rowsMerged: current.totals.rowsIndexed,
    updatedAt: current.updatedAt,
    mergeComplete: true,
  });

  log(
    `Cloud Pass 2 complete: ${result.counters.uniqueCompanies.toLocaleString()} companies, ` +
      `${result.counters.uniqueContacts.toLocaleString()} contacts, ${output.length} objects, ${(indexBytes / 1e9).toFixed(2)} GB`,
  );

  return {
    state: current,
    stopped,
    partitions: config.partitions,
    rows: result.counters.rowsRead,
    companies: result.counters.uniqueCompanies,
    contacts: result.counters.uniqueContacts,
    indexObjects: output.length,
    indexBytes,
    shardParts,
    elapsedMs: now() - startedMs,
  };
}

/* -------------------------------------------------------------------------- */

async function loadChunkManifests(store: BlobStore, version: string, checkpoints: SourceCheckpoint[]): Promise<Map<string, CloudChunkManifest>> {
  const out = new Map<string, CloudChunkManifest>();
  for (const checkpoint of checkpoints) {
    for (let chunk = 0; chunk < checkpoint.chunks; chunk += 1) {
      const manifest = await store.getJson<CloudChunkManifest>(cloudKeys.chunkManifest(version, checkpoint.sourceId, chunk));
      if (!manifest) throw new Error(`Missing chunk manifest for ${checkpoint.sourceId} chunk ${chunk}.`);
      out.set(`${checkpoint.sourceId}/${chunk}`, manifest);
    }
  }
  return out;
}

/**
 * Verify the posting shards a checkpoint refers to are still in R2.
 *
 * The checkpoint is only usable for a finalize-only resume if every shard part it
 * recorded is present with the recorded total count and bytes; a missing part would
 * silently turn into an empty term list and a search that quietly returns nothing.
 * A mismatch is reported (and the caller replays the merge) rather than trusted.
 */
async function verifyShardParts(store: BlobStore, version: string, expectParts: number, expectBytes: number): Promise<string[]> {
  const problems: string[] = [];
  const parts = await store.list(cloudKeys.pass2ShardRoot(version));
  if (parts.length !== expectParts) {
    problems.push(`${parts.length.toLocaleString()} posting-shard objects, expected ${expectParts.toLocaleString()}`);
  }
  const bytes = parts.reduce((total, part) => total + part.size, 0);
  if (expectBytes > 0 && bytes !== expectBytes) {
    problems.push(`${bytes.toLocaleString()} posting-shard bytes, expected ${expectBytes.toLocaleString()}`);
  }
  return problems;
}

const SCRATCH_MARKER = ".cloud-pass2-work.json";

/**
 * Refuse to treat an arbitrary directory as Cloud Pass 2 scratch.
 *
 * This driver deletes its own partition files and bookkeeping between attempts, so
 * pointing it at a real local spool (or at the configured work/output directory)
 * must fail BEFORE anything is removed. A directory is accepted only if it is empty,
 * does not exist, or carries this driver's own marker for the same version.
 */
function assertScratchDir(workDir: string, version: string, config: IndexerConfig): void {
  const samePath = (a: string, b: string) => resolve(a) === resolve(b);
  if (samePath(workDir, config.workDir) || samePath(workDir, config.outputDir)) {
    throw new Error(
      `Refusing to use ${workDir} as Cloud Pass 2 scratch: it is the configured work/output directory. ` +
        "Choose an empty temporary directory; nothing was deleted.",
    );
  }
  if (!existsSync(workDir)) return;
  const entries = readdirSync(workDir);
  if (!entries.length) return;
  const markerPath = join(workDir, SCRATCH_MARKER);
  if (!existsSync(markerPath)) {
    throw new Error(
      `Refusing to use ${workDir}: it is not empty and has no ${SCRATCH_MARKER} marker, so it is not a ` +
        "Cloud Pass 2 scratch directory. Nothing was deleted. Use an empty directory (or the one this " +
        "driver created) — never a Pass 1 spool.",
    );
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { version?: string };
  if (marker.version !== version) {
    throw new Error(
      `Refusing to use ${workDir}: its marker belongs to ${marker.version ?? "another job"}, not ${version}. ` +
        "Nothing was deleted.",
    );
  }
}

/** Clear only this driver's own scratch directories; never touches a source spool. */
function prepareWorkDir(workDir: string, version: string): void {
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
  for (const name of ["spool", "shards", "out"]) {
    rmSync(join(workDir, name), { recursive: true, force: true });
  }
  for (const name of ["checkpoint.json", "spool-manifest.json"]) rmSync(join(workDir, name), { force: true });
  mkdirSync(join(workDir, "spool"), { recursive: true });
  mkdirSync(join(workDir, "out"), { recursive: true });
  writeJsonSync(join(workDir, SCRATCH_MARKER), { version, createdAt: new Date().toISOString() });
}

function writeJsonSync(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

interface StoreCounters {
  classA: number;
  classB: number;
  bytesRead: number;
  bytesWritten: number;
}

function countersOf(store: BlobStore): StoreCounters | null {
  const holder = store as unknown as { countersSnapshot?: () => StoreCounters; ops?: StoreCounters };
  if (typeof holder.countersSnapshot === "function") return holder.countersSnapshot();
  if (holder.ops) return { ...holder.ops };
  return null;
}

async function updateAccounting(store: BlobStore, state: CloudJobState, before: StoreCounters | null, seconds = 0): Promise<void> {
  const after = countersOf(store);
  if (before && after) {
    state.accounting.classA += Math.max(0, after.classA - before.classA);
    state.accounting.classB += Math.max(0, after.classB - before.classB);
    state.accounting.bytesRead += Math.max(0, after.bytesRead - before.bytesRead);
    state.accounting.bytesWritten += Math.max(0, after.bytesWritten - before.bytesWritten);
  }
  // Container time is cumulative across attempts: a paused and resumed job still
  // bills every second it ran.
  state.accounting.containerSeconds += Math.max(0, seconds);
  state.accounting.containerUsd =
    state.accounting.containerSeconds *
    (CONTAINER_PRICE.vcpu * CONTAINER_PRICE.vcpuPerSecond + CONTAINER_PRICE.gib * CONTAINER_PRICE.gibPerSecond);
  state.accounting.estimatedUsd =
    (state.accounting.classA / 1e6) * R2_PRICES.classAPerMillion + (state.accounting.classB / 1e6) * R2_PRICES.classBPerMillion;
}

