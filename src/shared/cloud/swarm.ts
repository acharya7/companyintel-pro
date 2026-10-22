/**
 * The parallel (swarm) indexing model: up to 128 Container-backed workers (64 by
 * default), one durable coordinator, and byte ranges processed in any order.
 *
 * Why this exists
 *   The original cloud job is a single sequential CLI: one container reads both
 *   sources front to back and then merges every partition. That is correct but it
 *   serialises 64 GB of parsing behind one 0.5 vCPU instance. The swarm keeps the
 *   SAME on-R2 formats — a range writes exactly the segment objects, chunk manifest
 *   and partition files that Pass 1 writes — so the existing, verified Pass 2 merge
 *   consumes swarm output unchanged, while the expensive read/parse/map work runs
 *   on independent instances.
 *
 * Why ranges need an alignment pass
 *   A range may only start where a *record* starts. A newline inside a quoted field
 *   is not a boundary, and the quote state at an arbitrary byte offset is a property
 *   of the whole prefix of the file, not of the bytes near the offset. So the plan is
 *   built in two steps:
 *
 *     1. `block` tasks scan fixed-size blocks (no CSV parsing — just quote and
 *        newline positions) and record, for each block, the first newline that would
 *        be a record boundary if the block started outside quotes, and the first one
 *        that would be a boundary if it started inside quotes;
 *     2. the coordinator prefix-XORs the per-block quote counts to learn the real
 *        state at each block start and picks the matching candidate.
 *
 *   The result is a set of offsets that are provably outside quotes, which makes the
 *   ranges disjoint and exhaustive: every record belongs to exactly one range, with
 *   no overlap and no gap (see `planSourceRanges`).
 */

/**
 * Worker identities the coordinator can operate — the hard ceiling for a workforce.
 *
 * This is the identity space, not a provisioning promise: the containers that actually
 * run are bounded by `[[containers]].max_instances` in `wrangler.toml`. The two are
 * deliberately separate so a scale-down does not have to redeploy, and so widening the
 * pool can never silently create work the platform has no capacity for.
 */
export const SWARM_WORKER_COUNT = 128;

/** Workforce used when the operator does not name one (the full-corpus target pool). */
export const SWARM_WORKER_DEFAULT = 64;

/**
 * Deterministic worker identity: `indexer-worker-00` … `indexer-worker-127`.
 *
 * The identity is the Durable Object *name*, so `idFromName` yields one distinct
 * Durable Object (and therefore one container) per id. `max_instances` alone would
 * not do that: a single DO name is a single instance.
 *
 * Two digits while the index is below 100 keeps every id the existing run already
 * uses byte-identical (`indexer-worker-07`); the third digit appears only past 99.
 */
export function swarmWorkerId(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= SWARM_WORKER_COUNT) {
    throw new Error(`worker index must be 0..${SWARM_WORKER_COUNT - 1} (got ${index})`);
  }
  return `indexer-worker-${String(index).padStart(2, "0")}`;
}

export function swarmWorkerIds(): string[] {
  return Array.from({ length: SWARM_WORKER_COUNT }, (_, index) => swarmWorkerId(index));
}

/** Worker index encoded in a worker id, or `null` when the name is not a swarm worker. */
export function swarmWorkerIndex(workerId: string): number | null {
  const match = /^indexer-worker-(\d{2,3})$/.exec(workerId);
  if (!match) return null;
  const index = Number(match[1]);
  return index >= 0 && index < SWARM_WORKER_COUNT ? index : null;
}

