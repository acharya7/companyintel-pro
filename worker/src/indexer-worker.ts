/**
 * IndexerWorker — one Container-backed Durable Object per swarm worker.
 *
 * There are exactly 16 identities, `indexer-worker-00` … `indexer-worker-15`, created
 * with `idFromName`. That is what makes 16 containers possible: `max_instances = 16`
 * in `wrangler.toml` is only an upper bound, and a namespace addressed by ONE name
 * would still give one instance. Each identity owns its own container, its own task
 * and its own alarm, and all 16 talk to the same `IndexingCoordinator`.
 *
 * The pump
 *   1. if a task is in flight, poll the container (`GET /task`);
 *   2. on success, read the task's result object from R2 and report it to the
 *      coordinator (the coordinator keeps the durable record; the container is
 *      disposable);
 *   3. claim the next task, start it in the container, arm an alarm for the next poll.
 *      A worker therefore never idles while the queue has work.
 *
 * Shutdown
 *   When the coordinator answers `complete`, `paused`, `aborted` or `budget`, the
 *   container is destroyed and no alarm is armed: a finished or gated run must stop
 *   costing money. `idle` and `budget_soft` arm a delayed alarm instead, because more
 *   work may appear (a phase boundary, or an operator raising the budget).
 */

import { cloudKeys, type CloudChunkManifest } from "../../src/shared/cloud/types";
import {
  SWARM,
  swarmKeys,
  type SwarmBlockDescriptor,
  type SwarmTask,
  type SwarmTaskResult,
  type SwarmWorkerStopResult,
} from "../../src/shared/cloud/swarm";
import type { EnvWithContainer } from "./indexer-container";

/** The port `cloud/runner.mjs` listens on. */
const CONTAINER_PORT = 8080;
const READY_POLL_MS = 250;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
/** A pump pass stops claiming after this long so an alarm never runs unbounded. */
const PUMP_BUDGET_MS = 20_000;

/**
 * The bindings and secrets this class uses.
 *
 * The R2 S3 names live only in `env.d.ts` (declarations), exactly as they do for the
 * single-job container: a Container has no R2 binding, so the Worker forwards them on
 * `container.start({ env })` and never reads or returns a value. Declaring them again
 * here would put the secret names in a second runtime source file for no benefit.
 */
export type WorkerEnv = EnvWithContainer & { INDEXING_COORDINATOR?: DurableObjectNamespace };

interface InFlight {
  id: string;
  kind: SwarmTask["kind"];
  args: string[];
  startedAt: number;
  /** The leased task's own byte span, so a result can be checked against it. */
  start?: number;
  end?: number;
}

/** What a claim teaches the worker about the run (enough to build its CLI command). */
interface ClaimedPlan {
  version: string;
  partitions: number;
  blockBytes: number;
}

type PollOutcome = "running" | "done" | "failed" | "gone";

const KEYS = { workerId: "workerId", current: "current", plan: "plan", held: "held" } as const;

/**
 * Stop signals that mean "release your task, destroy your container, arm nothing".
 *
 * `budget_soft` is deliberately absent: it means no NEW task, while the in-flight one
 * is allowed to finish and commit.
 */
const STOP_SIGNALS = new Set<string>(["paused", "aborted", "complete", "budget", "retired"]);

