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
 *   `pause` / `resume` / `abort` / `status` drive and report the same coordinator.
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
  SWARM_WORKER_COUNT,
  clampWorkerCount,
  swarmKeys,
  swarmWorkerIds,
  type SwarmPlan,
  type SwarmStatus,
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
  const workers = env.INDEXER_WORKER;
  if (!workers) return unavailable(c, "INDEXER_WORKER is not bound to this deployment.");
  if (!env.INDEXING_COORDINATOR) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");

  const statusResponse = await coordinatorFetch(c, "/status", { method: "GET" });
  if (!statusResponse.ok) return passthrough(c, statusResponse, "The coordinator did not answer; nothing was launched.");
  const status = (await statusResponse.json()) as SwarmStatus;

  const body = (await c.req.json().catch(() => null)) as { workers?: unknown } | null;
  const count = clampWorkerCount(body?.workers === undefined ? status.workersAuthorised : Number(body.workers));
  const ids = swarmWorkerIds().slice(0, count);

  /*
   * Each pump is a Durable Object call that may wait for a cold start, so the request
   * answers immediately and the pumps run in the background. A pump that fails is not
   * retried here: the worker's own alarm re-arms, and the coordinator's lease expiry
   * covers a worker that never came up.
   */
  const pumps = ids.map((workerId) => {
    const stub = workers.get(workers.idFromName(workerId));
    return stub
      .fetch("https://worker/pump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId }),
      })
      .catch(() => null);
  });
  c.executionCtx.waitUntil(Promise.all(pumps));

  return c.json({ ok: true, launched: ids.length, workerIds: ids, stage: status.stage, version: status.version }, 202);
});

/* -------------------------------- controls -------------------------------- */

for (const action of ["pause", "resume", "abort"] as const) {
  swarmRoutes.post(`/${action}`, async (c) => {
    if (!c.env.INDEXING_COORDINATOR) return unavailable(c, "INDEXING_COORDINATOR is not bound to this deployment.");
    const response = await coordinatorFetch(c, `/${action}`, {
      method: "POST",
      body: JSON.stringify({ by: c.get("identity").email }),
    });
    if (!response.ok) return passthrough(c, response, `The coordinator refused to ${action} the swarm.`);
    const status = (await response.json()) as SwarmStatus | { status?: SwarmStatus };
    const body = "version" in status ? status : (status.status ?? null);
    if (action === "abort") {
      // Abort also stops the containers: nothing should keep billing after it.
      await stopAllWorkers(c);
    }
    return c.json({ ok: true, action, status: body });
  });
}

/* -------------------------------- helpers -------------------------------- */

async function stopAllWorkers(c: SwarmContext): Promise<void> {
  const workers = c.env.INDEXER_WORKER;
  if (!workers) return;
  const stops = swarmWorkerIds().map((workerId) => {
    const stub = workers.get(workers.idFromName(workerId));
    return stub.fetch("https://worker/stop", { method: "POST" }).catch(() => null);
  });
  c.executionCtx.waitUntil(Promise.all(stops));
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