export const SWARM = {
  /** Source bytes per alignment block. Smaller = finer range cuts, more small reads. */
  blockBytes: 64 << 20,
  /** A range spans this many blocks (128 MiB): the chunk size Pass 1 already proves fits a container. */
  rangeBlocks: 2,
  /** Bytes fetched per R2 request while scanning or reading a range. */
  sliceBytes: 4 << 20,
  /**
   * Bytes parsed per inner step inside one range task.
   *
   * A range is an ATOMIC unit of the plan — it is written as one chunk manifest — but
   * nothing requires it to be parsed in one buffer. A range task therefore reads its
   * bytes in fixed windows of this size, spools each partition's rows to disk and only
   * then streams the per-partition segment objects. Peak heap is a property of this
   * constant, not of the range's (data-dependent) length, which is what makes an
   * unusually large range survive a 6 GiB container instead of being SIGKILLed.
   */
  rangeChunkBytes: 8 << 20,
  /**
   * A range larger than this is reported as oversized by the audit endpoint.
   *
   * It is a diagnostic, never a cap: a cut is only legal at a record boundary, so a
   * range can legitimately be bigger than `blockBytes * rangeBlocks` when the source
   * has a very long run of blocks without one.
   */
  oversizedRangeBytes: 512 << 20,
  /** Server-side spool budget for one range task (container disk is 20 GB). */
  maxRangeSpoolBytes: 8 * 1024 ** 3,
  /** Reject a single CSV record larger than this instead of buffering it to OOM. */
  maxRecordBytes: 128 * 1024 ** 2,
  /** How long a claim is exclusive before another worker may take the task over. */
  leaseMs: 15 * 60 * 1000,
  /** Poll interval while a task runs inside a container. */
  pollMs: 10 * 1000,
  /** Wake interval when the queue is empty but the run is not finished. */
  idleMs: 30 * 1000,
  /** Claims a task may fail before it is parked for an operator. */
  maxAttempts: 4,
  /**
   * Container class this swarm is sized for (`wrangler.toml` must agree).
   *
   * `standard-4`: 4 vCPU / 12 GiB / 20 GB disk. A partition merge is CPU-bound on
   * hashing and JSON serialisation and its scratch is one partition at a time, so the
   * larger class shortens the critical path without changing what is written.
   */
  instance: { type: "standard-4", vcpu: 4, gib: 12, diskGb: 20 },
} as const;

/**
 * Container price per second of *provisioned* resources.
 *
 * Same rates the single-container estimate already uses (`tools/cloud/pass1.ts`),
 * so the swarm's running estimate is comparable to the existing job's. This is an
 * estimate from published rates, never a Cloudflare billing cap.
 */
export const SWARM_CONTAINER_USD_PER_SECOND = SWARM.instance.vcpu * 0.00002 + SWARM.instance.gib * 0.0000025;

/** R2 prices used for the swarm's running estimate (Class A / Class B / storage). */
export const SWARM_R2_PRICES = {
  classAPerMillion: 4.5,
  classBPerMillion: 0.36,
  storagePerGbMonth: 0.015,
} as const;

/**
 * The operator's spending gates.
 *
 * `warn`: status reports a warning; `soft`: no new tasks are claimed (in-flight
 * ranges finish and commit); `hard`: the run pauses at the next boundary. These are
 * application guards over an estimate — not a Cloudflare billing cap.
 */
export const SWARM_BUDGET = {
  warnUsd: 40,
  softUsd: 45,
  hardUsd: 50,
} as const;

/**
 * The phase pipeline: BLOCKS → INGEST → MERGE_PARTITIONS → ASSEMBLE_SHARDS →
 * FINALIZE → COMPLETE.
 *
 * `merge` is kept for a run planned before the partition split existed: its single
 * merge task still completes, but no new run creates one.
 */
export type SwarmStage =
  | "planned"
  | "blocks"
  | "ingest"
  | "merge_partitions"
  | "assemble_shards"
  | "finalize"
  | "merge"
  | "complete"
  | "paused"
  | "aborted"
  | "failed";

export type SwarmTaskKind =
  | "block"
  | "range"
  /** One spool partition merged into its own aligned ref space. */
  | "merge_partition"
  /** One final index shard assembled from every partition's posting parts. */
  | "assemble_shard"
  /** Single-owner manifest commit over the durable partition and shard results. */
  | "finalize"
  /** Legacy: the whole merge in one container (pre-partition plans only). */
  | "merge";

/**
 * The production shard layout, mirroring `tools/indexer/indexer.config.json`.
 *
 * A Worker bundle cannot read `tools/`, so the counts the coordinator must fan out
 * are declared here — and `tests/swarm-shard-plan.test.ts` fails if this drifts from
 * the indexer configuration, so the fan-out is never an assumed total.
 */
export const SWARM_SHARDS = {
  exact: 512,
  prefix: 256,
  token: 256,
  trigram: 512,
  ids: 256,
} as const;

