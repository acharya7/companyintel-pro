/**
 * Types shared by the cloud indexing engine, the Worker admin API and the
 * indexing control panel.
 *
 * The engine itself runs in a container (or in the dev server for a bounded
 * benchmark); the browser only ever sees this shape. Keeping it in `src/shared`
 * means the panel cannot drift from what the engine actually records.
 */

export const CLOUD_PREFIX = "cloud";
export const CLOUD_ENGINE_VERSION = "cloud-pass1-v1";
export const CLOUD_CONTROL_VERSION = 1;

export type CloudStage =
  | "idle"
  | "preflight"
  | "pass1"
  | "pass1-complete"
  | "assembling"
  | "pass2"
  | "verify"
  | "complete"
  | "paused"
  | "aborted"
  | "failed";

export interface CloudControl {
  version: typeof CLOUD_CONTROL_VERSION;
  /** Stop after the chunk currently being written; the checkpoint stays resumable. */
  pause: boolean;
  /** Stop and leave everything on disk/R2 untouched. */
  abort: boolean;
  /** Records that the operator approved the measured full-run forecast. */
  approvedFullRun: boolean;
  updatedAt: string;
  note?: string;
}

export interface CloudSourceState {
  id: string;
  key: string;
  size: number | null;
  etag: string | null;
  /** Next byte offset to read: always a record boundary. */
  nextOffset: number;
  /** Physical source line at `nextOffset` (1-based). */
  nextLine: number;
  chunks: number;
  rows: number;
  rejected: number;
  /** Bytes of source consumed (not spool bytes). */
  sourceBytes: number;
  segments: number;
  segmentBytes: number;
  complete: boolean;
}

export interface CloudAccounting {
  /** Class A requests (PUT/COPY/LIST). */
  classA: number;
  /** Class B requests (GET/HEAD). */
  classB: number;
  bytesRead: number;
  bytesWritten: number;
  /** Estimated R2 request + storage cost of what this job has done so far. */
  estimatedUsd: number;
  /** Container wall time and the conservative compute estimate at that time. */
  containerSeconds: number;
  containerUsd: number;
  /**
   * The one budget configured for the WHOLE job (`CLOUD_JOB_BUDGET_USD`), and the
   * combined running estimate that is compared against it. Both stages share it;
   * there is no separate Pass 1 / Pass 2 allowance. It is a guard, not a cap.
   */
  budgetUsd?: number;
  combinedUsd?: number;
}

/**
 * Why a run stopped without finishing its stage.
 *
 * Written by the CLI when it can (a thrown error) and by the container runner when a
 * process disappears without the chance to write anything (SIGTERM, SIGKILL, OOM).
 * It is part of the job state on purpose: R2 would otherwise hold a job whose latest
 * checkpoint looks like progress while nothing is running.
 */
export interface CloudInterruption {
  at: string;
  outcome: "failed" | "interrupted" | "terminated";
  reason: string;
  detail?: string;
}

/**
 * The durable execution configuration of a job.
 *
 * Written when Pass 1 starts so a resume can rebuild the exact command even if the
 * Durable Object's own job record is gone (a redeploy, a job started before the
 * keep-alive existed, or a start through the CLI). A bounded benchmark must never
 * be resumed as a full-corpus run, so the bound is part of the state, not of the
 * caller's request.
 */
export interface CloudJobConfig {
  stage: "pass1" | "pass2";
  mode: "full" | "benchmark" | "custom";
  partitions: number;
  /** Benchmark only: source bytes per source, in MiB. */
  maxSourceMb?: number;
  /** Source bytes per chunk, in MiB. A resume must reuse it (it is part of the checkpoint identity). */
  chunkMb?: number;
  requestedAt: string;
}

/**
 * The last run attempt, written to `cloud/jobs/<version>/run.json`.
 *
 * A heartbeat is the only evidence that a detached process is still alive: the
 * Worker answers 202 and the browser polls R2, so without it an interrupted job and
 * a slow chunk look identical. `outcome: "running"` plus an old `heartbeatAt` is
 * what the panel reports as "stopped without recording why".
 */
export interface CloudRunStatus {
  version: string;
  stage: "pass1" | "pass2";
  outcome: "running" | "completed" | "failed" | "interrupted" | "terminated";
  /** 1-based attempt counter; a resumed job increments it. */
  attempt: number;
  recordedBy: "cli" | "runner";
  startedAt: string;
  heartbeatAt: string;
  pid: number | null;
  exitCode?: number | null;
  signal?: string | null;
  /** Always present for failed/interrupted/terminated. */
  reason?: string;
  detail?: string;
}

