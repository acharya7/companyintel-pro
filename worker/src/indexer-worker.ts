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

import {
  SWARM,
  swarmKeys,
  type SwarmBlockDescriptor,
  type SwarmTask,
  type SwarmTaskResult,
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
}

/** What a claim teaches the worker about the run (enough to build its CLI command). */
interface ClaimedPlan {
  version: string;
  partitions: number;
  blockBytes: number;
}

type PollOutcome = "running" | "done" | "failed" | "gone";

const KEYS = { workerId: "workerId", current: "current", plan: "plan" } as const;

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
        await this.shutdown();
        return json({ ok: true, stopped: true });
      }
      if (url.pathname === "/state" && request.method === "GET") {
        const workerId = await this.state.storage.get<string>(KEYS.workerId);
        const current = await this.state.storage.get<InFlight>(KEYS.current);
        const container = this.container();
        return json({ workerId: workerId ?? null, current: current ?? null, containerRunning: container?.running ?? false });
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

      // 1. Finish whatever is in flight before claiming anything new.
      const current = await this.state.storage.get<InFlight>(KEYS.current);
      if (current) {
        const state = await this.pollTask(current, workerId);
        if (state === "running") {
          await this.state.storage.setAlarm(Date.now() + SWARM.pollMs);
          return { running: current.id };
        }
        if (state === "gone") {
          // The container vanished (platform stop, redeploy). Leave the lease to
          // expire rather than burning one of the task's attempts: the same work is
          // safe to redo, and another worker will pick it up.
          await this.state.storage.delete(KEYS.current);
          await this.state.storage.setAlarm(Date.now() + SWARM.pollMs);
          return { containerGone: current.id };
        }
        if (state === "done") outcome.completed = current.id;
        else outcome.failed = current.id;
        await this.state.storage.delete(KEYS.current);
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
          if (claim.stop === "complete" || claim.stop === "paused" || claim.stop === "aborted" || claim.stop === "budget") {
            await this.shutdown();
            return outcome;
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

  /** Ask the container how the running task is doing; report it when it ended. */
  private async pollTask(current: InFlight, workerId: string): Promise<PollOutcome> {
    const container = this.container();
    if (!container || !container.running) return "gone";

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
      const result = await readJson<SwarmTaskResult>(
        this.env.COMPANY_DATA,
        swarmKeys.rangeResult(plan.version, sourceId ?? "", index),
      );
      if (!result) {
        await this.coordinator("/fail", { workerId, taskId: current.id, error: "range result object was not written" });
        return false;
      }
      await this.coordinator("/complete", { workerId, taskId: current.id, result });
      return true;
    }

    // Merge: Pass 2 writes the job state; the searchable row count comes from there.
    const state = await readJson<{
      totals?: { rowsIndexed?: number; segments?: number };
      pass2?: { indexObjects?: number; indexBytes?: number };
    }>(this.env.COMPANY_DATA, `cloud/jobs/${plan.version}/state.json`);
    const rows = state?.totals?.rowsIndexed ?? 0;
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
        note: `merge complete: ${state?.pass2?.indexObjects ?? 0} index object(s)`,
      },
      searchable: { rows },
    });
    return true;
  }

  /* -------------------------------- container ------------------------------ */

  /** Translate a swarm task into the CLI arguments its container should run. */
  private async startTask(task: SwarmTask, claimPlan?: ClaimedPlan): Promise<{ ok: true; args: string[] } | { ok: false; error: string }> {
    const plan = claimPlan ?? (await this.state.storage.get<ClaimedPlan>(KEYS.plan));
    if (!plan) return { ok: false, error: "no swarm plan identity for this worker" };
    const args =
      task.kind === "merge"
        ? ["pass2", "--version", plan.version, "--partitions", String(plan.partitions)]
        : task.kind === "block"
          ? [
              "blocks",
              "--version",
              plan.version,
              "--source",
              task.sourceId,
              "--block",
              String(task.index),
              "--block-mb",
              String(Math.round(plan.blockBytes / (1024 * 1024))),
            ]
          : [
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
            ];

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
        | { started?: boolean; completed?: boolean; error?: { message?: string } }
        | null;
      if (!response.ok) {
        return { ok: false, error: payload?.error?.message ?? `container rejected the task (HTTP ${response.status})` };
      }
      if (payload?.started === false && payload.completed) {
        return { ok: false, error: "the task finished before it could be observed; the lease will be reclaimed" };
      }
      // A merge can run for hours; the platform caps one call at 6h. The pump's poll
      // alarm also keeps the DO active, which is what actually holds the container
      // open, but the explicit window removes the dependence on alarm timing.
      await this.renewInactivity(container, task.kind === "merge" ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000);
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

  private async shutdown(): Promise<void> {
    const container = this.container();
    try {
      if (container) await container.destroy();
    } catch {
      // Already gone: nothing to stop.
    }
    await this.state.storage.delete(KEYS.current);
    await this.state.storage.deleteAlarm();
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

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? ((await object.json()) as T) : null;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
