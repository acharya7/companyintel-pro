/**
 * Parallel indexing control plane (`/api/cloud/swarm/*`).
 *
 * Mounted inside `indexingAdmin`, so it inherits the same Cloudflare Access
 * verification, admin allowlist, cross-origin rule and JSON error shape as the rest
 * of the control plane — the route path is not the control.
 *
 * What it does
 *   `plan`    HEADs both source objects, refuses anything that could damage an
 *             existing generation, and creates the durable task plan in the
 *             coordinator (blocks → ingest → merge).
 *   `launch`  pumps worker 00…15 once each. Every pump claims a task and starts it in
 *             that worker's own container; from then on the workers advance
 *             themselves with alarms, so the browser can be closed and the laptop
 *             switched off.
 *   `pause`   pauses the coordinator (no new claims), releases every in-flight lease and
 *             then stops every container — the per-worker answers are awaited and
 *             returned, because an operator needs to know which containers are really
 *             down. It never aborts, re-plans or changes the version.
 *   `stop`    the same stop without resuming anything; optional `workers` selects names.
 *   `scale`   limits the active workforce; ids above the count are stopped and their
 *             leases handed back. A count is a SET, so "four workers" cannot leave
 *             twelve containers running.
 *   `resume`  resumes the same version, optionally with a selected worker count.
 *   `ranges`  the recovery audit: every range's id, byte span, state and attempts.
 *   `abort` / `status` drive and report the same coordinator.
 *
 * Safety
 *   A full-corpus swarm needs `control.approvedFullRun` (the existing `approve`
 *   route). Staging refuses it outright: staging runs bounded benchmarks only, and
 *   full-corpus work must never write into a shared bucket from the staging Worker.
 *   An existing validated manifest for the version is refused, because a published
 *   generation is immutable.
 */

import type { Context } from "hono";
import { Hono } from "hono";

import { CLOUD_CONTROL_VERSION, cloudKeys, type CloudControl } from "../../src/shared/cloud/types";
import {
  SWARM,
  SWARM_SHARDS,
  SWARM_WORKER_COUNT,
  clampWorkerCount,
  swarmActiveWorkerIds,
  swarmKeys,
  swarmRetiredWorkerIds,
  swarmWorkerIds,
  type SwarmPlan,
  type SwarmRangeAudit,
  type SwarmStatus,
  type SwarmStopSummary,
  type SwarmWorkerStopResult,
} from "../../src/shared/cloud/swarm";
import type { AccessIdentity } from "./env";
import type { EnvWithContainer } from "./indexer-container";
import type { WorkerEnv } from "./indexer-worker";

type SwarmContext = Context<{
  Bindings: EnvWithContainer & WorkerEnv;
  Variables: { identity: AccessIdentity };
}>;

export const swarmRoutes = new Hono<{
  Bindings: EnvWithContainer & WorkerEnv;
  Variables: { identity: AccessIdentity };
}>();

/**
 * The two production sources, in the SAME order as `tools/indexer/indexer.config.json`.
 *
 * The order is part of the spool identity: a row's source index is written into the
 * spool frame, so a plan that swapped them would build a spool Pass 2 reads
 * incorrectly. They are listed here rather than parsed from the config because the
 * Worker bundle does not include `tools/`, and a typo in a request must not be able
 * to point indexing at an arbitrary object.
 */
const SWARM_SOURCES = [
  { id: "csv1", key: "raw/file1.csv" },
  { id: "csv2", key: "raw/file2.csv" },
] as const;

/* --------------------------------- status -------------------------------- */

swarmRoutes.get("/status", async (c) => {
  const coordinator = c.env.INDEXING_COORDINATOR;
  if (!coordinator) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");
  const response = await coordinatorFetch(c, "/status", { method: "GET" });
  if (!response.ok) return passthrough(c, response, "The coordinator did not answer the status request.");
  return c.json((await response.json()) as SwarmStatus);
});

/* ---------------------------------- plan --------------------------------- */

