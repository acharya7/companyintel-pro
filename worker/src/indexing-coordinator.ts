/**
 * IndexingCoordinator — the durable control plane of a 16-container swarm.
 *
 * One Durable Object owns the whole plan: every block scan and every byte range is a
 * row in its storage, handed out under a lease and marked done exactly once. The
 * workers are stateless apart from the task they are holding, so the swarm survives
 * any worker being killed, restarted or redeployed mid-range.
 *
 * Why a Durable Object rather than R2 task objects
 *   The previous job architecture kept control state in R2 and that was correct for
 *   one sequential process. For 16 workers claiming tasks concurrently, R2 would need
 *   read-modify-write with conditional PUTs on every claim — hundreds of requests per
 *   minute and a lost-update bug waiting to happen. DO storage is transactional, has
 *   no per-operation request charge, and input gates serialise the read-modify-write
 *   of a claim, so two workers can never lease the same task.
 *
 * Phases
 *   blocks → ingest → merge → complete
 *
 *   `blocks` scans fixed 64 MiB blocks for quote/newline positions (cheap, parallel).
 *   Once every block of both sources is scanned, the coordinator picks record
 *   boundaries (`planSourceRanges`), creates one range task per range, and moves to
 *   `ingest`. When every range has committed, it writes the aggregate Pass 1
 *   checkpoint and state objects that the unchanged Pass 2 merge requires, then
 *   creates the merge task. Any worker may claim the merge, so it is not pinned to
 *   worker-00 and can be retried elsewhere.
 *
 * Budget
 *   Container seconds are charged from worker heartbeats (a vanished worker stops
 *   accruing — no phantom cost), R2 operations from each task's own counters. At $40
 *   the status is flagged; at $45 no new task is claimed; at $50 the run pauses at the
 *   next boundary. This is an application guard over an estimate, never a Cloudflare
 *   billing cap.
 */

import {
  SWARM,
  SWARM_BUDGET,
  budgetLevel,
  planSourceRanges,
  swarmCost,
  swarmShardTasks,
  swarmTaskId,
  type SwarmAccounting,
  type SwarmBlockDescriptor,
  type SwarmPlan,
  type SwarmRange,
  type SwarmSourceProgress,
  type SwarmStage,
  type SwarmStatus,
  type SwarmTask,
  type SwarmTaskKind,
  type SwarmTaskResult,
  type SwarmWorkerState,
} from "../../src/shared/cloud/swarm";
import { planRefBases, type RefAllocation } from "../../src/shared/cloud/ref-space";

export interface CoordinatorEnv {
  COMPANY_DATA: R2Bucket;
}

interface Counters {
  blocksTotal: number;
  blocksDone: number;
  rangesTotal: number;
  rangesDone: number;
  /** Parallel merge tasks (one per spool partition) of the current run. */
  mergesTotal: number;
  mergesDone: number;
  /** Shard-assembly tasks of the current run. */
  shardsTotal: number;
  shardsDone: number;
  failed: number;
  parked: number;
}

interface Accounting {
  containerSeconds: number;
  classA: number;
  classB: number;
  bytesRead: number;
  bytesWritten: number;
}

interface SourceProgress {
  rangesDone: number;
  rows: number;
  rejected: number;
  segments: number;
  segmentBytes: number;
  bytesCovered: number;
}

const KEYS = {
  plan: "plan",
  stage: "stage",
  counters: "counters",
  accounting: "accounting",
  workers: "workers",
  perSource: "perSource",
  ranges: (sourceId: string) => `ranges:${sourceId}`,
  queue: (kind: SwarmTaskKind) => `q:${kind}`,
  allocation: "allocation",
  task: (id: string) => `t:${id}`,
  block: (sourceId: string, index: number) => `blk:${sourceId}:${String(index).padStart(6, "0")}`,
  errors: "errors",
  stopReason: "stopReason",
  ingestDoneAt: "ingestDoneAt",
  windowStart: "windowStart",
  rowsAtWindowStart: "rowsAtWindowStart",
  searchable: "searchable",
} as const;