export type SwarmTaskState = "pending" | "leased" | "done" | "failed" | "parked";

/**
 * Why a worker was told to stop working.
 *
 * Only `idle` and `budget_soft` mean "keep the worker alive but claim nothing"; every
 * other signal means "release your lease and destroy your container". `retired` is a
 * worker id above the operator's current active count, so scaling down to four stops
 * 04…15 instead of only refusing to relaunch them.
 */
export type SwarmStopSignal = "paused" | "aborted" | "complete" | "budget" | "budget_soft" | "idle" | "retired";

/** One worker's answer to an administrative stop request. */
export interface SwarmWorkerStopResult {
  workerId: string;
  /** True when the container is not running afterwards and nothing failed silently. */
  ok: boolean;
  containerRunningBefore: boolean;
  containerDestroyed: boolean;
  /** The task the worker was holding, if any. */
  releasedTaskId: string | null;
  /** The coordinator confirmed the lease was handed back (interrupted, not failed). */
  releaseConfirmed: boolean;
  alarmCleared: boolean;
  error?: string;
}

/** The aggregate of a stop request, so a caller can show what actually happened. */
export interface SwarmStopSummary {
  requested: number;
  stopped: number;
  failed: number;
  results: SwarmWorkerStopResult[];
  error?: string;
}

/** One range task as reported by the audit endpoint (never derived from guesses). */
export interface SwarmRangeAuditEntry {
  id: string;
  sourceId: string;
  index: number;
  start: number;
  end: number;
  bytes: number;
  state: SwarmTaskState;
  attempts: number;
  baseLine?: number;
  leaseOwner?: string;
  leaseUntil?: number;
  claimedAt?: string;
  completedAt?: string;
  error?: string;
  rows?: number;
  oversized: boolean;
}

/**
 * The answer to "which ranges are still outstanding, how big are they, and why?".
 *
 * The coordinator owns the plan, so this is read from its task records — not from a
 * status estimate — which is the only way to tell a stuck lease from a range that is
 * genuinely still being read.
 */
export interface SwarmRangeAudit {
  version: string;
  sourceId: string | null;
  state: SwarmTaskState | null;
  planned: number;
  counts: Record<SwarmTaskState, number>;
  totals: {
    bytesPlanned: number;
    bytesDone: number;
    bytesOutstanding: number;
    oversized: number;
  };
  ranges: SwarmRangeAuditEntry[];
}

/** A swarm worker's own view, used by the panel and the scale controls. */
export interface SwarmWorkerSnapshot {
  workerId: string | null;
  current: { id: string; kind: string; startedAt: number } | null;
  containerRunning: boolean;
  /** Set when the worker released its task and destroyed its container. */
  held: string | null;
}

export interface SwarmSourcePlan {
  id: string;
  key: string;
  size: number;
  etag: string | null;
  /** Blocks that must be scanned before ranges for this source can be planned. */
  blocks: number;
}

export interface SwarmShards {
  exact: number;
  prefix: number;
  token: number;
  trigram: number;
  ids: number;
}

export interface SwarmPlan {
  version: string;
  createdAt: string;
  mode: "full" | "benchmark";
  partitions: number;
  blockBytes: number;
  rangeBlocks: number;
  sources: SwarmSourcePlan[];
  budgetUsd: number | null;
  /** Workers the operator authorised for this run (never more than 128). */
  workers: number;
  /**
   * Shard counts the assembly phase must cover.
   *
   * Absent on a plan created before parallel shard assembly existed; the coordinator
   * then refuses to fan out instead of guessing a count.
   */
  shards?: SwarmShards;
}

/** What a block scan found. Small enough that 1,000 of them fit in DO storage. */
export interface SwarmBlockDescriptor {
  index: number;
  start: number;
  end: number;
  bytes: number;
  /** Number of `"` characters (an escaped `""` counts as two). */
  quotes: number;
  newlines: number;
  /** End offset of the first newline outside quotes (local quote state). */
  firstFalseEnd: number | null;
  /** 1-based physical line that starts at `firstFalseEnd`, local to this block. */
  firstFalseLine: number | null;
  /** End offset of the first newline inside quotes (local quote state). */
  firstTrueEnd: number | null;
  /** 1-based physical line that starts at `firstTrueEnd`, local to this block. */
  firstTrueLine: number | null;
}