swarmRoutes.post("/plan", async (c) => {
  const env = c.env;
  const coordinator = env.INDEXING_COORDINATOR;
  if (!coordinator) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");

  if ((env.STAGING_MODE ?? "").toLowerCase() === "true") {
    return c.json(
      {
        error: {
          code: "staging_bounded_only" as const,
          message: "The staging deployment refuses full-corpus swarm indexing; it runs bounded benchmarks only.",
        },
      },
      403,
    );
  }

  const body = (await c.req.json().catch(() => null)) as
    | { version?: unknown; partitions?: unknown; blockMb?: unknown; rangeBlocks?: unknown; workers?: unknown }
    | null;
  const version = typeof body?.version === "string" ? body.version.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,60}$/i.test(version)) {
    return c.json(
      { error: { code: "invalid_version" as const, message: "version must be 3..61 characters of letters, digits, dot, dash or underscore." } },
      400,
    );
  }
  if (version.startsWith("stg-")) {
    return c.json(
      { error: { code: "invalid_version" as const, message: "A production swarm must not use a stg- version id." } },
      400,
    );
  }

  const partitions = Number(body?.partitions ?? 256);
  if (!Number.isInteger(partitions) || partitions < 1 || partitions > 256) {
    return c.json({ error: { code: "invalid_partitions" as const, message: "partitions must be 1..256." } }, 400);
  }
  const blockMb = Number(body?.blockMb ?? SWARM.blockBytes / (1024 * 1024));
  if (!Number.isFinite(blockMb) || blockMb < 16 || blockMb > 512) {
    return c.json({ error: { code: "invalid_block_size" as const, message: "blockMb must be 16..512." } }, 400);
  }
  const rangeBlocks = Number(body?.rangeBlocks ?? SWARM.rangeBlocks);
  if (!Number.isInteger(rangeBlocks) || rangeBlocks < 1 || rangeBlocks > 8) {
    return c.json({ error: { code: "invalid_range" as const, message: "rangeBlocks must be 1..8." } }, 400);
  }
  const workers = clampWorkerCount(body?.workers === undefined ? undefined : Number(body.workers));

  // A published generation is immutable; writing into it would replace verified data.
  const existing = await env.COMPANY_DATA.head(`manifests/${version}/manifest.json`);
  if (existing) {
    return c.json(
      {
        error: {
          code: "version_exists" as const,
          message: `manifests/${version}/manifest.json already exists. A completed version is immutable — use a new version id.`,
        },
      },
      409,
    );
  }

  const control = await readControl(env, version);
  if (!control?.approvedFullRun) {
    return c.json(
      {
        error: {
          code: "approval_required" as const,
          message:
            "A full-corpus swarm needs an approved forecast. Approve the run through the indexing panel (POST /api/cloud/control approve) first.",
        },
      },
      403,
    );
  }

  const sources: SwarmPlan["sources"] = [];
  let bytesTotal = 0;
  for (const source of SWARM_SOURCES) {
    const head = await env.COMPANY_DATA.head(source.key);
    if (!head || head.size === null) {
      return c.json(
        {
          error: {
            code: "source_missing" as const,
            message: `Source ${source.id} is missing at ${source.key}; refusing to plan a swarm over an absent source.`,
          },
        },
        409,
      );
    }
    const blockBytes = Math.round(blockMb * 1024 * 1024);
    sources.push({
      id: source.id,
      key: source.key,
      size: head.size,
      etag: head.etag ?? null,
      blocks: Math.ceil(head.size / blockBytes),
    });
    bytesTotal += head.size;
  }

  const plan: SwarmPlan = {
    version,
    createdAt: new Date().toISOString(),
    mode: "full",
    partitions,
    blockBytes: Math.round(blockMb * 1024 * 1024),
    rangeBlocks,
    sources,
    budgetUsd: Number(env.CLOUD_JOB_BUDGET_USD ?? 0) > 0 ? Number(env.CLOUD_JOB_BUDGET_USD) : 50,
    workers,
    /*
     * The shard layout the assembly phase fans out over. It is the indexer's
     * production configuration (`tools/indexer/indexer.config.json`, asserted equal by
     * `tests/swarm-shard-plan.test.ts`), not a number chosen here: the reader derives
     * every shard key from these counts.
     */
    shards: { ...SWARM_SHARDS },
  };

  const response = await coordinatorFetch(c, "/plan", { method: "POST", body: JSON.stringify(plan) });
  if (!response.ok) return passthrough(c, response, "The coordinator refused the plan.");
  const result = (await response.json()) as { created?: boolean; status?: SwarmStatus };

  // Mirror the plan into R2: the coordinator owns execution, but an operator (and the
  // panel) must be able to see what was planned without querying a Durable Object.
  await env.COMPANY_DATA.put(swarmKeys.plan(version), JSON.stringify(plan), {
    httpMetadata: { contentType: "application/json" },
  });

  return c.json(
    {
      ok: true,
      created: result.created ?? false,
      plan,
      bytesTotal,
      workers,
      maxWorkers: SWARM_WORKER_COUNT,
      status: result.status ?? null,
    },
    201,
  );
});

/* --------------------------------- launch -------------------------------- */