export class IndexingCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CoordinatorEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /plan":
          return json(await this.plan((await readBody(request)) as unknown as SwarmPlan));
        case "POST /claim":
          return json(await this.claim(await readBody(request)));
        case "POST /heartbeat":
          return json(await this.heartbeat(await readBody(request)));
        case "POST /complete":
          return json(await this.complete(await readBody(request)));
        case "POST /fail":
          return json(await this.fail(await readBody(request)));
        case "POST /pause":
          return json(await this.control("paused", "paused by operator"));
        case "POST /resume":
          return json(await this.resume());
        case "POST /abort":
          return json(await this.control("aborted", "aborted by operator"));
        case "GET /status":
          return json(await this.status());
        default:
          return json({ error: { code: "not_found", message: `No coordinator route for ${request.method} ${url.pathname}` } }, 404);
      }
    } catch (error) {
      return json({ error: { code: "coordinator_error", message: error instanceof Error ? error.message : String(error) } }, 500);
    }
  }

  /* ------------------------------- lifecycle ------------------------------- */

  private async plan(plan: SwarmPlan): Promise<{ plan: SwarmPlan; created: boolean; status: SwarmStatus }> {
    const existing = await this.state.storage.get<SwarmPlan>(KEYS.plan);
    if (existing) {
      if (existing.version !== plan.version) {
        throw new Error(`This coordinator already owns ${existing.version}; a coordinator is per version.`);
      }
      return { plan: existing, created: false, status: await this.status() };
    }
    if (!plan.sources.length) throw new Error("A swarm plan needs at least one source.");

    await this.state.storage.put(KEYS.plan, plan);
    await this.state.storage.put(KEYS.stage, "blocks" satisfies SwarmStage);
    await this.state.storage.put(KEYS.perSource, Object.fromEntries(plan.sources.map((source) => [source.id, emptyProgress()])));
    await this.state.storage.put(KEYS.counters, {
      blocksTotal: plan.sources.reduce((total, source) => total + source.blocks, 0),
      blocksDone: 0,
      rangesTotal: 0,
      rangesDone: 0,
      mergesTotal: 0,
      mergesDone: 0,
      shardsTotal: 0,
      shardsDone: 0,
      failed: 0,
      parked: 0,
    } satisfies Counters);
    await this.state.storage.put(KEYS.accounting, { containerSeconds: 0, classA: 0, classB: 0, bytesRead: 0, bytesWritten: 0 } satisfies Accounting);
    await this.state.storage.put(KEYS.workers, {});
    await this.state.storage.put(KEYS.errors, []);
    await this.state.storage.put(KEYS.windowStart, Date.now());
    await this.state.storage.put(KEYS.rowsAtWindowStart, 0);

    const queue: string[] = [];
    for (const source of plan.sources) {
      for (let index = 0; index < source.blocks; index += 1) {
        const id = swarmTaskId("block", source.id, index);
        const task: SwarmTask = {
          id,
          kind: "block",
          sourceId: source.id,
          index,
          start: index * plan.blockBytes,
          end: Math.min(source.size, (index + 1) * plan.blockBytes),
          state: "pending",
          attempts: 0,
        };
        await this.state.storage.put(KEYS.task(id), task);
        queue.push(id);
      }
    }
    await this.state.storage.put(KEYS.queue("block"), queue);
    return { plan, created: true, status: await this.status() };
  }

  /* --------------------------------- claims -------------------------------- */

  private async claim(body: { workerId?: string }): Promise<unknown> {
    const workerId = requireWorkerId(body.workerId);
    const plan = await this.requirePlan();
    // A task whose lease expired belongs back in the queue before anything is handed
    // out: otherwise a worker that died mid-range would strand that range forever.
    await this.reclaimExpired();
    const stage = (await this.state.storage.get<SwarmStage>(KEYS.stage)) ?? "planned";
    const stop = await this.stopFor(stage, plan);
    if (stop) {
      await this.touchWorker(workerId, null);
      return { task: null, stage, stop };
    }

    const kind = kindForStage(stage);
    let task = await this.takePending(kind, workerId);
    if (!task) {
      // The queue is empty: the phase may have completed. Advance and try once more.
      const advanced = await this.advance(plan, stage);
      if (advanced) {
        const nextStage = (await this.state.storage.get<SwarmStage>(KEYS.stage)) ?? stage;
        const nextStop = await this.stopFor(nextStage, plan);
        if (nextStop) return { task: null, stage: nextStage, stop: nextStop };
        task = await this.takePending(kindForStage(nextStage), workerId);
      }
    }
    if (!task) {
      await this.touchWorker(workerId, null);
      const current = (await this.state.storage.get<SwarmStage>(KEYS.stage)) ?? stage;
      return { task: null, stage: current, stop: current === "complete" ? "complete" : "idle" };
    }
    // The task's own identity plus the plan fields a container needs to build its
    // command — so a worker never has to read the plan from R2 to start work.
    return {
      task,
      stage,
      leaseMs: SWARM.leaseMs,
      plan: { version: plan.version, partitions: plan.partitions, blockBytes: plan.blockBytes },
    };
  }

  /** Pop the next pending id for a kind, lease it, and return the task. */
  private async takePending(kind: SwarmTaskKind, workerId: string): Promise<SwarmTask | null> {
    const queueKey = KEYS.queue(kind);
    const queue = (await this.state.storage.get<string[]>(queueKey)) ?? [];
    while (queue.length) {
      const id = queue.shift()!;
      const task = await this.state.storage.get<SwarmTask>(KEYS.task(id));
      await this.state.storage.put(queueKey, queue);
      if (!task || task.state === "done" || task.state === "parked" || task.state === "failed") continue;
      const now = Date.now();
      const leased: SwarmTask = {
        ...task,
        state: "leased",
        attempts: task.attempts + 1,
        leaseOwner: workerId,
        leaseUntil: now + SWARM.leaseMs,
        claimedAt: new Date(now).toISOString(),
      };
      await this.state.storage.put(KEYS.task(id), leased);
      await this.touchWorker(workerId, id);
      return leased;
    }
    return null;
  }

  /**
   * Reset a lease that has expired.
   *
   * Called by a heartbeat from any worker; the owner is not required to be the one
   * that took it. A worker that died mid-range leaves a `leased` task behind, and
   * this is what returns it to the queue instead of stranding it.
   */
  private async reclaimExpired(): Promise<number> {
    const workers = (await this.state.storage.get<Record<string, SwarmWorkerState>>(KEYS.workers)) ?? {};
    const now = Date.now();
    let reclaimed = 0;
    for (const worker of Object.values(workers)) {
      if (!worker.taskId) continue;
      const task = await this.state.storage.get<SwarmTask>(KEYS.task(worker.taskId));
      if (!task || task.state !== "leased") continue;
      if ((task.leaseUntil ?? 0) > now) continue;
      const parked = task.attempts >= SWARM.maxAttempts;
      await this.state.storage.put(KEYS.task(task.id), {
        ...task,
        state: parked ? "parked" : "pending",
        leaseOwner: undefined,
        leaseUntil: undefined,
        error: parked ? `lease expired ${task.attempts} time(s)` : task.error,
      } satisfies SwarmTask);
      if (!parked) {
        const queueKey = KEYS.queue(task.kind);
        const queue = (await this.state.storage.get<string[]>(queueKey)) ?? [];
        queue.unshift(task.id);
        await this.state.storage.put(queueKey, queue);
      } else {
        await this.bumpCounter("parked");
      }
      await this.touchWorker(worker.id, null);
      reclaimed += 1;
    }
    return reclaimed;
  }

  /* --------------------------------- phase --------------------------------- */

  /**
   * Move to the next phase when the current one is complete.
   *
   * Returns true when the stage changed. `blocks` completion is where the alignment
   * decision is made: every block's quote parity is prefix-summed and the record
   * boundaries are chosen here, once, so ranges are deterministic.
   */
  private async advance(plan: SwarmPlan, stage: SwarmStage): Promise<boolean> {
    const counters = await this.counters();
    if (stage === "blocks") {
      const queue = (await this.state.storage.get<string[]>(KEYS.queue("block"))) ?? [];
      if (queue.length || counters.blocksDone < counters.blocksTotal) return false;

      const totalRanges: string[] = [];
      const counts: Record<string, SourceProgress> = (await this.state.storage.get(KEYS.perSource)) ?? {};
      for (const source of plan.sources) {
        const descriptors = await this.blockDescriptors(source.id, source.blocks);
        const { ranges } = planSourceRanges(source.size, descriptors, { rangeBlocks: plan.rangeBlocks });
        await this.state.storage.put(KEYS.ranges(source.id), ranges);
        for (const range of ranges) {
          const id = swarmTaskId("range", source.id, range.index);
          const task: SwarmTask = {
            id,
            kind: "range",
            sourceId: source.id,
            index: range.index,
            start: range.start,
            end: range.end,
            baseLine: range.baseLine,
            state: "pending",
            attempts: 0,
          };
          await this.state.storage.put(KEYS.task(id), task);
          totalRanges.push(id);
        }
        counts[source.id] = { ...(counts[source.id] ?? emptyProgress()) };
      }
      await this.state.storage.put(KEYS.perSource, counts);
      await this.state.storage.put(KEYS.queue("range"), totalRanges);
      await this.state.storage.put(KEYS.counters, { ...counters, rangesTotal: totalRanges.length });
      await this.state.storage.put(KEYS.stage, "ingest" satisfies SwarmStage);
      return true;
    }

    if (stage === "ingest") {
      const queue = (await this.state.storage.get<string[]>(KEYS.queue("range"))) ?? [];
      if (queue.length || counters.rangesDone < counters.rangesTotal) return false;
      await this.publishPass1(plan);
      /*
       * MERGE_PARTITIONS: one task per spool partition, each with its own aligned ref
       * slice. The allocation is computed ONCE here from the Pass 1 chunk manifests
       * (each partition's real row count), so every task re-derives the same base and
       * no two can write the same ref — or the same object.
       */
      const rowsByPartition = await this.partitionRows(plan);
      const allocation = planRefBases(rowsByPartition);
      await this.state.storage.put(KEYS.allocation, { rowsByPartition, ...allocation });
      const ids: string[] = [];
      for (let partition = 0; partition < plan.partitions; partition += 1) {
        const id = swarmTaskId("merge_partition", "all", partition);
        await this.state.storage.put(KEYS.task(id), {
          id,
          kind: "merge_partition",
          sourceId: "all",
          index: partition,
          start: 0,
          end: 0,
          partition,
          refBase: allocation.bases[partition]!,
          refCapacity: allocation.capacities[partition]!,
          partitionRows: rowsByPartition[partition] ?? 0,
          state: "pending",
          attempts: 0,
        } satisfies SwarmTask);
        ids.push(id);
      }
      await this.state.storage.put(KEYS.queue("merge_partition"), ids);
      await this.state.storage.put(KEYS.counters, { ...counters, mergesTotal: ids.length });
      await this.state.storage.put(KEYS.ingestDoneAt, Date.now());
      await this.state.storage.put(KEYS.stage, "merge_partitions" satisfies SwarmStage);
      return true;
    }

    if (stage === "merge_partitions") {
      const queue = (await this.state.storage.get<string[]>(KEYS.queue("merge_partition"))) ?? [];
      if (queue.length || counters.mergesDone < counters.mergesTotal) return false;
      /*
       * ASSEMBLE_SHARDS: one task per (kind, shard). The list comes from the plan's
       * shard counts, never an assumed total, and every task writes exactly one final
       * index object — the whole reason the merge tasks were forbidden from writing
       * any.
       */
      const shards = plan.shards;
      if (!shards) {
        throw new Error(
          "This plan has no shard counts, so shard assembly cannot be fanned out. Re-plan the run with a shard layout.",
        );
      }
      const tasks = swarmShardTasks(shards);
      const ids: string[] = [];
      for (const task of tasks) {
        const id = swarmTaskId("assemble_shard", task.kind, task.shard);
        await this.state.storage.put(KEYS.task(id), {
          id,
          kind: "assemble_shard",
          sourceId: task.kind,
          index: task.shard,
          start: 0,
          end: 0,
          shardKind: task.kind,
          shard: task.shard,
          state: "pending",
          attempts: 0,
        } satisfies SwarmTask);
        ids.push(id);
      }
      await this.state.storage.put(KEYS.queue("assemble_shard"), ids);
      await this.state.storage.put(KEYS.counters, { ...counters, shardsTotal: ids.length });
      await this.state.storage.put(KEYS.stage, "assemble_shards" satisfies SwarmStage);
      return true;
    }

    if (stage === "assemble_shards") {
      const queue = (await this.state.storage.get<string[]>(KEYS.queue("assemble_shard"))) ?? [];
      if (queue.length || counters.shardsDone < counters.shardsTotal) return false;
      // FINALIZE: one task, because the manifest commit is a single-owner operation.
      const id = swarmTaskId("finalize", "all", 0);
      await this.state.storage.put(KEYS.task(id), {
        id,
        kind: "finalize",
        sourceId: "all",
        index: 0,
        start: 0,
        end: 0,
        state: "pending",
        attempts: 0,
      } satisfies SwarmTask);
      await this.state.storage.put(KEYS.queue("finalize"), [id]);
      await this.state.storage.put(KEYS.stage, "finalize" satisfies SwarmStage);
      return true;
    }

    if (stage === "finalize") {
      const finalizeTask = await this.state.storage.get<SwarmTask>(KEYS.task(swarmTaskId("finalize", "all", 0)));
      if (!finalizeTask || finalizeTask.state !== "done") return false;
      await this.state.storage.put(KEYS.stage, "complete" satisfies SwarmStage);
      return true;
    }

    if (stage === "merge") {
      // Legacy single-merge plan: the one task is still honoured, but no new run
      // creates it (the parallel phases above replace it).
      const queue = (await this.state.storage.get<string[]>(KEYS.queue("merge"))) ?? [];
      const mergeTask = await this.state.storage.get<SwarmTask>(KEYS.task(swarmTaskId("merge", "all", 0)));
      if (queue.length || !mergeTask || mergeTask.state !== "done") return false;
      await this.state.storage.put(KEYS.stage, "complete" satisfies SwarmStage);
      return true;
    }
    return false;
  }

  /**
   * Rows in every spool partition, from the Pass 1 chunk manifests.
   *
   * The ref allocation is derived from these counts, so it must come from what Pass 1
   * actually wrote: a guessed uniform split would under-allocate a skewed partition
   * and two tasks would then target the same objects.
   */
  private async partitionRows(plan: SwarmPlan): Promise<number[]> {
    const rows = new Array<number>(plan.partitions).fill(0);
    for (const source of plan.sources) {
      const checkpoint = await this.getR2Json<{ chunks?: number }>(`${cloudPrefix(plan.version)}/checkpoints/${source.id}.json`);
      const chunks = checkpoint?.chunks ?? 0;
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        const manifest = await this.getR2Json<{ segments?: { partition: number; rows: number }[] }>(
          `${cloudPrefix(plan.version)}/chunks/${source.id}/${String(chunk).padStart(6, "0")}.json`,
        );
        for (const segment of manifest?.segments ?? []) {
          if (segment.partition < 0 || segment.partition >= plan.partitions) continue;
          rows[segment.partition] = (rows[segment.partition] ?? 0) + segment.rows;
        }
      }
    }
    if (rows.every((count) => count === 0)) {
      /*
       * No chunk manifest was readable. Fall back to the aggregate checkpoint and give
       * every partition the whole corpus as its upper bound: that over-allocates (which
       * costs only ref numbers, never correctness) but can never under-allocate a
       * skewed partition into its neighbour's objects.
       */
      let total = 0;
      for (const source of plan.sources) {
        const checkpoint = await this.getR2Json<{ rows?: number }>(`${cloudPrefix(plan.version)}/checkpoints/${source.id}.json`);
        total += checkpoint?.rows ?? 0;
      }
      if (total === 0) {
        throw new Error(
          `Pass 1 recorded no rows in any of the ${plan.partitions} partitions, so the merge cannot be divided. ` +
            "Refusing to fan out a merge that would write nothing.",
        );
      }
      return rows.map(() => total);
    }
    return rows;
  }

  private async getR2Json<T>(key: string): Promise<T | null> {
    const object = await this.env.COMPANY_DATA.get(key);
    return object ? ((await object.json()) as T) : null;
  }

  /** The allocated ref space, for the status report and task arguments. */
  private async allocation(): Promise<(RefAllocation & { rowsByPartition: number[] }) | null> {
    return (await this.state.storage.get<RefAllocation & { rowsByPartition: number[] }>(KEYS.allocation)) ?? null;
  }

  /**
   * Write the Pass 1 completion objects the unchanged Pass 2 merge requires.
   *
   * In a swarm no single process ever sees the whole source, so the aggregate
   * checkpoint has to be assembled from the range manifests. Pass 2 refuses to merge
   * unless each checkpoint is `complete` and its `chunks` count matches the chunk
   * manifests on R2, and both of those are what this writes.
   */
  private async publishPass1(plan: SwarmPlan): Promise<void> {
    const perSource = (await this.state.storage.get<Record<string, SourceProgress>>(KEYS.perSource)) ?? {};
    const now = new Date().toISOString();
    const totals = { rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesCovered: 0 };
    for (const source of plan.sources) {
      const progress = perSource[source.id] ?? emptyProgress();
      const ranges = (await this.state.storage.get<SwarmRange[]>(KEYS.ranges(source.id))) ?? [];
      totals.rows += progress.rows;
      totals.rejected += progress.rejected;
      totals.segments += progress.segments;
      totals.segmentBytes += progress.segmentBytes;
      totals.bytesCovered += progress.bytesCovered;
      const checkpoint = {
        engine: "cloud-pass1-v1",
        version: plan.version,
        sourceId: source.id,
        sourceKey: source.key,
        sourceEtag: source.etag,
        sourceSize: source.size,
        chunkBytes: plan.blockBytes * plan.rangeBlocks,
        partitions: plan.partitions,
        nextOffset: source.size,
        nextLine: (await this.lastLine(source.id, plan.blockBytes)) + 1,
        chunks: ranges.length,
        rows: progress.rows,
        rejected: progress.rejected,
        segmentBytes: progress.segmentBytes,
        segments: progress.segments,
        complete: true,
        updatedAt: now,
      };
      await this.putR2Json(`${cloudPrefix(plan.version)}/checkpoints/${source.id}.json`, checkpoint);
    }

    const state = {
      engine: "cloud-pass1-v1",
      jobId: plan.version,
      version: plan.version,
      stage: "pass1-complete",
      startedAt: plan.createdAt,
      updatedAt: now,
      finishedAt: now,
      mode: plan.mode,
      partitions: plan.partitions,
      coverage: "full",
      sources: plan.sources.map((source) => {
        const progress = perSource[source.id] ?? emptyProgress();
        return {
          id: source.id,
          key: source.key,
          size: source.size,
          etag: source.etag,
          nextOffset: source.size,
          nextLine: 1,
          chunks: progress.rangesDone,
          rows: progress.rows,
          rejected: progress.rejected,
          sourceBytes: progress.bytesCovered,
          segments: progress.segments,
          segmentBytes: progress.segmentBytes,
          complete: true,
        };
      }),
      totals: {
        rowsRead: totals.rows + totals.rejected,
        rowsRejected: totals.rejected,
        rowsIndexed: totals.rows,
        segments: totals.segments,
        segmentBytes: totals.segmentBytes,
        sourceBytesRead: totals.bytesCovered,
      },
      rate: { rowsPerSecond: null, bytesPerSecond: null, etaSeconds: 0 },
      accounting: {
        classA: 0,
        classB: 0,
        bytesRead: 0,
        bytesWritten: 0,
        estimatedUsd: 0,
        containerSeconds: 0,
        containerUsd: 0,
      },
      checkpoint: null,
      config: {
        stage: "pass1",
        mode: plan.mode,
        partitions: plan.partitions,
        chunkMb: Math.round(((plan.blockBytes * plan.rangeBlocks) / (1024 * 1024)) * 100) / 100,
        requestedAt: plan.createdAt,
      },
      errors: [],
      note: `Swarm ingest complete: ${plan.sources.length} source(s), ${totals.rows.toLocaleString()} rows from ${totals.segments.toLocaleString()} segment(s) across 16 workers.`,
    };
    await this.putR2Json(`${cloudPrefix(plan.version)}/state.json`, state);
  }

  /** Total physical lines before EOF, from the block descriptors (for `nextLine`). */
  private async lastLine(sourceId: string, blockBytes: number): Promise<number> {
    const plan = await this.requirePlan();
    const source = plan.sources.find((entry) => entry.id === sourceId);
    if (!source) return 0;
    const keys = Array.from({ length: source.blocks }, (_, index) => KEYS.block(sourceId, index));
    let lines = 0;
    for (let offset = 0; offset < keys.length; offset += 64) {
      const batch = await this.state.storage.get<SwarmBlockDescriptor>(keys.slice(offset, offset + 64));
      for (const descriptor of batch.values()) lines += descriptor.newlines;
    }
    void blockBytes;
    return lines;
  }

  /* ------------------------------ task results ----------------------------- */

  private async complete(body: {
    workerId?: string;
    taskId?: string;
    result?: SwarmTaskResult;
    block?: SwarmBlockDescriptor;
    searchable?: { rows: number; companies?: number; contacts?: number; note?: string };
  }): Promise<unknown> {
    const workerId = requireWorkerId(body.workerId);
    if (!body.taskId) throw new Error("taskId is required");
    const task = await this.state.storage.get<SwarmTask>(KEYS.task(body.taskId));
    if (!task) throw new Error(`Unknown task ${body.taskId}`);
    if (task.state === "done") return { ok: true, duplicate: true, status: await this.status() };

    const result = body.result ?? { rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesRead: 0, classA: 0, classB: 0 };
    const now = Date.now();
    await this.state.storage.put(KEYS.task(task.id), {
      ...task,
      state: "done",
      leaseOwner: undefined,
      leaseUntil: undefined,
      completedAt: new Date(now).toISOString(),
      result,
    } satisfies SwarmTask);

    const counters = await this.counters();
    if (task.kind === "block") {
      if (body.block) await this.state.storage.put(KEYS.block(task.sourceId, task.index), body.block);
      await this.state.storage.put(KEYS.counters, { ...counters, blocksDone: counters.blocksDone + 1 });
    } else if (task.kind === "range") {
      const perSource = (await this.state.storage.get<Record<string, SourceProgress>>(KEYS.perSource)) ?? {};
      const current = perSource[task.sourceId] ?? emptyProgress();
      perSource[task.sourceId] = {
        rangesDone: current.rangesDone + 1,
        rows: current.rows + result.rows,
        rejected: current.rejected + result.rejected,
        segments: current.segments + result.segments,
        segmentBytes: current.segmentBytes + result.segmentBytes,
        bytesCovered: current.bytesCovered + (task.end - task.start),
      };
      await this.state.storage.put(KEYS.perSource, perSource);
      await this.state.storage.put(KEYS.counters, { ...counters, rangesDone: counters.rangesDone + 1 });
    } else if (task.kind === "merge_partition") {
      await this.state.storage.put(KEYS.counters, { ...counters, mergesDone: counters.mergesDone + 1 });
    } else if (task.kind === "assemble_shard") {
      await this.state.storage.put(KEYS.counters, { ...counters, shardsDone: counters.shardsDone + 1 });
    } else {
      // A single-owner task: the merge (legacy) or the finalize commit. `searchable`
      // is only set by the finalize, so a planned-but-unvalidated version can never
      // be reported as searchable.
      if (body.searchable) {
        await this.state.storage.put(KEYS.searchable, { ...body.searchable, at: new Date(now).toISOString() });
      }
    }

    await this.addAccounting(result);
    await this.setWorker(workerId, (worker) => ({
      ...worker,
      taskId: null,
      taskStartedAt: null,
      tasksCompleted: worker.tasksCompleted + 1,
      rows: worker.rows + result.rows,
      lastSeen: now,
    }));
    const advanced = await this.advance(await this.requirePlan(), (await this.state.storage.get<SwarmStage>(KEYS.stage)) ?? "blocks");
    return { ok: true, advanced, status: await this.status() };
  }

  private async fail(body: { workerId?: string; taskId?: string; error?: string }): Promise<unknown> {
    const workerId = requireWorkerId(body.workerId);
    if (!body.taskId) throw new Error("taskId is required");
    const task = await this.state.storage.get<SwarmTask>(KEYS.task(body.taskId));
    if (!task) throw new Error(`Unknown task ${body.taskId}`);
    const message = (body.error ?? "unknown failure").slice(0, 500);
    const parked = task.attempts >= SWARM.maxAttempts;
    await this.state.storage.put(
      KEYS.task(task.id),
      { ...task, state: parked ? "parked" : "pending", leaseOwner: undefined, leaseUntil: undefined, error: message } satisfies SwarmTask,
    );
    if (!parked) {
      const queueKey = KEYS.queue(task.kind);
      const queue = (await this.state.storage.get<string[]>(queueKey)) ?? [];
      queue.unshift(task.id);
      await this.state.storage.put(queueKey, queue);
    }
    const counters = await this.counters();
    await this.state.storage.put(KEYS.counters, {
      ...counters,
      failed: counters.failed + 1,
      parked: counters.parked + (parked ? 1 : 0),
    });
    const errors = (await this.state.storage.get<{ at: string; taskId: string; message: string }[]>(KEYS.errors)) ?? [];
    await this.state.storage.put(KEYS.errors, [...errors, { at: new Date().toISOString(), taskId: task.id, message }].slice(-10));
    await this.setWorker(workerId, (worker) => ({ ...worker, taskId: null, taskStartedAt: null, lastSeen: Date.now(), lastError: message }));
    return { ok: true, parked, status: await this.status() };
  }

  private async heartbeat(body: { workerId?: string }): Promise<unknown> {
    const workerId = requireWorkerId(body.workerId);
    await this.reclaimExpired();
    const workers = (await this.state.storage.get<Record<string, SwarmWorkerState>>(KEYS.workers)) ?? {};
    const worker = workers[workerId];
    const now = Date.now();
    if (worker?.taskId) {
      const task = await this.state.storage.get<SwarmTask>(KEYS.task(worker.taskId));
      if (task && task.state === "leased") {
        await this.state.storage.put(KEYS.task(task.id), { ...task, leaseUntil: now + SWARM.leaseMs } satisfies SwarmTask);
      }
    }
    await this.touchWorker(workerId, worker?.taskId ?? null);
    const stage = (await this.state.storage.get<SwarmStage>(KEYS.stage)) ?? "planned";
    const stop = await this.stopFor(stage, await this.requirePlan());
    return { ok: true, stage, stop };
  }

  private async control(stage: SwarmStage, reason: string): Promise<SwarmStatus> {
    await this.state.storage.put(KEYS.stage, stage);
    await this.state.storage.put(KEYS.stopReason, reason);
    return this.status();
  }

  private async resume(): Promise<SwarmStatus> {
    const counters = await this.counters();
    // A paused run resumes in the phase its queues describe, never by replaying a
    // phase whose tasks are already committed.
    const stage: SwarmStage =
      counters.blocksDone < counters.blocksTotal
        ? "blocks"
        : counters.rangesTotal && counters.rangesDone < counters.rangesTotal
          ? "ingest"
          : counters.mergesTotal && counters.mergesDone < counters.mergesTotal
            ? "merge_partitions"
            : counters.shardsTotal && counters.shardsDone < counters.shardsTotal
              ? "assemble_shards"
              : "finalize";
    await this.state.storage.put(KEYS.stage, stage);
    await this.state.storage.delete(KEYS.stopReason);
    return this.status();
  }

  /* -------------------------------- budgets -------------------------------- */

  private async accounting(plan: SwarmPlan): Promise<SwarmAccounting> {
    const raw = (await this.state.storage.get<Accounting>(KEYS.accounting)) ?? {
      containerSeconds: 0,
      classA: 0,
      classB: 0,
      bytesRead: 0,
      bytesWritten: 0,
    };
    // Container seconds since the last charge are added here so a status read is
    // never stale by more than one heartbeat.
    const cost = swarmCost({
      containerSeconds: raw.containerSeconds,
      classA: raw.classA,
      classB: raw.classB,
      bytesWritten: raw.bytesWritten,
    });
    return {
      containerSeconds: Math.round(raw.containerSeconds),
      containerUsd: round(cost.containerUsd),
      classA: raw.classA,
      classB: raw.classB,
      bytesRead: raw.bytesRead,
      bytesWritten: raw.bytesWritten,
      r2Usd: round(cost.r2Usd),
      estimatedUsd: round(cost.estimatedUsd),
      budgetUsd: plan.budgetUsd,
      level: budgetLevel(cost.estimatedUsd, plan.budgetUsd),
    };
  }

  /** The stop signal a caller should honour, or null when work may proceed. */
  private async stopFor(stage: SwarmStage, plan: SwarmPlan): Promise<string | null> {
    if (stage === "paused" || stage === "aborted" || stage === "complete" || stage === "failed") return stage;
    const level = (await this.accounting(plan)).level;
    if (level === "hard") {
      await this.state.storage.put(KEYS.stage, "paused" satisfies SwarmStage);
      await this.state.storage.put(
        KEYS.stopReason,
        `budget gate: estimated $${(await this.accounting(plan)).estimatedUsd.toFixed(2)} reached the $${SWARM_BUDGET.hardUsd} pause threshold`,
      );
      return "budget";
    }
    if (level === "soft") return "budget_soft";
    return null;
  }

  private async addAccounting(result: SwarmTaskResult): Promise<void> {
    const accounting = (await this.state.storage.get<Accounting>(KEYS.accounting)) ?? {
      containerSeconds: 0,
      classA: 0,
      classB: 0,
      bytesRead: 0,
      bytesWritten: 0,
    };
    // Container seconds are accrued by `touchWorker` (which banks the interval since
    // the worker was last seen). Charging the task's own duration here as well would
    // double-count every range.
    await this.state.storage.put(KEYS.accounting, {
      containerSeconds: accounting.containerSeconds,
      classA: accounting.classA + result.classA,
      classB: accounting.classB + result.classB,
      bytesRead: accounting.bytesRead + result.bytesRead,
      bytesWritten: accounting.bytesWritten + result.segmentBytes,
    } satisfies Accounting);
  }

  /* --------------------------------- status -------------------------------- */

  private async status(): Promise<SwarmStatus> {
    const plan = await this.requirePlan();
    const stage = (await this.state.storage.get<SwarmStage>(KEYS.stage)) ?? "planned";
    const counters = await this.counters();
    const perSource = (await this.state.storage.get<Record<string, SourceProgress>>(KEYS.perSource)) ?? {};
    const workers = (await this.state.storage.get<Record<string, SwarmWorkerState>>(KEYS.workers)) ?? {};
    const accounting = await this.accounting(plan);
    const stopReason = await this.state.storage.get<string>(KEYS.stopReason);
    const errors = (await this.state.storage.get<{ at: string; taskId: string; message: string }[]>(KEYS.errors)) ?? [];
    const mergeTask = await this.state.storage.get<SwarmTask>(KEYS.task(swarmTaskId("merge", "all", 0)));
    const searchable = await this.state.storage.get<{ rows: number; at: string }>(KEYS.searchable);
    const ingestDoneAt = await this.state.storage.get<number>(KEYS.ingestDoneAt);

    const sources: SwarmSourceProgress[] = [];
    for (const source of plan.sources) {
      const progress = perSource[source.id] ?? emptyProgress();
      // Range tasks exist only after the `blocks` phase has chosen the boundaries.
      const planned = await this.state.storage.get<SwarmRange[]>(KEYS.ranges(source.id));
      sources.push({
        id: source.id,
        size: source.size,
        bytesCovered: progress.bytesCovered,
        rangesTotal: planned?.length ?? 0,
        rangesDone: progress.rangesDone,
        rows: progress.rows,
        rejected: progress.rejected,
        segments: progress.segments,
        segmentBytes: progress.segmentBytes,
      });
    }

    const totals = sources.reduce(
      (accumulator, source) => ({
        rows: accumulator.rows + source.rows,
        rejected: accumulator.rejected + source.rejected,
        segments: accumulator.segments + source.segments,
        segmentBytes: accumulator.segmentBytes + source.segmentBytes,
        bytesCovered: accumulator.bytesCovered + source.bytesCovered,
        bytesTotal: accumulator.bytesTotal + source.size,
      }),
      { rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesCovered: 0, bytesTotal: 0 },
    );

    const now = Date.now();
    const windowStart = (await this.state.storage.get<number>(KEYS.windowStart)) ?? now;
    const seconds = Math.max(1, (now - windowStart) / 1000);
    const activeWorkers = Object.values(workers).filter((worker) => worker.taskId && now - worker.lastSeen < SWARM.leaseMs).length;
    const outstandingBytes = Math.max(0, totals.bytesTotal - totals.bytesCovered);
    const bytesPerSecond = totals.bytesCovered / seconds;

    return {
      version: plan.version,
      stage,
      createdAt: plan.createdAt,
      updatedAt: new Date(now).toISOString(),
      mode: plan.mode,
      partitions: plan.partitions,
      workersAuthorised: plan.workers,
      workersActive: activeWorkers,
      tasks: {
        blocksPending: Math.max(0, counters.blocksTotal - counters.blocksDone),
        blocksDone: counters.blocksDone,
        rangesPending: Math.max(0, counters.rangesTotal - counters.rangesDone),
        rangesDone: counters.rangesDone,
        partitionsTotal: counters.mergesTotal,
        partitionsDone: counters.mergesDone,
        shardsTotal: counters.shardsTotal,
        shardsDone: counters.shardsDone,
        failed: counters.failed,
        parked: counters.parked,
      },
      sources,
      totals: { ...totals, coveragePercent: totals.bytesTotal ? round((totals.bytesCovered / totals.bytesTotal) * 100) : 0 },
      rate: {
        rowsPerSecond: round(totals.rows / seconds),
        bytesPerSecond: round(bytesPerSecond),
        // The honest "searchable" number: rows only count once the merge has
        // published a generation, so before that this is null rather than equal to
        // the parse rate.
        searchableRowsPerSecond:
          searchable && ingestDoneAt ? round(searchable.rows / Math.max(1, (now - ingestDoneAt) / 1000)) : null,
        etaSeconds: stage === "complete" ? 0 : bytesPerSecond > 0 ? Math.round(outstandingBytes / bytesPerSecond) : null,
      },
      accounting,
      ...(stopReason ? { stopReason } : {}),
      ...(mergeTask
        ? {
            merge: {
              state: mergeTask.state,
              attempts: mergeTask.attempts,
              ...(mergeTask.claimedAt ? { startedAt: mergeTask.claimedAt } : {}),
              ...(mergeTask.error ? { error: mergeTask.error } : {}),
            },
          }
        : {}),
      errors,
    };
  }

  /* --------------------------------- helpers ------------------------------- */

  private async requirePlan(): Promise<SwarmPlan> {
    const plan = await this.state.storage.get<SwarmPlan>(KEYS.plan);
    if (!plan) throw new Error("No swarm plan. POST /plan first.");
    return plan;
  }

  private async counters(): Promise<Counters> {
    const stored = await this.state.storage.get<Partial<Counters>>(KEYS.counters);
    // Explicit defaults (rather than the stored object alone): a run planned before
    // the parallel phases existed has no merge/shard counters, and `undefined + 1`
    // would make every later progress report NaN.
    return {
      blocksTotal: stored?.blocksTotal ?? 0,
      blocksDone: stored?.blocksDone ?? 0,
      rangesTotal: stored?.rangesTotal ?? 0,
      rangesDone: stored?.rangesDone ?? 0,
      mergesTotal: stored?.mergesTotal ?? 0,
      mergesDone: stored?.mergesDone ?? 0,
      shardsTotal: stored?.shardsTotal ?? 0,
      shardsDone: stored?.shardsDone ?? 0,
      failed: stored?.failed ?? 0,
      parked: stored?.parked ?? 0,
    };
  }

  private async bumpCounter(field: keyof Counters): Promise<void> {
    const counters = await this.counters();
    await this.state.storage.put(KEYS.counters, { ...counters, [field]: counters[field] + 1 });
  }

  private async blockDescriptors(sourceId: string, count: number): Promise<SwarmBlockDescriptor[]> {
    const out: SwarmBlockDescriptor[] = [];
    const keys = Array.from({ length: count }, (_, index) => KEYS.block(sourceId, index));
    for (let offset = 0; offset < keys.length; offset += 64) {
      const batch = await this.state.storage.get<SwarmBlockDescriptor>(keys.slice(offset, offset + 64));
      for (const descriptor of batch.values()) out.push(descriptor);
    }
    return out;
  }

  /**
   * Record that a worker is alive.
   *
   * `lastSeen` is the only clock the cost estimate trusts: a worker that stops
   * heartbeating stops accruing container seconds, so a killed container is never
   * billed to the budget as if it were still running.
   */
  private async touchWorker(workerId: string, taskId: string | null): Promise<void> {
    const now = Date.now();
    const workers = (await this.state.storage.get<Record<string, SwarmWorkerState>>(KEYS.workers)) ?? {};
    const existing = workers[workerId];
    const accrued = existing?.taskStartedAt ? Math.max(0, (now - existing.lastSeen) / 1000) : 0;
    const sameTask = Boolean(taskId) && existing?.taskId === taskId;
    const next: SwarmWorkerState = {
      id: workerId,
      index: Number(workerId.slice(-2)) || 0,
      lastSeen: now,
      taskId,
      // A heartbeat for the task already held must not restart its clock.
      taskStartedAt: taskId ? (sameTask ? (existing?.taskStartedAt ?? now) : now) : null,
      containerSeconds: (existing?.containerSeconds ?? 0) + accrued,
      tasksCompleted: existing?.tasksCompleted ?? 0,
      rows: existing?.rows ?? 0,
      ...(existing?.lastError ? { lastError: existing.lastError } : {}),
    };
    // The accrued seconds are banked once here; `addAccounting` charges the task's
    // own duration so a long range is not lost when the worker dies without a
    // heartbeat.
    workers[workerId] = next;
    await this.state.storage.put(KEYS.workers, workers);
  }

  private async setWorker(workerId: string, update: (worker: SwarmWorkerState) => SwarmWorkerState): Promise<void> {
    const workers = (await this.state.storage.get<Record<string, SwarmWorkerState>>(KEYS.workers)) ?? {};
    const existing =
      workers[workerId] ??
      ({
        id: workerId,
        index: Number(workerId.slice(-2)) || 0,
        lastSeen: Date.now(),
        taskId: null,
        taskStartedAt: null,
        containerSeconds: 0,
        tasksCompleted: 0,
        rows: 0,
      } satisfies SwarmWorkerState);
    workers[workerId] = update(existing);
    await this.state.storage.put(KEYS.workers, workers);
  }

  private async putR2Json(key: string, value: unknown): Promise<void> {
    await this.env.COMPANY_DATA.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
  }
}

function emptyProgress(): SourceProgress {
  return { rangesDone: 0, rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesCovered: 0 };
}

function kindForStage(stage: SwarmStage): SwarmTaskKind {
  if (stage === "blocks") return "block";
  if (stage === "ingest") return "range";
  if (stage === "merge_partitions") return "merge_partition";
  if (stage === "assemble_shards") return "assemble_shard";
  if (stage === "finalize") return "finalize";
  if (stage === "merge") return "merge";
  return "finalize";
}

function cloudPrefix(version: string): string {
  return `cloud/jobs/${version}`;
}

function requireWorkerId(value: string | undefined): string {
  if (typeof value !== "string" || !/^indexer-worker-\d{2}$/.test(value)) {
    throw new Error("workerId must be one of indexer-worker-00 … indexer-worker-15");
  }
  return value;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") throw new Error("A JSON body is required.");
  return body as Record<string, unknown>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