export interface SwarmTaskResult {
  rows: number;
  rejected: number;
  segments: number;
  segmentBytes: number;
  bytesRead: number;
  classA: number;
  classB: number;
  /** Free-form detail the panel can show (e.g. the merge's final object count). */
  note?: string;
}

export interface SwarmTask {
  id: string;
  kind: SwarmTaskKind;
  sourceId: string;
  /** Block, range, partition or shard ordinal; `0` for a single-owner task. */
  index: number;
  /** Absolute byte range for `range`/`block` tasks. */
  start: number;
  end: number;
  /** `range` only: physical source line of the range's first record. */
  baseLine?: number;
  /** `merge_partition` only: the ref slice this partition owns. */
  partition?: number;
  refBase?: number;
  refCapacity?: number;
  partitionRows?: number;
  /** `assemble_shard` only: which shard object this task builds. */
  shardKind?: string;
  shard?: number;
  state: SwarmTaskState;
  attempts: number;
  leaseOwner?: string;
  leaseUntil?: number;
  claimedAt?: string;
  completedAt?: string;
  result?: SwarmTaskResult;
  error?: string;
  /** Set when an operator stop handed the lease back; the task was never failed. */
  interruptedAt?: string;
  /** How many operator stops have interrupted this task (an audit trail only). */
  interruptions?: number;
  /** Why the last interruption happened ("paused by operator", "worker stopped: …"). */
  interruptReason?: string;
}

export interface SwarmWorkerState {
  id: string;
  index: number;
  lastSeen: number;
  taskId: string | null;
  taskStartedAt: number | null;
  /** Container seconds charged to this worker so far (estimate input). */
  containerSeconds: number;
  tasksCompleted: number;
  rows: number;
  lastError?: string;
}

export interface SwarmAccounting {
  containerSeconds: number;
  containerUsd: number;
  classA: number;
  classB: number;
  bytesRead: number;
  bytesWritten: number;
  r2Usd: number;
  /** Container + R2 estimate compared against `budgetUsd`. */
  estimatedUsd: number;
  budgetUsd: number | null;
  /** `ok` below $40, `warn` from $40, `soft` from $45, `hard` from $50. */
  level: "ok" | "warn" | "soft" | "hard";
}

export interface SwarmSourceProgress {
  id: string;
  size: number;
  /** Bytes covered by *completed* ranges. */
  bytesCovered: number;
  rangesTotal: number;
  rangesDone: number;
  rows: number;
  rejected: number;
  segments: number;
  segmentBytes: number;
}

export interface SwarmStatus {
  version: string;
  stage: SwarmStage;
  createdAt: string;
  updatedAt: string;
  mode: "full" | "benchmark";
  partitions: number;
  workersAuthorised: number;
  workersActive: number;
  tasks: {
    blocksPending: number;
    blocksDone: number;
    rangesPending: number;
    rangesDone: number;
    /** Parallel merge tasks of the current run. */
    partitionsTotal?: number;
    partitionsDone?: number;
    /** Shard assembly tasks of the current run. */
    shardsTotal?: number;
    shardsDone?: number;
    failed: number;
    parked: number;
  };
  sources: SwarmSourceProgress[];
  totals: {
    rows: number;
    rejected: number;
    segments: number;
    segmentBytes: number;
    bytesCovered: number;
    bytesTotal: number;
    coveragePercent: number;
  };
  rate: {
    /** Rows per second of wall clock, measured over completed range tasks. */
    rowsPerSecond: number | null;
    bytesPerSecond: number | null;
    /** Rows/second incorporated into a *searchable* generation (after the merge). */
    searchableRowsPerSecond: number | null;
    etaSeconds: number | null;
  };
  accounting: SwarmAccounting;
  stopReason?: string;
  /** Present when the merge task exists: the Pass 2 stage that follows the ingest. */
  merge?: { state: SwarmTaskState; attempts: number; startedAt?: string; error?: string };
  errors: { at: string; taskId: string; message: string }[];
}