export class IndexerWorker implements DurableObject {
  /** In-memory guard: a DO is single-instance, so this is enough to serialise pumps. */
  private pumping = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv,
  ) {
    void this.state.blockConcurrencyWhile(async () => {
      const current = await this.state.storage.get<InFlight>(KEYS.current);
      if (current) await this.state.storage.setAlarm(Date.now() + SWARM.pollMs);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/pump" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { workerId?: string };
        if (typeof body.workerId === "string") await this.state.storage.put(KEYS.workerId, body.workerId);
        return json(await this.pump());
      }
      if (url.pathname === "/stop" && request.method === "POST") {
        /*
         * An administrative stop. It ALWAYS hands the lease back before it destroys
         * the container, and it always reports what actually happened: the previous
         * version answered `{ ok: true }` after swallowing both the destroy failure and
         * the fact that it had just dropped a live task on the floor.
         */
        const body = (await request.json().catch(() => ({}))) as { reason?: string; workerId?: string };
        if (!(await this.state.storage.get<string>(KEYS.workerId)) && typeof body.workerId === "string") {
          await this.state.storage.put(KEYS.workerId, body.workerId);
        }
        const workerId = (await this.state.storage.get<string>(KEYS.workerId)) ?? "unknown";
        const result = await this.drain(workerId, body.reason ?? "stopped by operator");
        return json(result, result.ok ? 200 : 500);
      }
      if (url.pathname === "/state" && request.method === "GET") {
        const workerId = await this.state.storage.get<string>(KEYS.workerId);
        const current = await this.state.storage.get<InFlight>(KEYS.current);
        const held = await this.state.storage.get<string>(KEYS.held);
        const container = this.container();
        return json({
          workerId: workerId ?? null,
          current: current ?? null,
          containerRunning: container?.running ?? false,
          held: held ?? null,
        });
      }
      return json({ error: { code: "not_found", message: `No worker route for ${request.method} ${url.pathname}` } }, 404);
    } catch (error) {
      return json({ error: { code: "worker_error", message: error instanceof Error ? error.message : String(error) } }, 500);
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.pump();
    } catch {
      // A failed pump must not strand the worker: the lease expires and the task is
      // reclaimed, and the next alarm (armed here) tries again.
      await this.state.storage.setAlarm(Date.now() + SWARM.pollMs);
    }
  }

  /* ---------------------------------- pump ---------------------------------- */

  private async pump(): Promise<Record<string, unknown>> {
    if (this.pumping) return { busy: true };
    this.pumping = true;
    try {
      const workerId = await this.state.storage.get<string>(KEYS.workerId);
      if (!workerId) return { error: "This worker has no identity; POST /pump with { workerId }." };
      const startedAt = Date.now();
      const outcome: { completed?: string; failed?: string; stop?: string; started?: string } = {};

      /*
       * 0. Ask the coordinator whether work may happen AT ALL, before looking at the
       *    in-flight task.
       *
       * This is the pause bug: the old pump polled the container first, so a paused run
       * kept every container alive — and kept billing — until its range happened to
       * end, which for a range stuck in a memory-thrashing container was never. Pausing
       * now reaches the container on the next alarm (10 s), releases the lease, and
       * arms nothing.
       */
      const control = await this.controlCheck(workerId);
      if (control.stop && STOP_SIGNALS.has(control.stop)) {
        const stopped = await this.drain(workerId, control.stop);
        return { ...outcome, ...stopped, stop: control.stop, stage: control.stage ?? null };
      }
      await this.state.storage.delete(KEYS.held);

      // 1. Finish whatever is in flight before claiming anything new.
      const current = await this.state.storage.get<InFlight>(KEYS.current);
      if (current) {
        const state = await this.pollTask(current, workerId);
        if (state === "running") {
          await this.state.storage.setAlarm(Date.now() + SWARM.pollMs);
          return { running: current.id };
        }
        if (state === "gone") {
          // The container vanished (platform stop, redeploy) without committing. Hand
          // the lease back explicitly so the work returns to the queue now instead of
          // waiting out a 15-minute lease — an interruption, never a failed attempt.
          try {
            await this.coordinator("/release", { workerId, taskId: current.id, reason: "container disappeared mid-task" });
          } catch {
            // The lease expiry (and the coordinator's stranded-task sweep) is the
            // fallback; neither can lose the task.
          }
          await this.state.storage.delete(KEYS.current);
          await this.state.storage.setAlarm(Date.now() + SWARM.pollMs);
          return { containerGone: current.id };
        }
        if (state === "done") outcome.completed = current.id;
        else outcome.failed = current.id;
        await this.state.storage.delete(KEYS.current);
      }

      /*
       * 1b. A container can still be running a task this DO no longer tracks: the
       * lease was released by a pause, the record was cleared after a failed start, or
       * a redeploy dropped the in-memory `current`. Claiming a second task in that
       * state fails with "This container is already running a task" and spends one
       * attempt of the NEW task for nothing — the failure storm that parked hundreds
       * of merge tasks. The untracked work has no lease, so it can never be reported:
       * stop the container and let the coordinator requeue the task instead.
       */
      if (await this.containerHasUntrackedTask()) {
        await this.container()?.destroy().catch(() => undefined);
      }

      // 2. Claim and start as many tasks as the pump budget allows.
      while (Date.now() - startedAt < PUMP_BUDGET_MS) {
        const claim = (await this.coordinator("/claim", { workerId })) as {
          task?: SwarmTask | null;
          stop?: string;
          plan?: ClaimedPlan;
        };
        if (claim?.stop) {
          outcome.stop = claim.stop;
          // `retired` is a scale-down: this worker id is above the operator's active
          // count, so it must stop rather than idle and be mistaken for running.
          if (STOP_SIGNALS.has(claim.stop)) {
            const stopped = await this.drain(workerId, claim.stop);
            return { ...outcome, ...stopped };
          }
          await this.state.storage.setAlarm(Date.now() + SWARM.idleMs);
          return outcome;
        }
        if (!claim?.task) {
          await this.state.storage.setAlarm(Date.now() + SWARM.idleMs);
          return outcome;
        }
        if (claim.plan) await this.state.storage.put(KEYS.plan, claim.plan);
        const started = await this.startTask(claim.task, claim.plan);
        if (started.ok) {
          await this.state.storage.put(KEYS.current, {
            id: claim.task.id,
            kind: claim.task.kind,
            args: started.args,
            startedAt: Date.now(),
            start: claim.task.start,
            end: claim.task.end,
          } satisfies InFlight);
          await this.state.storage.setAlarm(Date.now() + SWARM.pollMs);
          return { ...outcome, started: claim.task.id };
        }
        await this.coordinator("/fail", { workerId, taskId: claim.task.id, error: started.error });
        outcome.failed = claim.task.id;
      }
      await this.state.storage.setAlarm(Date.now() + SWARM.pollMs);
      return { ...outcome, pumpBudgetExhausted: true };
    } finally {
      this.pumping = false;
    }
  }

  /** True when the container is busy, and this DO holds no in-flight record for it. */
  private async containerHasUntrackedTask(): Promise<boolean> {
    const container = this.container();
    if (!container || !container.running) return false;
    try {
      const response = await container.getTcpPort(CONTAINER_PORT).fetch("http://container/task");
      const status = (await response.json()) as { task?: { running?: boolean } | null };
      return status?.task?.running === true;
    } catch {
      return false;
    }
  }

  /** Ask the container how the running task is doing; report it when it ended. */
  private async pollTask(current: InFlight, workerId: string): Promise<PollOutcome> {
    const container = this.container();
    if (!container || !container.running) {
      /*
       * The container is gone (platform eviction, redeploy, a stop). Before treating
       * the task as abandoned, look for its committed evidence: a range can have
       * written every segment and its manifest before the platform took the container
       * away, and re-reading a gigabyte because nobody looked is pure waste.
       */
      if (await this.recoverCommitted(current, workerId)) return "done";
      return "gone";
    }

    let status: { task?: { running?: boolean; exitCode?: number | null; signal?: string | null; stderr?: string } | null };
    try {
      const response = await container.getTcpPort(CONTAINER_PORT).fetch("http://container/task");
      status = (await response.json()) as typeof status;
    } catch {
      await this.coordinator("/heartbeat", { workerId }).catch(() => undefined);
      return "running";
    }

    const task = status.task;
    if (!task) return "gone";
    if (task.running) {
      await this.coordinator("/heartbeat", { workerId }).catch(() => undefined);
      return "running";
    }
    if (task.exitCode !== 0 || task.signal) {
      await this.coordinator("/fail", {
        workerId,
        taskId: current.id,
        error: `container task exited ${task.exitCode ?? "null"}${task.signal ? ` (${task.signal})` : ""}: ${(task.stderr ?? "").slice(-400)}`,
      });
      return "failed";
    }
    const reported = await this.report(current, workerId);
    return reported ? "done" : "failed";
  }

  /**
   * Report a range whose container vanished, if and only if it committed its whole span.
   *
   * Silence on any doubt: a missing or short manifest means the work is still to be
   * done, and the lease expiry (or the coordinator's stranded-task sweep) returns it to
   * the queue without spending an attempt.
   */
  private async recoverCommitted(current: InFlight, workerId: string): Promise<boolean> {
    if (current.kind !== "range") return false;
    const plan = await this.state.storage.get<ClaimedPlan>(KEYS.plan);
    if (!plan) return false;
    const [, sourceId, ordinal] = current.id.split(":");
    const index = Number(ordinal);
    try {
      const manifest = await readJson<CloudChunkManifest>(
        this.env.COMPANY_DATA,
        cloudKeys.chunkManifest(plan.version, sourceId ?? "", index),
      );
      if (!manifest || manifest.complete !== true) return false;
      if (current.start !== undefined && manifest.range.start !== current.start) return false;
      if (current.end !== undefined && manifest.range.end !== current.end) return false;
      const result =
        (await readJson<SwarmTaskResult>(this.env.COMPANY_DATA, swarmKeys.rangeResult(plan.version, sourceId ?? "", index))) ??
        resultFromManifest(manifest);
      await this.coordinator("/complete", {
        workerId,
        taskId: current.id,
        result,
        coverage: manifest.range,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the task's own result object from R2 and hand it to the coordinator.
   *
   * The container only reports an exit code; the evidence that a range did what it
   * claims is the objects it wrote. Reading them here means the coordinator never
   * trusts a container's stdout.
   */
  private async report(current: InFlight, workerId: string): Promise<boolean> {
    const plan = await this.state.storage.get<ClaimedPlan>(KEYS.plan);
    if (!plan) {
      await this.coordinator("/fail", { workerId, taskId: current.id, error: "this worker has no plan identity" });
      return false;
    }
    const [, sourceId, ordinal] = current.id.split(":");
    const index = Number(ordinal);

    if (current.kind === "block") {
      const block = await readJson<SwarmBlockDescriptor>(this.env.COMPANY_DATA, swarmKeys.block(plan.version, sourceId ?? "", index));
      if (!block) {
        await this.coordinator("/fail", { workerId, taskId: current.id, error: "block descriptor was not written" });
        return false;
      }
      await this.coordinator("/complete", {
        workerId,
        taskId: current.id,
        block,
        result: { rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesRead: block.bytes, classA: 1, classB: 0 },
      });
      return true;
    }

    if (current.kind === "range") {
      /*
       * A range's evidence is its CHUNK MANIFEST, not its result object.
       *
       * The manifest is written after every segment object and carries the byte range
       * it actually covered; the small result object is written last. A container that
       * was killed between those two writes used to be reported as a FAILED range —
       * discarding a gigabyte of committed spool and spending one of four attempts on
       * work that was already done. The manifest also lets this check the thing that
       * matters: the range must have covered exactly the bytes it leased. A manifest
       * that ends early is a partial range, and a partial range is never complete.
       */
      const manifest = await readJson<CloudChunkManifest>(
        this.env.COMPANY_DATA,
        cloudKeys.chunkManifest(plan.version, sourceId ?? "", index),
      );
      if (!manifest || manifest.complete !== true) {
        await this.coordinator("/fail", {
          workerId,
          taskId: current.id,
          error: `range ${current.id} did not write a complete chunk manifest; its spool was not committed`,
        });
        return false;
      }
      const expectedStart = current.start ?? manifest.range.start;
      const expectedEnd = current.end ?? manifest.range.end;
      if (manifest.range.start !== expectedStart || manifest.range.end !== expectedEnd) {
        await this.coordinator("/fail", {
          workerId,
          taskId: current.id,
          error:
            `range ${current.id} covered ${manifest.range.start}..${manifest.range.end}, ` +
            `but the task is ${expectedStart}..${expectedEnd}; refusing to count a partial range as complete`,
        });
        return false;
      }
      const result =
        (await readJson<SwarmTaskResult>(this.env.COMPANY_DATA, swarmKeys.rangeResult(plan.version, sourceId ?? "", index))) ??
        resultFromManifest(manifest);
      await this.coordinator("/complete", {
        workerId,
        taskId: current.id,
        result,
        // The coordinator refuses a completion whose coverage differs from the lease.
        coverage: manifest.range,
      });
      return true;
    }

    if (current.kind === "merge_partition") {
      // The partition task's own completion marker. Its presence is the evidence that
      // the partition's projections, details and posting parts were written.
      const result = await readJson<{ rows?: number; companies?: number; contacts?: number; shardParts?: number; objectBytes?: number }>(
        this.env.COMPANY_DATA,
        `cloud/jobs/${plan.version}/partitions/${String(index).padStart(4, "0")}.json`,
      );
      if (!result) {
        await this.coordinator("/fail", { workerId, taskId: current.id, error: "partition result object was not written" });
        return false;
      }
      await this.coordinator("/complete", {
        workerId,
        taskId: current.id,
        result: {
          // Rows are NOT added to the ingest totals: the same source rows are already
          // counted by the range tasks that parsed them. Reporting them again would
          // double the job's row count.
          rows: 0,
          rejected: 0,
          segments: result.shardParts ?? 0,
          segmentBytes: result.objectBytes ?? 0,
          bytesRead: 0,
          classA: 0,
          classB: 0,
          note: `partition complete: ${(result.companies ?? 0).toLocaleString()} companies, ${(result.contacts ?? 0).toLocaleString()} contacts`,
        },
      });
      return true;
    }

    if (current.kind === "assemble_shard") {
      const kind = current.id.split(":")[1] ?? "";
      const result = await readJson<{ terms?: number; postings?: number; bytes?: number; empty?: boolean; key?: string | null }>(
        this.env.COMPANY_DATA,
        `cloud/jobs/${plan.version}/shards/${kind}/${String(index).padStart(4, "0")}.json`,
      );
      if (!result) {
        await this.coordinator("/fail", { workerId, taskId: current.id, error: "shard result object was not written" });
        return false;
      }
      await this.coordinator("/complete", {
        workerId,
        taskId: current.id,
        result: {
          rows: 0,
          rejected: 0,
          segments: 0,
          segmentBytes: result.bytes ?? 0,
          bytesRead: 0,
          classA: 0,
          classB: 0,
          note: result.empty
            ? `${kind}/${index}: empty (no object written)`
            : `${kind}/${index}: ${(result.terms ?? 0).toLocaleString()} terms, ${(result.postings ?? 0).toLocaleString()} postings`,
        },
      });
      return true;
    }

    /*
     * FINALIZE (or a legacy single-merge task): the manifest is the evidence.
     *
     * A finalize that published a manifest with `validationPassed: false` must NOT be
     * reported as complete: that would activate a generation whose objects failed
     * verification. It is failed instead, so the coordinator parks it for an operator.
     */
    const manifest = await readJson<{
      validationPassed?: boolean;
      counters?: { rowsRead?: number; uniqueCompanies?: number; uniqueContacts?: number };
      objectCount?: number;
    }>(this.env.COMPANY_DATA, `manifests/${plan.version}/manifest.json`);
    const state = await readJson<{ totals?: { rowsIndexed?: number; segments?: number }; pass2?: { indexObjects?: number; indexBytes?: number } }>(
      this.env.COMPANY_DATA,
      `cloud/jobs/${plan.version}/state.json`,
    );
    if (current.kind === "finalize" && (!manifest || manifest.validationPassed !== true)) {
      await this.coordinator("/fail", {
        workerId,
        taskId: current.id,
        error: manifest
          ? "finalize published a manifest whose validation failed; nothing was activated"
          : "finalize did not publish a manifest",
      });
      return false;
    }
    const rows = manifest?.counters?.rowsRead ?? state?.totals?.rowsIndexed ?? 0;
    await this.coordinator("/complete", {
      workerId,
      taskId: current.id,
      result: {
        rows,
        rejected: 0,
        segments: state?.totals?.segments ?? 0,
        segmentBytes: state?.pass2?.indexBytes ?? 0,
        bytesRead: 0,
        classA: 0,
        classB: 0,
        note: manifest
          ? `finalize complete: ${(manifest.counters?.uniqueCompanies ?? 0).toLocaleString()} companies, ${(manifest.counters?.uniqueContacts ?? 0).toLocaleString()} contacts`
          : `merge complete: ${state?.pass2?.indexObjects ?? 0} index object(s)`,
      },
      ...(current.kind === "finalize" ? { searchable: { rows, companies: manifest?.counters?.uniqueCompanies, contacts: manifest?.counters?.uniqueContacts } } : {}),
    });
    return true;
  }

  /* -------------------------------- container ------------------------------ */

  /** Translate a swarm task into the CLI arguments its container should run. */
  private async startTask(task: SwarmTask, claimPlan?: ClaimedPlan): Promise<{ ok: true; args: string[] } | { ok: false; error: string }> {
    const plan = claimPlan ?? (await this.state.storage.get<ClaimedPlan>(KEYS.plan));
    if (!plan) return { ok: false, error: "no swarm plan identity for this worker" };
    const built = taskArgs(task, plan);
    if ("error" in built) return { ok: false, error: built.error };
    const args = built.args;

    const container = this.container();
    if (!container) return { ok: false, error: "this worker is not declared as a container class" };
    try {
      await this.startOnce(container);
    } catch (error) {
      return { ok: false, error: `container start failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const readiness = await this.waitForReady(container);
    if (readiness) return { ok: false, error: readiness };

    try {
      const response = await container.getTcpPort(CONTAINER_PORT).fetch("http://container/task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { started?: boolean; completed?: boolean; error?: { message?: string; detail?: string } }
        | null;
      if (!response.ok) {
        // The runner returns the CLI's own stderr as `detail`. Dropping it turned every
        // start failure into the same opaque "exit code 1" and hid the real cause
        // (missing R2 credentials, a bad flag) from the operator.
        const detail = payload?.error?.detail ? ` — ${String(payload.error.detail).trim().slice(0, 400)}` : "";
        return {
          ok: false,
          error: (payload?.error?.message ?? `container rejected the task (HTTP ${response.status})`) + detail,
        };
      }
      if (payload?.started === false && payload.completed) {
        return { ok: false, error: "the task finished before it could be observed; the lease will be reclaimed" };
      }
      // A merge can run for hours; the platform caps one call at 6h. The pump's poll
      // alarm also keeps the DO active, which is what actually holds the container
      // open, but the explicit window removes the dependence on alarm timing.
      // A merge or a finalize can run for hours; a block scan or a single shard is
      // minutes. The platform caps one call at 6h either way.
      const longRunning = task.kind === "merge" || task.kind === "merge_partition" || task.kind === "finalize";
      await this.renewInactivity(container, longRunning ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000);
      return { ok: true, args };
    } catch (error) {
      return { ok: false, error: `container request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async startOnce(container: Container): Promise<void> {
    if (container.running) return;
    await this.state.blockConcurrencyWhile(async () => {
      if (container.running) return;
      const env: Record<string, string> = {};
      if (this.env.R2_ACCOUNT_ID) env.R2_ACCOUNT_ID = this.env.R2_ACCOUNT_ID;
      if (this.env.R2_ACCESS_KEY_ID) env.R2_ACCESS_KEY_ID = this.env.R2_ACCESS_KEY_ID;
      if (this.env.R2_SECRET_ACCESS_KEY) env.R2_SECRET_ACCESS_KEY = this.env.R2_SECRET_ACCESS_KEY;
      if (this.env.CLOUD_JOB_BUDGET_USD) env.CLOUD_JOB_BUDGET_USD = this.env.CLOUD_JOB_BUDGET_USD;
      container.start({ enableInternet: true, env: Object.keys(env).length ? env : undefined });
    });
  }

  /** Keep the container alive while a task runs (the platform caps a call at 6h). */
  private async renewInactivity(container: Container, ms: number): Promise<void> {
    try {
      await container.setInactivityTimeout(Math.min(ms, 6 * 60 * 60 * 1000));
    } catch {
      // Best effort: a task's output keys are deterministic, so a stop is retryable.
    }
  }

  private async waitForReady(container: Container): Promise<string | null> {
    const configured = Number(this.env.CONTAINER_READY_TIMEOUT_MS ?? DEFAULT_READY_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let detail = "no response yet";
    while (Date.now() < deadline) {
      try {
        const response = await container.getTcpPort(CONTAINER_PORT).fetch("http://container/health");
        if (response.ok) return null;
        const body = await response.text().catch(() => "");
        if (response.status === 503) return `container is running but not usable: ${body.slice(0, 300)}`;
        detail = `health responded ${response.status}`;
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    return `container did not become ready within ${Math.round(timeoutMs / 1000)}s (${detail})`;
  }

  /**
   * Ask the coordinator whether this worker may work, without touching the container.
   *
   * A failure to reach the coordinator is NOT treated as a stop: the lease is what
   * makes concurrent work safe, so a running range continues and the next alarm asks
   * again. Erring the other way would destroy a healthy container because one DO call
   * timed out.
   */
  private async controlCheck(workerId: string): Promise<{ stage?: string; stop?: string }> {
    try {
      const answer = (await this.coordinator("/heartbeat", { workerId })) as { stage?: string; stop?: string | null } | null;
      return {
        ...(answer?.stage ? { stage: answer.stage } : {}),
        ...(answer?.stop ? { stop: String(answer.stop) } : {}),
      };
    } catch {
      return {};
    }
  }

  /**
   * Release the lease, then destroy the container — and say what happened for each.
   *
   * The order matters. Releasing first means an interrupted range goes back to the
   * queue as `pending` (with its attempt given back) instead of being left `leased`
   * against a container that no longer exists. Destroying first would be faster by a
   * few milliseconds and would strand the task, which is exactly how a paused run used
   * to end up with ranges that nobody could see and nobody would retry.
   */
  private async drain(workerId: string, reason: string): Promise<SwarmWorkerStopResult> {
    const current = await this.state.storage.get<InFlight>(KEYS.current);
    let releaseConfirmed = !current;
    let releaseError: string | undefined;
    if (current) {
      try {
        const answer = (await this.coordinator("/release", {
          workerId,
          taskId: current.id,
          reason: `worker stopped: ${reason}`,
        })) as { ok?: boolean } | null;
        // `ok: false` means the coordinator did not find the lease (already expired or
        // already completed). That is not a lost task, but it IS worth reporting: the
        // lease expiry is what recovers it, not this call.
        releaseConfirmed = answer?.ok !== false;
      } catch (error) {
        releaseError = `release failed: ${error instanceof Error ? error.message : String(error)}`;
        releaseConfirmed = false;
      }
    }

    const container = this.container();
    const containerRunningBefore = container?.running ?? false;
    let containerDestroyed = false;
    let destroyError: string | undefined;
    if (container) {
      try {
        await container.destroy();
      } catch (error) {
        destroyError = `container destroy failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      containerDestroyed = !(container.running ?? false);
    } else {
      containerDestroyed = true;
    }

    await this.state.storage.delete(KEYS.current);
    await this.state.storage.deleteAlarm();
    await this.state.storage.put(KEYS.held, reason);

    const error = [destroyError, releaseError].filter(Boolean).join("; ");
    return {
      workerId,
      // A worker that had no container running is a success; a green light while the
      // container is still up, or while its task was silently abandoned, is not.
      ok: !destroyError && releaseConfirmed,
      containerRunningBefore,
      containerDestroyed,
      releasedTaskId: current?.id ?? null,
      releaseConfirmed,
      alarmCleared: true,
      ...(error ? { error } : {}),
    };
  }

  private container(): Container | null {
    const candidate = (this.state as unknown as { container?: Container }).container;
    return candidate ?? null;
  }

  /* ------------------------------ coordinator ------------------------------ */

  private async coordinator(path: string, body: Record<string, unknown>): Promise<unknown> {
    const namespace = this.env.INDEXING_COORDINATOR;
    if (!namespace) throw new Error("INDEXING_COORDINATOR is not bound to this deployment");
    const stub = namespace.get(namespace.idFromName("swarm"));
    const response = await stub.fetch(`https://coordinator${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`coordinator ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return response.json();
  }
}

/**
 * The CLI invocation for one leased task.
 *
 * A missing argument is an ERROR, never an empty string: `--ref-base ""` would be
 * rejected by the CLI inside the container, which turns a coordinator bug into a
 * failed task with a confusing message. Returning the precise reason here parks it
 * immediately instead.
 */
function taskArgs(task: SwarmTask, plan: ClaimedPlan): { args: string[] } | { error: string } {
  if (task.kind === "merge") return { args: ["pass2", "--version", plan.version, "--partitions", String(plan.partitions)] };
  if (task.kind === "finalize") return { args: ["finalize-parallel", "--version", plan.version] };
  if (task.kind === "block") {
    return {
      args: [
        "blocks",
        "--version",
        plan.version,
        "--source",
        task.sourceId,
        "--block",
        String(task.index),
        "--block-mb",
        String(Math.round(plan.blockBytes / (1024 * 1024))),
      ],
    };
  }
  if (task.kind === "merge_partition") {
    if (task.refBase === undefined) return { error: `partition task ${task.id} has no refBase; cannot merge it safely` };
    return {
      args: [
        "merge-partition",
        "--version",
        plan.version,
        "--partition",
        String(task.partition ?? task.index),
        "--ref-base",
        String(task.refBase),
        ...(task.refCapacity !== undefined ? ["--ref-capacity", String(task.refCapacity)] : []),
        "--partitions",
        String(plan.partitions),
      ],
    };
  }
  if (task.kind === "assemble_shard") {
    if (!task.shardKind) return { error: `shard task ${task.id} has no shardKind` };
    return { args: ["assemble-shard", "--version", plan.version, "--kind", task.shardKind, "--shard", String(task.shard ?? task.index)] };
  }
  return {
    args: [
      "range",
      "--version",
      plan.version,
      "--source",
      task.sourceId,
      "--range",
      String(task.index),
      "--start",
      String(task.start),
      "--end",
      String(task.end),
      "--base-line",
      String(task.baseLine ?? 1),
      "--partitions",
      String(plan.partitions),
    ],
  };
}

/**
 * Rebuild a range's counters from its chunk manifest.
 *
 * `classA` is the manifest write plus one segment per partition; the rejected object
 * is written only when there were rejected rows, and it is included when the manifest
 * names it. The result object itself is the one write that is missing, and `classA`
 * counts R2 operations for a cost ESTIMATE, so being one operation low on a recovered
 * range is preferable to re-reading its whole span.
 */
function resultFromManifest(manifest: CloudChunkManifest): SwarmTaskResult {
  const segmentBytes = (manifest.segments ?? []).reduce((total, segment) => total + segment.bytes, 0);
  return {
    rows: manifest.rows ?? 0,
    rejected: manifest.rejected ?? 0,
    segments: (manifest.segments ?? []).length,
    segmentBytes,
    bytesRead: manifest.range.end - manifest.range.start,
    classA: (manifest.segments ?? []).length + (manifest.rejectedKey ? 2 : 1),
    classB: 0,
    note: "recovered from the chunk manifest: the range result object was missing, the committed spool was kept",
  };
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? ((await object.json()) as T) : null;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
