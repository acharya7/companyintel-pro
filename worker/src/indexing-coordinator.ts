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
  SWARM_WORKER_COUNT,
  SWARM_WORKER_DEFAULT,
  budgetLevel,
  planSourceRanges,
  isTransientTaskError,
  swarmBudgetCeiling,
  swarmCost,
  swarmShardTasks,
  swarmTaskId,
  swarmWorkerIndex,
  type SwarmAccounting,
  type SwarmBlockDescriptor,
  type SwarmPlan,
  type SwarmRange,
  type SwarmRangeAudit,
  type SwarmRangeAuditEntry,
  type SwarmSourceProgress,
  type SwarmStage,
  type SwarmStatus,
  type SwarmTask,
  type SwarmTaskKind,
  type SwarmTaskResult,
  type SwarmTaskState,
  type SwarmWorkerState,
} from "../../src/shared/cloud/swarm";
import { planRefBases, type RefAllocation } from "../../src/shared/cloud/ref-space";

export interface CoordinatorEnv {
  COMPANY_DATA: R2Bucket;
  /** Forwarded to every container this coordinator's workers start. */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /**
   * The authorised spend ceiling for this run (USD). The deployment sets it, so the
   * warn/soft/hard gates scale with it instead of being compiled in at $40/$45/$50.
   */
  CLOUD_JOB_BUDGET_USD?: string;
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
  /**
   * The operator's CURRENT workforce size (1…128), separate from `plan.workers`.
   *
   * The plan records what the run was authorised with; this records what is running
   * now, so scaling down is a durable decision the coordinator enforces on the next
   * claim instead of a client-side convention.
   */
  activeWorkers: "activeWorkers",
  /** When the run was paused, and how many leases the pause handed back. */
  pausedAt: "pausedAt",
  /**
   * The leases currently out, keyed by task id.
   *
   * Checking this (a handful of entries) is cheap enough to do on every claim, so an
   * expired lease is recovered BEFORE new work is handed out. The full plan scan
   * (`sweepStranded`) stays as the level-triggered fallback for leases written by the
   * previous version, which kept no such index.
   */
  leases: "leases",
} as const;