/** Prefixes the coordinator and workers share (all under the job's own root). */
export const swarmKeys = {
  plan: (version: string) => `cloud/jobs/${version}/swarm/plan.json`,
  block: (version: string, sourceId: string, index: number) =>
    `cloud/jobs/${version}/swarm/blocks/${sourceId}/${String(index).padStart(6, "0")}.json`,
  rangeResult: (version: string, sourceId: string, index: number) =>
    `cloud/jobs/${version}/swarm/ranges/${sourceId}/${String(index).padStart(6, "0")}.json`,
  status: (version: string) => `cloud/jobs/${version}/swarm/status.json`,
} as const;

/**
 * Task id, deterministic and sortable: `block:csv1:000123`, `range:csv1:000002`,
 * `merge_partition:all:000123`, `assemble_shard:exact:0007`, `finalize:all:000000`.
 *
 * The id is also how a worker finds the task's durable result object, so the kind and
 * ordinal in it are part of the contract, not just a label.
 */
export function swarmTaskId(kind: SwarmTaskKind, sourceId: string, index: number): string {
  if (kind === "merge" || kind === "finalize") return `${kind}:${sourceId}:000000`;
  return `${kind}:${sourceId}:${String(index).padStart(6, "0")}`;
}

/** Every shard-assembly task the plan requires, in the sequential finalize order. */
export function swarmShardTasks(shards: SwarmShards): { kind: string; shard: number; contact: boolean }[] {
  const tasks: { kind: string; shard: number; contact: boolean }[] = [];
  for (const kind of ["exact", "prefix", "token", "trigram", "ids"] as const) {
    for (let shard = 0; shard < shards[kind]; shard += 1) tasks.push({ kind, shard, contact: false });
  }
  for (const [kind, count] of [
    ["contactToken", shards.token],
    ["contactPrefix", shards.prefix],
    ["contactTrigram", shards.trigram],
  ] as const) {
    for (let shard = 0; shard < count; shard += 1) tasks.push({ kind, shard, contact: true });
  }
  return tasks;
}

/**
 * Pick record boundaries and cut the source into disjoint ranges.
 *
 * `blocks` may arrive in any order (workers finish out of order); they are sorted
 * here. Every returned `start` (and `end`) is the end offset of a newline that the
 * prefix quote parity proves is outside quotes, so no record can span a cut:
 *
 *   - a record that ends exactly at `end` belongs to this range;
 *   - the next record starts exactly at `end`, so it belongs to the next range.
 *
 * `boundaries` always starts at 0 (the header record) and ends at `size`, which
 * covers the file exactly once.
 */
export interface SwarmRange {
  index: number;
  start: number;
  end: number;
  /** Physical source line of the first record in this range (1-based). */
  baseLine: number;
}