swarmRoutes.post("/launch", async (c) => {
  const env = c.env;
  if (!env.INDEXER_WORKER) return unavailable(c, "INDEXER_WORKER is not bound to this deployment.");
  if (!env.INDEXING_COORDINATOR) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");

  const statusResponse = await coordinatorFetch(c, "/status", { method: "GET" });
  if (!statusResponse.ok) return passthrough(c, statusResponse, "The coordinator did not answer; nothing was launched.");
  const status = (await statusResponse.json()) as SwarmStatus;

  const body = (await c.req.json().catch(() => null)) as { workers?: unknown } | null;
  const count = clampWorkerCount(body?.workers === undefined ? status.workersAuthorised : Number(body.workers));

  /*
   * "Launch 4" must mean four containers, not four more. The workforce is a SET: ids
   * above the selected count are stopped (their leases handed back) before anything is
   * pumped, so workers 04…15 cannot keep running — and billing — behind a control that
   * says four.
   */
  const applied = await applyWorkerCount(c, count, "launch");
  if (!applied.ok) return applied.response;
  const ids = applied.active;
  const pumped = pumpWorkers(c, ids);
  c.executionCtx.waitUntil(pumped);

  return c.json(
    {
      ok: true,
      launched: ids.length,
      workerIds: ids,
      stage: status.stage,
      version: status.version,
      workers: count,
      retired: applied.retired,
      shutdown: applied.shutdown,
    },
    202,
  );
});

/* -------------------------------- controls -------------------------------- */

/**
 * Pause the coordinator FIRST, then stop every container.
 *
 * This is the pause the panel always meant. The coordinator releases every in-flight
 * lease as it pauses, so the stop that follows cannot fail, park or lose a task: the
 * interrupted ranges are simply pending again, with their retry budget intact, and the
 * same version resumes later.
 *
 * The per-worker answers are AWAITED and returned. A shutdown that half-worked used to
 * be invisible (`catch(() => null)`); an operator stopping nine containers needs to
 * know which ones refused and why.
 */
swarmRoutes.post("/pause", async (c) => {
  if (!c.env.INDEXING_COORDINATOR) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const response = await coordinatorFetch(c, "/pause", {
    method: "POST",
    body: JSON.stringify({ by: c.get("identity").email, ...(body.reason ? { reason: body.reason } : {}) }),
  });
  if (!response.ok) return passthrough(c, response, "The coordinator refused to pause the swarm.");
  const payload = (await response.json()) as SwarmStatus & { released?: string[] };
  const shutdown = await stopWorkers(c, swarmWorkerIds(), "pause-and-drain");
  return c.json({
    ok: shutdown.failed === 0,
    action: "pause",
    status: payload,
    released: payload.released ?? [],
    shutdown,
  });
});

/**
 * Stop containers without aborting the job.
 *
 * `workers` limits the stop to named identities ("stop worker 07"); omitted means all
 * sixteen. The coordinator is paused first unless `pause: false` is sent explicitly, so
 * no worker can claim a new task while the stop is in progress — and the job stays
 * resumable, which an abort would not.
 */
swarmRoutes.post("/stop", async (c) => {
  if (!c.env.INDEXING_COORDINATOR) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");
  const body = (await c.req.json().catch(() => ({}))) as { workers?: unknown; pause?: unknown; reason?: unknown };
  const ids = selectWorkers(body.workers);
  if (!ids.length) {
    return c.json(
      { error: { code: "invalid_workers" as const, message: `workers must be a non-empty list of ${swarmWorkerIds()[0]}…${swarmWorkerIds().at(-1)}.` } },
      400,
    );
  }
  let status: SwarmStatus | null = null;
  if (body.pause !== false) {
    const paused = await coordinatorFetch(c, "/pause", {
      method: "POST",
      body: JSON.stringify({ by: c.get("identity").email, reason: "stop requested by operator" }),
    });
    if (!paused.ok) return passthrough(c, paused, "The coordinator refused to pause the swarm; nothing was stopped.");
    status = readStatus(await paused.json());
  }
  const shutdown = await stopWorkers(c, ids, typeof body.reason === "string" ? body.reason : "stopped by operator");
  return c.json({ ok: shutdown.failed === 0, action: "stop", workers: ids, status, shutdown });
});

/**
 * Scale the active workforce down (or back up) WITHOUT resuming or aborting.
 *
 * The coordinator's active count is written before the extra workers are stopped, so a
 * retired worker cannot claim one last task in between. Its in-flight task is handed
 * back by `/stop`, and the workers that remain pick it up.
 */