export interface CloudJobState {
  engine: typeof CLOUD_ENGINE_VERSION;
  jobId: string;
  version: string;
  stage: CloudStage;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Full run vs bounded benchmark. */
  mode: "full" | "benchmark" | "custom";
  /** Partition count this job was built with; Cloud Pass 2 must use the same one. */
  partitions?: number;
  sources: CloudSourceState[];
  totals: {
    rowsRead: number;
    rowsRejected: number;
    rowsIndexed: number;
    segments: number;
    segmentBytes: number;
    sourceBytesRead: number;
  };
  rate: {
    rowsPerSecond: number | null;
    bytesPerSecond: number | null;
    etaSeconds: number | null;
  };
  accounting: CloudAccounting;
  /** Last durable checkpoint that a restart would use. */
  checkpoint: { at: string; sources: { id: string; nextOffset: number; nextLine: number }[] } | null;
  /** How Pass 1 was run; a resume rebuilds the command from this. */
  config?: CloudJobConfig;
  /** `bounded` when Pass 1 covered only a benchmark prefix, `full` when it read to EOF. */
  coverage?: "full" | "bounded";
  /** Cloud Pass 2 progress, written after every merged partition and during finalize. */
  pass2?: {
    partitionsDone: number;
    partitionsTotal: number;
    shardParts: number;
    indexObjects: number;
    indexBytes: number;
    /** Measured on this run, not estimated. */
    rowsPerSecond: number | null;
    /**
     * Which part of Pass 2 is running.
     *
     * The merge, finalize and validation phases all report `stage: "pass2"`, so the
     * phase is what tells the panel (and an operator) whether the job is merging
     * partitions, uploading the generated index, or reading it back to validate it.
     * Without it a job that has merged every partition still reads as "pass2" with
     * whatever ETA the merge last computed.
     */
    phase?: "merge" | "finalize" | "validate" | "complete";
    /** Finalize progress: generated objects (index shards + directory) written. */
    finalizeDone?: number;
    finalizeTotal?: number;
    /** Validation progress: generated objects read back from R2 and checksummed. */
    validationDone?: number;
    validationTotal?: number;
    updatedAt: string;
  };
  errors: { at: string; stage: CloudStage; message: string }[];
  /** Set whenever the last attempt failed, was interrupted by a stop, or was found dead. */
  interruption?: CloudInterruption;
  note?: string;
}

/**
 * Durable Pass 2 checkpoint.
 *
 * Written after every merged batch (`stage: "merge"`) and once more when the
 * whole merge is finished (`mergeComplete: true`). A restart in the *finalize* or
 * *validation* phase can therefore skip the merge — which is the part that costs
 * hours — and rebuild only the index shards and manifests from the parts already
 * in R2. A restart during the merge itself still replays from partition 1: the
 * document refs are assigned sequentially across partitions, so a partial replay
 * would produce a different index. That limitation is explicit, not hidden.
 */
export interface CloudPass2Checkpoint {
  version: string;
  stage: "merge" | "finalize" | "complete";
  partitionsDone: number;
  partitionsTotal: number;
  /** Posting-shard batch objects written so far (count and total bytes). */
  shardParts: number;
  shardPartBytes: number;
  rowsMerged: number;
  updatedAt: string;
  /**
   * Everything the finalize phase needs, recorded once the merge has finished.
   * Present only when `mergeComplete` is true.
   */
  mergeComplete: boolean;
  resume?: unknown;
  /**
   * Finalize/validation progress, so a restart after the merge reports what it is
   * doing and a stopped job can be told apart from one uploading its last shards.
   */
  finalize?: {
    phase: "finalize" | "validate" | "complete";
    objectsDone: number;
    objectsTotal: number;
  };
}

export interface CloudSegmentRef {
  partition: number;
  key: string;
  bytes: number;
  rows: number;
  sha256: string;
}

export interface CloudChunkManifest {
  engine: typeof CLOUD_ENGINE_VERSION;
  jobId: string;
  version: string;
  sourceId: string;
  sourceKey: string;
  sourceEtag: string | null;
  sourceSize: number;
  chunk: number;
  range: { start: number; end: number };
  /** Physical line of the chunk's first data record. */
  baseLine: number;
  rows: number;
  rejected: number;
  lines: number;
  segments: CloudSegmentRef[];
  rejectedKey: string | null;
  completedAt: string;
  complete: true;
}

/** Prefix helpers, so the engine, the Worker and the panel agree exactly. */
export const cloudKeys = {
  jobRoot: (version: string) => `${CLOUD_PREFIX}/jobs/${version}`,
  state: (version: string) => `${CLOUD_PREFIX}/jobs/${version}/state.json`,
  control: (version: string) => `${CLOUD_PREFIX}/jobs/${version}/control.json`,
  schema: (version: string) => `${CLOUD_PREFIX}/jobs/${version}/schema.json`,
  checkpoint: (version: string, sourceId: string) => `${CLOUD_PREFIX}/jobs/${version}/checkpoints/${sourceId}.json`,
  runStatus: (version: string) => `${CLOUD_PREFIX}/jobs/${version}/run.json`,
  chunkManifest: (version: string, sourceId: string, chunk: number) =>
    `${CLOUD_PREFIX}/jobs/${version}/chunks/${sourceId}/${String(chunk).padStart(6, "0")}.json`,
  segment: (version: string, sourceId: string, chunk: number, partition: number) =>
    `${CLOUD_PREFIX}/jobs/${version}/segments/${sourceId}/${String(chunk).padStart(6, "0")}/part-${String(partition).padStart(4, "0")}.jsonl.gz`,  rejected: (version: string, sourceId: string, chunk: number) => `${CLOUD_PREFIX}/jobs/${version}/rejected/${sourceId}/${String(chunk).padStart(6, "0")}.jsonl.gz`,
  pass2Checkpoint: (version: string) => `${CLOUD_PREFIX}/jobs/${version}/pass2/checkpoint.json`,
  pass2ShardRoot: (version: string) => `${CLOUD_PREFIX}/jobs/${version}/pass2/shards/`,
} as const;
