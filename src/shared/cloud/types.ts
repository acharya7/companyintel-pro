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
  errors: { at: string; stage: CloudStage; message: string }[];
  note?: string;
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
  chunkManifest: (version: string, sourceId: string, chunk: number) =>
    `${CLOUD_PREFIX}/jobs/${version}/chunks/${sourceId}/${String(chunk).padStart(6, "0")}.json`,
  segment: (version: string, sourceId: string, chunk: number, partition: number) =>
    `${CLOUD_PREFIX}/jobs/${version}/segments/${sourceId}/${String(chunk).padStart(6, "0")}/part-${String(partition).padStart(4, "0")}.jsonl.gz`,
  rejected: (version: string, sourceId: string, chunk: number) =>
    `${CLOUD_PREFIX}/jobs/${version}/rejected/${sourceId}/${String(chunk).padStart(6, "0")}.jsonl.gz`,
} as const;