swarmRoutes.post("/scale", async (c) => {
  if (!c.env.INDEXING_COORDINATOR) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");
  if (!c.env.INDEXER_WORKER) return unavailable(c, "INDEXER_WORKER is not bound to this deployment.");
  const body = (await c.req.json().catch(() => ({}))) as { workers?: unknown };
  const requested = Number(body.workers);
  if (!Number.isInteger(requested) || requested < 1 || requested > SWARM_WORKER_COUNT) {
    return c.json(
      { error: { code: "invalid_workers" as const, message: `workers must be an integer between 1 and ${SWARM_WORKER_COUNT}.` } },
      400,
    );
  }
  const applied = await applyWorkerCount(c, requested, "scale");
  if (!applied.ok) return applied.response;
  const statusResponse = await coordinatorFetch(c, "/status", { method: "GET" });
  const status = statusResponse.ok ? ((await statusResponse.json()) as SwarmStatus) : null;
  return c.json({
    ok: applied.shutdown.failed === 0,
    action: "scale",
    workers: requested,
    active: applied.active,
    retired: applied.retired,
    shutdown: applied.shutdown,
    status,
  });
});

/** Reduce the visible workforce to `count`: set it, then stop the rest with their leases. */
async function applyWorkerCount(
  c: SwarmContext,
  count: number,
  reason: string,
): Promise<{ ok: true; active: string[]; retired: string[]; shutdown: SwarmStopSummary } | { ok: false; response: Response }> {
  const active = swarmActiveWorkerIds(count);
  const retired = swarmRetiredWorkerIds(count);
  const response = await coordinatorFetch(c, "/workers", { method: "POST", body: JSON.stringify({ count }) });
  if (!response.ok) {
    return { ok: false, response: await passthrough(c, response, "The coordinator refused the workforce change.") };
  }
  const shutdown = retired.length ? await stopWorkers(c, retired, reason) : emptyStopSummary(0);
  return { ok: true, active, retired, shutdown };
}

/**
 * Resume with a selected worker count.
 *
 * Order: retire the extra workers (releasing their leases while the run is still
 * paused), record the count, un-pause, then pump the selected ids. Any other order can
 * leave a retired worker holding a task the resumed run will never see.
 */
swarmRoutes.post("/resume", async (c) => {
  if (!c.env.INDEXING_COORDINATOR) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");
  if (!c.env.INDEXER_WORKER) return unavailable(c, "INDEXER_WORKER is not bound to this deployment.");
  const body = (await c.req.json().catch(() => ({}))) as { workers?: unknown };
  const requested = body.workers === undefined ? undefined : Number(body.workers);
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > SWARM_WORKER_COUNT)) {
    return c.json(
      { error: { code: "invalid_workers" as const, message: `workers must be an integer between 1 and ${SWARM_WORKER_COUNT}.` } },
      400,
    );
  }

  let applied: Awaited<ReturnType<typeof applyWorkerCount>> | null = null;
  if (requested !== undefined) {
    applied = await applyWorkerCount(c, requested, "resume-scale-down");
    if (!applied.ok) return applied.response;
  }

  const response = await coordinatorFetch(c, "/resume", {
    method: "POST",
    body: JSON.stringify({ by: c.get("identity").email }),
  });
  if (!response.ok) return passthrough(c, response, "The coordinator refused to resume the swarm.");
  const payload = readStatus(await response.json());
  if (!payload) return c.json({ error: { code: "coordinator_error" as const, message: "The coordinator returned no status." } }, 502);

  const ids = requested !== undefined ? swarmActiveWorkerIds(requested) : swarmActiveWorkerIds(payload.workersAuthorised);
  c.executionCtx.waitUntil(pumpWorkers(c, ids));
  return c.json({
    ok: true,
    action: "resume",
    workers: ids.length,
    workerIds: ids,
    status: payload,
    ...(applied ? { retired: applied.retired, shutdown: applied.shutdown } : {}),
  });
});

swarmRoutes.post("/abort", async (c) => {
  if (!c.env.INDEXING_COORDINATOR) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");
  const response = await coordinatorFetch(c, "/abort", {
    method: "POST",
    body: JSON.stringify({ by: c.get("identity").email }),
  });
  if (!response.ok) return passthrough(c, response, "The coordinator refused to abort the swarm.");
  const status = readStatus(await response.json());
  // Abort also stops the containers: nothing should keep billing after it. Its outcome
  // is reported for the same reason a pause reports it.
  const shutdown = await stopWorkers(c, swarmWorkerIds(), "abort");
  return c.json({ ok: shutdown.failed === 0, action: "abort", status, shutdown });
});

/**
 * The remaining ranges, with real byte spans, states and retry counts.
 *
 * Read from the coordinator's own task records, so "14 ranges / 15.1 GB" becomes a list
 * with ids instead of an inference from a coverage percentage.
 */