export function planSourceRanges(
  size: number,
  blocks: readonly SwarmBlockDescriptor[],
  options: { rangeBlocks?: number } = {},
): { boundaries: number[]; ranges: SwarmRange[] } {
  const rangeBlocks = options.rangeBlocks ?? SWARM.rangeBlocks;
  if (!Number.isInteger(rangeBlocks) || rangeBlocks < 1) throw new Error("rangeBlocks must be a positive integer");
  if (size <= 0) return { boundaries: [0, 0], ranges: [] };

  const byIndex = new Map<number, SwarmBlockDescriptor>();
  for (const block of blocks) byIndex.set(block.index, block);
  const ordered = [...byIndex.values()].sort((a, b) => a.index - b.index);
  // Every block before a cut contributes to the quote parity, so a gap makes every
  // later boundary unprovable. This is checked up front rather than guessed around.
  const lastIndex = ordered.length ? ordered[ordered.length - 1]!.index : -1;
  for (let probe = 0; probe <= lastIndex; probe += 1) {
    if (!byIndex.has(probe)) {
      throw new Error(
        `Cannot plan ranges: block ${probe} has not been scanned. Every block before a cut is needed to know the quote state.`,
      );
    }
  }

  // Global quote state at each block's start: parity of all preceding blocks.
  const parityAtStart = new Map<number, boolean>();
  /** Physical newlines before each block starts, so a cut can carry an exact line number. */
  const newlinesBefore = new Map<number, number>();
  let parity = false;
  let seenNewlines = 0;
  for (const block of ordered) {
    parityAtStart.set(block.index, parity);
    newlinesBefore.set(block.index, seenNewlines);
    seenNewlines += block.newlines;
    if (Math.abs(block.quotes) % 2 === 1) parity = !parity;
  }

  const boundaries: number[] = [0];
  const boundaryLines: number[] = [1];
  let last = 0;
  for (let blockIndex = rangeBlocks; blockIndex < ordered.length; blockIndex += rangeBlocks) {
    /*
     * A block may hold no qualifying newline (one enormous quoted field). In that
     * case the cut moves to the next block rather than guessing: a wrong offset would
     * corrupt every record after it, while a slightly uneven range costs nothing.
     */
    let chosen: number | null = null;
    let chosenLine: number | null = null;
    for (let probe = blockIndex; probe < ordered.length && chosen === null; probe += 1) {
      const block = byIndex.get(probe);
      if (!block) break;
      // Local quote state is inverted when the block starts inside a quoted field,
      // so the qualifying newline is the "true" one in exactly that case.
      const candidate = parityAtStart.get(probe) ? block.firstTrueEnd : block.firstFalseEnd;
      const line = parityAtStart.get(probe) ? block.firstTrueLine : block.firstFalseLine;
      if (candidate !== null && candidate > last && candidate < size) {
        chosen = candidate;
        chosenLine = line === null ? null : (newlinesBefore.get(probe) ?? 0) + line;
      }
    }
    if (chosen === null) break;
    boundaries.push(chosen);
    boundaryLines.push(chosenLine ?? boundaryLines[boundaryLines.length - 1]!);
    last = chosen;
  }
  boundaries.push(size);

  const ranges = boundaries.slice(0, -1).map((start, index) => ({
    index,
    start,
    end: boundaries[index + 1]!,
    baseLine: boundaryLines[index]!,
  }));
  return { boundaries, ranges };
}

/** Clamp a requested worker count to the platform ceiling (default: the target pool). */
export function clampWorkerCount(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return SWARM_WORKER_DEFAULT;
  return Math.max(1, Math.min(SWARM_WORKER_COUNT, Math.floor(requested)));
}

/**
 * Worker ids a selected workforce owns — and, by complement, the ids a scale-down
 * must stop.
 *
 * A count is a SET of identities, not a hint: "use four workers" means every id above
 * 03 is stopped, otherwise the operator would be paying for the whole pool while
 * believing four are running.
 */
export function swarmActiveWorkerIds(count: number): string[] {
  return swarmWorkerIds().slice(0, clampWorkerCount(count));
}

export function swarmRetiredWorkerIds(count: number): string[] {
  return swarmWorkerIds().slice(clampWorkerCount(count));
}

/** Price a task result's R2 operations and container time for the running estimate. */
export function swarmCost(input: {
  containerSeconds: number;
  classA: number;
  classB: number;
  bytesWritten: number;
}): { containerUsd: number; r2Usd: number; estimatedUsd: number } {
  const containerUsd = input.containerSeconds * SWARM_CONTAINER_USD_PER_SECOND;
  const r2Usd =
    (input.classA / 1_000_000) * SWARM_R2_PRICES.classAPerMillion +
    (input.classB / 1_000_000) * SWARM_R2_PRICES.classBPerMillion +
    // Storage is charged monthly; a run that lasts hours is a negligible fraction of
    // the month, but it is included so the estimate is not optimistic by design.
    (input.bytesWritten / 1e9) * SWARM_R2_PRICES.storagePerGbMonth;
  return { containerUsd, r2Usd, estimatedUsd: containerUsd + r2Usd };
}

/** The budget level for an estimate, given the operator's gates. */
export function budgetLevel(estimatedUsd: number, budgetUsd: number | null): SwarmAccounting["level"] {
  if (estimatedUsd >= SWARM_BUDGET.hardUsd) return "hard";
  if (estimatedUsd >= SWARM_BUDGET.softUsd) return "soft";
  if (estimatedUsd >= SWARM_BUDGET.warnUsd) return "warn";
  if (budgetUsd !== null && estimatedUsd >= budgetUsd) return "hard";
  return "ok";
}