interface LeaseEntry {
  workerId: string;
  until: number;
}

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
        case "POST /release":
          return json(await this.release(await readBody(request)));
        case "POST /pause":
          return json(await this.pause(await readBody(request)));
        case "POST /resume":
          return json(await this.resume());
        case "POST /abort":
          return json(await this.control("aborted", "aborted by operator"));
        case "POST /workers":
          return json(await this.setWorkers(await readBody(request)));
        case "POST /retry-parked":
          return json(await this.retryParked(await readBody(request)));
        case "GET /diagnostics":
          // Presence only — never a value. A container that reports "credentials must be
          // set together" needs the operator to know WHICH binding is missing.
          return json({
            r2AccountId: Boolean(this.env.R2_ACCOUNT_ID),
            r2AccessKeyId: Boolean(this.env.R2_ACCESS_KEY_ID),
            r2SecretAccessKey: Boolean(this.env.R2_SECRET_ACCESS_KEY),
            r2AccessKeyIdLength: this.env.R2_ACCESS_KEY_ID?.length ?? 0,
            r2SecretAccessKeyLength: this.env.R2_SECRET_ACCESS_KEY?.length ?? 0,
            budgetUsd: this.env.CLOUD_JOB_BUDGET_USD ?? null,
          });
        case "GET /status":
          return json(await this.status());
        case "GET /ranges":
          return json(await this.rangeAudit(url));
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
    await this.state.storage.put(KEYS.activeWorkers, clampActive(plan.workers));
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
    await this.reclaimIndexed();
    const stage = (await this.state.storage.get<SwarmStage>(KEYS.stage)) ?? "planned";
    // A worker id above the operator's active workforce is RETIRED, not merely
    // unlucky: it is told to stop so "use four workers" cannot leave 04…15 running.
    const active = await this.activeWorkers(plan);
    const index = swarmWorkerIndex(workerId);
    if (index !== null && index >= active) {
      await this.touchWorker(workerId, null);
      return { task: null, stage, stop: "retired", workersAuthorised: active };
    }
    const stop = await this.stopFor(stage, plan);
    if (stop) {
      await this.touchWorker(workerId, null);
      return { task: null, stage, stop };
    }

    const kind = kindForStage(stage);
    let task = await this.takePending(kind, workerId);
    if (!task) {
      /*
       * Nothing was queued. Before concluding the phase is finished, look for tasks
       * that are leased but whose lease can no longer be renewed — the exact state a
       * coordinator is left in when a worker dies (or is destroyed) after its lease
       * was written but before it reported anything. Without this sweep such a range
       * is invisible forever: it is in no queue, and a worker record that was cleared
       * no longer names it, so the phase can neither progress nor be diagnosed.
       */
      const swept = await this.sweepStranded(kind);
      if (swept) task = await this.takePending(kind, workerId);
    }
    if (!task) {
      // The queue is empty: the phase may have completed. Advance and try once more.
      const advanced = await this.advance(plan, stage);
      if (advanced) {
        const nextStage = (await this.state.storage.get<SwarmStage>(KEYS.stage)) ?? stage;
        const nextStop = await this.stopFor(nextStage, plan);
        if (nextStop) return { task: null, stage: nextStage, stop: nextStop };
        const nextKind = kindForStage(nextStage);
        task = await this.takePending(nextKind, workerId);
        if (!task && (await this.sweepStranded(nextKind))) task = await this.takePending(nextKind, workerId);
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
      await this.setLease(id, workerId, now + SWARM.leaseMs);
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
      await this.dropLease(task.id);
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

  /* -------------------------------- leases --------------------------------- */

  private async leaseIndex(): Promise<Record<string, LeaseEntry>> {
    return (await this.state.storage.get<Record<string, LeaseEntry>>(KEYS.leases)) ?? {};
  }

  private async setLease(taskId: string, workerId: string, until: number): Promise<void> {
    const leases = await this.leaseIndex();
    leases[taskId] = { workerId, until };
    await this.state.storage.put(KEYS.leases, leases);
  }

  private async dropLease(taskId: string): Promise<void> {
    const leases = await this.leaseIndex();
    if (!(taskId in leases)) return;
    delete leases[taskId];
    await this.state.storage.put(KEYS.leases, leases);
  }

  /**
   * Requeue every indexed lease that has expired — before new work is handed out.
   *
   * The old coordinator reclaimed expired leases only through a worker record, so the
   * sequence "container disappears → the worker's next idle claim clears its taskId"
   * erased the only pointer to a live lease. The range stayed `leased` forever, absent
   * from every queue, and the run could never finish. This index is written by the
   * claim itself, so no worker bookkeeping can make a lease disappear again.
   */
  private async reclaimIndexed(): Promise<number> {
    const leases = await this.leaseIndex();
    const now = Date.now();
    let reclaimed = 0;
    for (const [taskId, lease] of Object.entries(leases)) {
      if (lease.until > now) continue;
      const task = await this.state.storage.get<SwarmTask>(KEYS.task(taskId));
      if (task && task.state === "leased") {
        const parked = task.attempts >= SWARM.maxAttempts;
        await this.state.storage.put(KEYS.task(task.id), {
          ...task,
          state: parked ? "parked" : "pending",
          leaseOwner: undefined,
          leaseUntil: undefined,
          error: parked ? `lease expired ${task.attempts} time(s)` : task.error,
        } satisfies SwarmTask);
        if (parked) await this.bumpCounter("parked");
        else await this.enqueue(task.id, task.kind);
        reclaimed += 1;
      }
      await this.dropLease(taskId);
    }
    return reclaimed;
  }

  /**
   * Hand a leased task back to its queue because an OPERATOR stopped its worker.
   *
   * This is the difference between a pause and a failure:
   *
   *   - the task is NOT counted as failed and never parked, so a stop cannot consume
   *     one of its `maxAttempts` retries;
   *   - the attempt that was in flight is given back, so a run paused and resumed
   *     repeatedly still has its full retry budget;
   *   - nothing about the plan, the counters, the committed objects or the version is
   *     touched, so the same coordinator resumes the same job.
   *
   * A range that was interrupted mid-flight is simply redone later: its `runRange`
   * writes deterministic keys and only writes its chunk manifest once it has covered
   * the whole range, so a redo overwrites its own partial output and can never be
   * counted twice.
   */
  private async releaseTask(task: SwarmTask, reason: string): Promise<boolean> {
    const now = Date.now();
    await this.dropLease(task.id);
    await this.state.storage.put(KEYS.task(task.id), {
      ...task,
      state: "pending",
      leaseOwner: undefined,
      leaseUntil: undefined,
      attempts: Math.max(0, task.attempts - 1),
      interruptedAt: new Date(now).toISOString(),
      interruptions: (task.interruptions ?? 0) + 1,
      interruptReason: reason.slice(0, 200),
    } satisfies SwarmTask);
    await this.enqueue(task.id, task.kind);
    return true;
  }

  /** Put an id at the FRONT of its queue, once. */
  private async enqueue(taskId: string, kind: SwarmTaskKind): Promise<void> {
    const queueKey = KEYS.queue(kind);
    const queue = (await this.state.storage.get<string[]>(queueKey)) ?? [];
    if (queue.includes(taskId)) return;
    queue.unshift(taskId);
    await this.state.storage.put(queueKey, queue);
  }

  /**
   * Recover every task that is leased but can no longer be renewed.
   *
   * This is the stall fix. The previous coordinator only looked for stranded tasks
   * through a worker record, so a task whose worker record had been cleared (an idle
   * claim after a container disappeared does exactly that) was in no queue, named by
   * nobody, and invisible forever — the run could never finish and no status field
   * said why. The sweep derives candidate ids from the PLAN instead, so it finds them
   * regardless of what the worker records say, and works on coordinator state written
   * by the previous version too (no migration, no reset).
   */
  private async sweepStranded(kind: SwarmTaskKind, options: { force?: boolean } = {}): Promise<number> {
    const plan = await this.requirePlan();
    const counters = await this.counters();
    if (!(await this.outstanding(kind, counters))) return 0;
    const ids = await this.taskIdsForKind(kind, plan, counters);
    const now = Date.now();
    let reclaimed = 0;
    for (let offset = 0; offset < ids.length; offset += 128) {
      const slice = ids.slice(offset, offset + 128);
      // Storage keys, not task ids: `t:<id>` is the durable key of a task record.
      const batch = await this.state.storage.get<SwarmTask>(slice.map((id) => KEYS.task(id)));
      for (const id of slice) {
        const task = batch.get(KEYS.task(id));
        if (!task || task.state !== "leased") continue;
        if (!options.force && (task.leaseUntil ?? 0) > now) continue;
        if (options.force) {
          // An operator stop is an interruption, not a failed attempt.
          await this.releaseTask(task, "released by operator");
        } else {
          await this.dropLease(task.id);
          const parked = task.attempts >= SWARM.maxAttempts;
          await this.state.storage.put(KEYS.task(task.id), {
            ...task,
            state: parked ? "parked" : "pending",
            leaseOwner: undefined,
            leaseUntil: undefined,
            error: parked ? `lease expired ${task.attempts} time(s)` : task.error,
          } satisfies SwarmTask);
          if (parked) await this.bumpCounter("parked");
          else await this.enqueue(task.id, task.kind);
        }
        reclaimed += 1;
      }
    }
    if (reclaimed) {
      const errors = (await this.state.storage.get<{ at: string; taskId: string; message: string }[]>(KEYS.errors)) ?? [];
      await this.state.storage.put(
        KEYS.errors,
        [
          ...errors,
          {
            at: new Date().toISOString(),
            taskId: `${kind}:*`,
            message: options.force
              ? `released ${reclaimed} interrupted ${kind} task(s); they will be retried, not failed`
              : `reclaimed ${reclaimed} ${kind} task(s) whose lease had expired`,
          },
        ].slice(-10),
      );
    }
    return reclaimed;
  }

  /**
   * Put PARKED tasks back on the queue, with a full retry budget.
   *
   * Parking is terminal on purpose: a task whose lease expired SWARM.maxAttempts
   * times is not retried forever. But parking must not be the last word when the
   * cause was environmental — a container that could not reach R2 fails every task it
   * claims within a second, and those tasks were never given a fair attempt. This is
   * the operator's "fix the cause, then retry the work" control: it resets attempts
   * and re-enqueues only tasks that are currently parked, so completed work is
   * untouched and nothing already in flight is claimed twice.
   */
  private async retryParked(body: {
    kind?: SwarmTaskKind;
    limit?: number;
    transientOnly?: boolean;
  }): Promise<{ kinds: SwarmTaskKind[]; requeued: number; parkedRemaining: number }> {
    const plan = await this.requirePlan();
    const counters = await this.counters();
    const all: SwarmTaskKind[] = ["block", "range", "merge_partition", "assemble_shard", "finalize", "merge"];
    const kinds = body.kind ? [body.kind] : all;
    const limit = Number.isFinite(body.limit) ? Math.max(1, Math.min(4096, Number(body.limit))) : 4096;
    let requeued = 0;
    let unparked = 0;

    for (const kind of kinds) {
      if (requeued >= limit) break;
      const ids = await this.taskIdsForKind(kind, plan, counters);
      for (let offset = 0; offset < ids.length && requeued < limit; offset += 128) {
        const slice = ids.slice(offset, offset + 128);
        const batch = await this.state.storage.get<SwarmTask>(slice.map((id) => KEYS.task(id)));
        for (const id of slice) {
          const task = batch.get(KEYS.task(id));
          if (!task || task.state !== "parked") continue;
          if (body.transientOnly && !isTransientTaskError(task.error)) continue;
          await this.state.storage.put(KEYS.task(id), {
            ...task,
            state: "pending",
            attempts: 0,
            leaseOwner: undefined,
            leaseUntil: undefined,
            error: undefined,
          } satisfies SwarmTask);
          await this.enqueue(id, kind);
          requeued += 1;
          unparked += 1;
          if (requeued >= limit) break;
        }
      }
    }

    if (unparked) {
      await this.state.storage.put(KEYS.counters, {
        ...(await this.counters()),
        parked: Math.max(0, (await this.counters()).parked - unparked),
      });
    }
    return { kinds, requeued, parkedRemaining: (await this.counters()).parked };
  }

  /** Is there anything left of this kind for the current plan? */
  private async outstanding(kind: SwarmTaskKind, counters: Counters): Promise<boolean> {
    if (kind === "block") return counters.blocksDone < counters.blocksTotal;
    if (kind === "range") return counters.rangesTotal === 0 || counters.rangesDone < counters.rangesTotal;
    if (kind === "merge_partition") return counters.mergesDone < counters.mergesTotal;
    if (kind === "assemble_shard") return counters.shardsDone < counters.shardsTotal;
    // Single-owner tasks: always worth one read.
    return true;
  }

  /** Every task id the plan says belongs to a kind — independent of any worker record. */
  private async taskIdsForKind(kind: SwarmTaskKind, plan: SwarmPlan, counters: Counters): Promise<string[]> {
    const ids: string[] = [];
    if (kind === "block") {
      for (const source of plan.sources) {
        for (let index = 0; index < source.blocks; index += 1) ids.push(swarmTaskId("block", source.id, index));
      }
      return ids;
    }
    if (kind === "range") {
      for (const source of plan.sources) {
        const ranges = (await this.state.storage.get<SwarmRange[]>(KEYS.ranges(source.id))) ?? [];
        for (const range of ranges) ids.push(swarmTaskId("range", source.id, range.index));
      }
      return ids;
    }
    if (kind === "merge_partition") {
      for (let partition = 0; partition < counters.mergesTotal; partition += 1) ids.push(swarmTaskId("merge_partition", "all", partition));
      return ids;
    }
    if (kind === "assemble_shard") {
      if (!plan.shards) return ids;
      for (const task of swarmShardTasks(plan.shards)) ids.push(swarmTaskId("assemble_shard", task.kind, task.shard));
      return ids;
    }
    if (kind === "finalize") return [swarmTaskId("finalize", "all", 0)];
    return [swarmTaskId("merge", "all", 0)];
  }

  /**
   * Pause the run AND hand back every in-flight lease.
   *
   * The old pause only set the stage. Because a worker polls its in-flight task
   * before it asks the coordinator anything, that left every container running (and
   * billing) until its range happened to end — and stopped nothing if the range never
   * ended. Pausing now releases the leases first, so the stop that follows cannot
   * fail a task, park it, or lose the work it had not committed.
   */
  private async pause(body: { by?: string; reason?: string; release?: boolean }): Promise<SwarmStatus & { released: string[] }> {
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "paused by operator";
    await this.control("paused", reason);
    const released = body.release === false ? [] : await this.releaseAll(reason);
    await this.state.storage.put(KEYS.pausedAt, {
      at: new Date().toISOString(),
      by: typeof body.by === "string" ? body.by : null,
      released: released.length,
    });
    return { ...(await this.status()), released };
  }

  /** Release every in-flight task, across every phase. */
  private async releaseAll(reason: string): Promise<string[]> {
    const plan = await this.requirePlan();
    const counters = await this.counters();
    const released: string[] = [];
    for (const kind of ["block", "range", "merge_partition", "assemble_shard", "finalize", "merge"] as const) {
      const ids = await this.taskIdsForKind(kind, plan, counters);
      for (let offset = 0; offset < ids.length; offset += 128) {
        const slice = ids.slice(offset, offset + 128);
        const batch = await this.state.storage.get<SwarmTask>(slice.map((id) => KEYS.task(id)));
        for (const id of slice) {
          const task = batch.get(KEYS.task(id));
          if (!task || task.state !== "leased") continue;
          await this.releaseTask(task, reason);
          released.push(task.id);
        }
      }
    }
    if (released.length) {
      const workers = (await this.state.storage.get<Record<string, SwarmWorkerState>>(KEYS.workers)) ?? {};
      const now = Date.now();
      for (const worker of Object.values(workers)) {
        if (!worker.taskId || !released.includes(worker.taskId)) continue;
        await this.setWorker(worker.id, (entry) => ({ ...entry, taskId: null, taskStartedAt: null, lastSeen: now }));
      }
    }
    return released;
  }

  /** Worker → coordinator: "I am stopping; take my task back, do not call it a failure". */
  private async release(body: { workerId?: string; taskId?: string; reason?: string }): Promise<unknown> {
    if (!body.taskId) throw new Error("taskId is required");
    const task = await this.state.storage.get<SwarmTask>(KEYS.task(body.taskId));
    if (!task) return { ok: false, taskId: body.taskId, reason: "unknown_task" };
    if (task.state !== "leased") {
      return { ok: true, taskId: task.id, state: task.state, requeued: false, note: "the task is no longer leased" };
    }
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "released by worker";
    await this.releaseTask(task, reason);
    if (typeof body.workerId === "string" && /^indexer-worker-\d{2}$/.test(body.workerId)) {
      await this.setWorker(body.workerId, (worker) => ({ ...worker, taskId: null, taskStartedAt: null, lastSeen: Date.now() }));
    }
    return { ok: true, taskId: task.id, state: "pending", requeued: true };
  }

  /* -------------------------------- workforce ------------------------------ */

  private async activeWorkers(plan: SwarmPlan): Promise<number> {
    const stored = await this.state.storage.get<number>(KEYS.activeWorkers);
    return clampActive(stored ?? plan.workers);
  }

  /** The operator's current workforce size. Refuses to exceed the platform ceiling. */
  private async setWorkers(body: { count?: unknown; workers?: unknown }): Promise<{ ok: boolean; workers: number; status: SwarmStatus }> {
    const requested = Number(body.count ?? body.workers);
    if (!Number.isInteger(requested) || requested < 1 || requested > SWARM_WORKER_COUNT) {
      throw new Error(`count must be an integer between 1 and ${SWARM_WORKER_COUNT}.`);
    }
    await this.state.storage.put(KEYS.activeWorkers, requested);
    return { ok: true, workers: requested, status: await this.status() };
  }

  /* -------------------------------- audit ---------------------------------- */

  /**
   * Every range task with its real byte span, state and retry count.
   *
   * This is how "14 ranges remain and they hold 15.1 GB" stops being an inference: the
   * plan's own bounds say which ranges are disproportionate, which are leased, and how
   * many attempts each has spent. It reads the durable task records and never mutates
   * anything, so it is safe to call on a paused production job.
   */
  private async rangeAudit(url: URL): Promise<SwarmRangeAudit> {
    const plan = await this.requirePlan();
    const sourceFilter = url.searchParams.get("source");
    const stateFilter = url.searchParams.get("state") as SwarmTaskState | null;
    const sources = sourceFilter ? plan.sources.filter((source) => source.id === sourceFilter) : plan.sources;
    const counts: Record<SwarmTaskState, number> = { pending: 0, leased: 0, done: 0, failed: 0, parked: 0 };
    const entries: SwarmRangeAuditEntry[] = [];
    let bytesPlanned = 0;
    let bytesDone = 0;
    let oversized = 0;
    for (const source of sources) {
      const ranges = (await this.state.storage.get<SwarmRange[]>(KEYS.ranges(source.id))) ?? [];
      for (let offset = 0; offset < ranges.length; offset += 128) {
        const slice = ranges.slice(offset, offset + 128);
        const batch = await this.state.storage.get<SwarmTask>(
          slice.map((range) => KEYS.task(swarmTaskId("range", source.id, range.index))),
        );
        for (const range of slice) {
          const id = swarmTaskId("range", source.id, range.index);
          const task = batch.get(KEYS.task(id));
          const bytes = range.end - range.start;
          const state = task?.state ?? "pending";
          counts[state] += 1;
          bytesPlanned += bytes;
          if (state === "done") bytesDone += bytes;
          const isOversized = bytes > SWARM.oversizedRangeBytes;
          if (isOversized) oversized += 1;
          if (stateFilter && state !== stateFilter) continue;
          entries.push({
            id,
            sourceId: source.id,
            index: range.index,
            start: range.start,
            end: range.end,
            bytes,
            state,
            attempts: task?.attempts ?? 0,
            baseLine: range.baseLine,
            ...(task?.leaseOwner ? { leaseOwner: task.leaseOwner } : {}),
            ...(task?.leaseUntil ? { leaseUntil: task.leaseUntil } : {}),
            ...(task?.claimedAt ? { claimedAt: task.claimedAt } : {}),
            ...(task?.completedAt ? { completedAt: task.completedAt } : {}),
            ...(task?.error ? { error: task.error } : {}),
            ...(task?.result ? { rows: task.result.rows } : {}),
            oversized: isOversized,
          });
        }
      }
    }
    entries.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.index - b.index);
    return {
      version: plan.version,
      sourceId: sourceFilter,
      state: stateFilter,
      planned: entries.length,
      counts,
      totals: { bytesPlanned, bytesDone, bytesOutstanding: Math.max(0, bytesPlanned - bytesDone), oversized },
      ranges: entries,
    };
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
    coverage?: { start: number; end: number };
    searchable?: { rows: number; companies?: number; contacts?: number; note?: string };
  }): Promise<unknown> {
    const workerId = requireWorkerId(body.workerId);
    if (!body.taskId) throw new Error("taskId is required");
    const task = await this.state.storage.get<SwarmTask>(KEYS.task(body.taskId));
    if (!task) throw new Error(`Unknown task ${body.taskId}`);
    if (task.state === "done") return { ok: true, duplicate: true, status: await this.status() };
    /*
     * A range is complete only when it covered its whole span. The worker reports the
     * manifest's real byte range, and this refuses to count anything else: a range that
     * stopped early must stay outstanding (and be redone), never become a silent gap
     * that Pass 2 merges as if the bytes had been parsed.
     */
    if (task.kind === "range" && body.coverage) {
      if (body.coverage.start !== task.start || body.coverage.end !== task.end) {
        throw new Error(
          `Range ${task.id} covered ${body.coverage.start}..${body.coverage.end}, but its task is ${task.start}..${task.end}; a partial range is not a completed range.`,
        );
      }
    }
    const result = body.result ?? { rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesRead: 0, classA: 0, classB: 0 };
    const now = Date.now();
    await this.dropLease(task.id);
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
    await this.dropLease(task.id);
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
        // The index must move with the task, or a healthy long range would look
        // abandoned to `reclaimIndexed` 15 minutes after it was claimed.
        await this.setLease(task.id, workerId, now + SWARM.leaseMs);
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
    // Requeue anything a pause (or a dead worker) left leased before the run
    // continues. Otherwise the queues would look empty while ranges are still held,
    // which is exactly the "resume produced no new work" failure this repairs.
    await this.sweepStranded("block", { force: true });
    await this.sweepStranded("range", { force: true });
    await this.sweepStranded("merge_partition", { force: true });
    await this.sweepStranded("assemble_shard", { force: true });
    await this.sweepStranded("finalize", { force: true });
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
    await this.state.storage.delete(KEYS.pausedAt);
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
    // The deployment's ceiling wins over the plan's: raising CLOUD_JOB_BUDGET_USD lifts
    // the gates of a run that was planned at a lower ceiling, without re-planning it.
    const ceiling = swarmBudgetCeiling(this.env.CLOUD_JOB_BUDGET_USD, plan.budgetUsd);
    return {
      containerSeconds: Math.round(raw.containerSeconds),
      containerUsd: round(cost.containerUsd),
      classA: raw.classA,
      classB: raw.classB,
      bytesRead: raw.bytesRead,
      bytesWritten: raw.bytesWritten,
      r2Usd: round(cost.r2Usd),
      estimatedUsd: round(cost.estimatedUsd),
      budgetUsd: ceiling,
      level: budgetLevel(cost.estimatedUsd, ceiling),
    };
  }

  /** The stop signal a caller should honour, or null when work may proceed. */
  private async stopFor(stage: SwarmStage, plan: SwarmPlan): Promise<string | null> {
    if (stage === "paused" || stage === "aborted" || stage === "complete" || stage === "failed") return stage;
    const accounting = await this.accounting(plan);
    if (accounting.level === "hard") {
      await this.state.storage.put(KEYS.stage, "paused" satisfies SwarmStage);
      await this.state.storage.put(
        KEYS.stopReason,
        `budget gate: estimated $${accounting.estimatedUsd.toFixed(2)} reached the $${(accounting.budgetUsd ?? SWARM_BUDGET.hardUsd).toFixed(0)} pause threshold`,
      );
      return "budget";
    }
    if (accounting.level === "soft") return "budget_soft";
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
      workersAuthorised: await this.activeWorkers(plan),
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

/** 1…128, with a missing/zero value falling back to the target pool (64). */
function clampActive(value: number): number {
  if (!Number.isFinite(value)) return SWARM_WORKER_DEFAULT;
  return Math.max(1, Math.min(SWARM_WORKER_COUNT, Math.floor(value) || SWARM_WORKER_DEFAULT));
}

function requireWorkerId(value: string | undefined): string {
  if (typeof value !== "string" || !/^indexer-worker-\d{2,3}$/.test(value) || swarmWorkerIndex(value) === null) {
    throw new Error(`workerId must be one of indexer-worker-00 … indexer-worker-${SWARM_WORKER_COUNT - 1}`);
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