swarmRoutes.get("/ranges", async (c) => {
  if (!c.env.INDEXING_COORDINATOR) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");
  const query = new URL(c.req.url).searchParams.toString();
  const response = await coordinatorFetch(c, `/ranges${query ? `?${query}` : ""}`, { method: "GET" });
  if (!response.ok) return passthrough(c, response, "The coordinator did not answer the range audit.");
  return c.json((await response.json()) as SwarmRangeAudit);
});

/* -------------------------------- helpers -------------------------------- */

function pumpWorkers(c: SwarmContext, ids: readonly string[]): Promise<unknown> {
  const workers = c.env.INDEXER_WORKER;
  if (!workers) return Promise.resolve([]);
  return Promise.all(
    ids.map((workerId) => {
      const stub = workers.get(workers.idFromName(workerId));
      return stub
        .fetch("https://worker/pump", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workerId }),
        })
        .catch(() => null);
    }),
  );
}

/**
 * Stop named workers and collect what each one actually did.
 *
 * Awaited, not `waitUntil`: the whole point of the control is the outcome. A worker
 * that cannot be reached, or that reports it could not destroy its container, is a
 * failure the operator must see — not a `null` swallowed by a background promise.
 */
async function stopWorkers(c: SwarmContext, ids: readonly string[], reason: string): Promise<SwarmStopSummary> {
  const workers = c.env.INDEXER_WORKER;
  if (!workers) {
    return { requested: ids.length, stopped: 0, failed: ids.length, results: [], error: "INDEXER_WORKER is not bound to this deployment." };
  }
  const results = await Promise.all(
    ids.map(async (workerId): Promise<SwarmWorkerStopResult> => {
      try {
        const stub = workers.get(workers.idFromName(workerId));
        const response = await stub.fetch("https://worker/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason, workerId }),
        });
        const payload = (await response.json().catch(() => null)) as SwarmWorkerStopResult | null;
        if (!payload || typeof payload.workerId !== "string") {
          return invalidStop(workerId, `worker answered HTTP ${response.status} without a shutdown report`);
        }
        return { ...payload, workerId };
      } catch (error) {
        return invalidStop(workerId, error instanceof Error ? error.message : String(error));
      }
    }),
  );
  const stopped = results.filter((result) => result.ok).length;
  return { requested: ids.length, stopped, failed: ids.length - stopped, results };
}

function invalidStop(workerId: string, error: string): SwarmWorkerStopResult {
  return {
    workerId,
    ok: false,
    containerRunningBefore: false,
    containerDestroyed: false,
    releasedTaskId: null,
    releaseConfirmed: false,
    alarmCleared: false,
    error,
  };
}

function emptyStopSummary(requested: number): SwarmStopSummary {
  return { requested, stopped: 0, failed: 0, results: [] };
}

function selectWorkers(value: unknown): string[] {
  const known = new Set(swarmWorkerIds());
  if (value === undefined) return swarmWorkerIds();
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && known.has(entry)))].sort();
}

/** The coordinator's status, accepted as a bare status or wrapped in `{ status }`. */
function readStatus(payload: unknown): SwarmStatus | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { status?: unknown; version?: unknown };
  if (typeof record.version === "string") return payload as SwarmStatus;
  const nested = record.status as { version?: unknown } | undefined;
  return nested && typeof nested.version === "string" ? (nested as SwarmStatus) : null;
}

function coordinatorFetch(c: SwarmContext, path: string, init: RequestInit): Promise<Response> {
  const namespace = c.env.INDEXING_COORDINATOR!;
  const stub = namespace.get(namespace.idFromName("swarm"));
  return stub.fetch(`https://coordinator${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function readControl(env: EnvWithContainer, version: string): Promise<CloudControl | null> {
  const object = await env.COMPANY_DATA.get(cloudKeys.control(version));
  if (!object) return null;
  const control = (await object.json()) as CloudControl;
  return { ...control, version: CLOUD_CONTROL_VERSION };
}

function unavailable(c: SwarmContext, message: string): Response {
  return c.json({ error: { code: "swarm_unavailable" as const, message } }, 503);
}

async function passthrough(c: SwarmContext, response: Response, fallback: string): Promise<Response> {
  const text = await response.text().catch(() => "");
  let detail = text.slice(0, 400);
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed?.error?.message) detail = parsed.error.message;
  } catch {
    // Not JSON: the truncated body is the best detail available.
  }
  return c.json(
    { error: { code: "coordinator_error" as const, message: `${fallback} ${detail}`.trim() } },
    502,
  );
}
