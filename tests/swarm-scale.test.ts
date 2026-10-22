/**
 * The administrative workforce controls, driven through the real routes.
 *
 * The production failure was not only that pause did not stop anything — it was that a
 * control could CLAIM something it had not verified. "Use four workers" used to pump
 * 00…03 and leave 04…15 running, and a stop answered `{ ok: true }` without saying which
 * containers were still up. These tests assert the observable contract:
 *
 *   - pause is ordered (coordinator first, containers second) and every worker's answer
 *     is awaited and returned, including the failures;
 *   - `launch`, `resume` and `scale` all reduce the workforce to a SET, stopping the ids
 *     above the selected count;
 *   - a stop can name individual workers;
 *   - nothing here aborts, re-plans or changes the version.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { SWARM_WORKER_COUNT, type SwarmStatus, type SwarmWorkerStopResult } from "../src/shared/cloud/swarm";
import { swarmRoutes } from "../worker/src/swarm-admin";

const STATUS: SwarmStatus = {
  version: "full-2026-10-22",
  stage: "ingest",
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T01:00:00.000Z",
  mode: "full",
  partitions: 256,
  workersAuthorised: 16,
  workersActive: 9,
  tasks: { blocksPending: 0, blocksDone: 480, rangesPending: 14, rangesDone: 466, failed: 6, parked: 0 },
  sources: [],
  totals: { rows: 72_303_448, rejected: 6, segments: 0, segmentBytes: 0, bytesCovered: 49_146_000_000, bytesTotal: 64_262_000_000, coveragePercent: 76.47 },
  rate: { rowsPerSecond: null, bytesPerSecond: null, searchableRowsPerSecond: null, etaSeconds: null },
  accounting: { containerSeconds: 0, containerUsd: 0, classA: 0, classB: 0, bytesRead: 0, bytesWritten: 0, r2Usd: 0, estimatedUsd: 0, budgetUsd: 50, level: "ok" },
  errors: [],
};

interface Call {
  name: string;
  path: string;
  body: Record<string, unknown>;
}

/** A Durable Object namespace whose instances record what the control plane asked. */
function fakeNamespace(respond: (name: string, path: string, body: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      async fetch(input: string, init?: RequestInit) {
        const path = new URL(input).pathname;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ name, path, body });
        return new Response(JSON.stringify(respond(name, path, body)), { status: 200 });
      },
    }),
  };
  return { namespace, calls };
}

function harness(options: { failWorker?: string; releaseFails?: boolean } = {}) {
  const coordinator = fakeNamespace((_name, path, body) => {
    if (path === "/status") return STATUS;
    if (path === "/pause") return { ...STATUS, stage: "paused", released: ["range:csv1:000012"] };
    if (path === "/resume") return { ...STATUS, stage: "ingest" };
    if (path === "/workers") return { ok: true, workers: body.count, status: STATUS };
    if (path === "/ranges") return { version: STATUS.version, ranges: [] };
    return { ...STATUS };
  });
  const workers = fakeNamespace((name, path) => {
    if (path !== "/stop") return { ok: true, started: true };
    const result: SwarmWorkerStopResult = {
      workerId: name,
      ok: name !== options.failWorker,
      containerRunningBefore: true,
      containerDestroyed: name !== options.failWorker,
      releasedTaskId: name === options.failWorker ? null : `range:csv1:000${name.slice(-2)}`,
      releaseConfirmed: !options.releaseFails,
      alarmCleared: name !== options.failWorker,
      ...(name === options.failWorker ? { error: "container destroy failed: platform error" } : {}),
    };
    return result;
  });

  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: { identity: { email: string } } }>();
  app.use("*", async (c, next) => {
    c.set("identity", { email: "operator@example.com" });
    await next();
  });
  app.route("/swarm", swarmRoutes);

  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      waits.push(promise);
    },
    passThroughOnException: () => undefined,
  };
  const call = async (path: string, body: Record<string, unknown> = {}) => {
    const response = await app.request(
      `/swarm${path}`,
      { method: path === "/ranges" ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(path === "/ranges" ? {} : { body: JSON.stringify(body) }) },
      { INDEXER_WORKER: workers.namespace, INDEXING_COORDINATOR: coordinator.namespace } as never,
      ctx as never,
    );
    // The pumps are genuinely backgrounded; awaiting them here makes the assertions
    // about which ids were pumped deterministic.
    await Promise.all(waits);
    waits.length = 0;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  return { call, coordinator, workers };
}

const stopCalls = (calls: Call[]) => calls.filter((call) => call.path === "/stop").map((call) => call.name).sort();
const pumpCalls = (calls: Call[]) => calls.filter((call) => call.path === "/pump").map((call) => call.name).sort();

describe("swarm admin: pause drains containers without aborting the job", () => {
  test("pauses the coordinator first, then stops every worker and reports each outcome", async () => {
    const { call, coordinator, workers } = harness();
    const response = await call("/pause");
    expect(response.status).toBe(200);

    // Ordering: the coordinator is paused before any container is asked to stop. A stop
    // before the pause would let a worker claim a fresh task on its way out.
    const coordinatorOrder = coordinator.calls.map((entry) => entry.path);
    expect(coordinatorOrder[0]).toBe("/pause");

    expect(stopCalls(workers.calls)).toHaveLength(SWARM_WORKER_COUNT);
    expect(response.body.action).toBe("pause");
    expect(response.body.released).toEqual(["range:csv1:000012"]);
    const shutdown = response.body.shutdown as {
      requested: number;
      stopped: number;
      failed: number;
      results: SwarmWorkerStopResult[];
    };
    expect(shutdown.requested).toBe(SWARM_WORKER_COUNT);
    expect(shutdown.stopped).toBe(SWARM_WORKER_COUNT);
    expect(shutdown.failed).toBe(0);
    expect(shutdown.results[0]).toMatchObject({ ok: true, containerDestroyed: true, releaseConfirmed: true });
    // The job's identity is untouched: no abort, no re-plan, no version change.
    expect(coordinatorOrder).not.toContain("/abort");
    expect(coordinatorOrder).not.toContain("/plan");
    expect((response.body.status as SwarmStatus).version).toBe("full-2026-10-22");
  });

  test("a container that refuses to stop is reported, not hidden", async () => {
    const { call, workers } = harness({ failWorker: "indexer-worker-07" });
    const response = await call("/pause");
    const shutdown = response.body.shutdown as { stopped: number; failed: number; results: SwarmWorkerStopResult[] };
    expect(response.body.ok).toBe(false);
    expect(shutdown.stopped).toBe(SWARM_WORKER_COUNT - 1);
    expect(shutdown.failed).toBe(1);
    expect(shutdown.results.find((result) => result.workerId === "indexer-worker-07")).toMatchObject({
      ok: false,
      containerDestroyed: false,
      error: "container destroy failed: platform error",
    });
    // Every worker was still asked.
    expect(stopCalls(workers.calls)).toHaveLength(SWARM_WORKER_COUNT);
  });

  test("a lease that could not be handed back is visible in the per-worker result", async () => {
    const { call } = harness({ releaseFails: true });
    const response = await call("/pause");
    const shutdown = response.body.shutdown as { results: SwarmWorkerStopResult[] };
    expect(shutdown.results.every((result) => result.releaseConfirmed === false)).toBe(true);
  });
});

describe("swarm admin: a worker count is a set, not a hint", () => {
  test("launching four stops workers 04…127 and pumps only 00…03", async () => {
    const { call, coordinator, workers } = harness();
    const response = await call("/launch", { workers: 4 });
    expect(response.status).toBe(202);
    expect(response.body.launched).toBe(4);

    expect(coordinator.calls.find((entry) => entry.path === "/workers")!.body).toMatchObject({ count: 4 });
    const retired = stopCalls(workers.calls);
    expect(retired).toHaveLength(SWARM_WORKER_COUNT - 4);
    expect(retired[0]).toBe("indexer-worker-04");
    // `stopCalls` sorts ids as strings, so membership is asserted, not position.
    expect(retired).toContain(`indexer-worker-${SWARM_WORKER_COUNT - 1}`);
    expect(pumpCalls(workers.calls)).toEqual([
      "indexer-worker-00",
      "indexer-worker-01",
      "indexer-worker-02",
      "indexer-worker-03",
    ]);
  });

  test("resuming with four retires the extras before it un-pauses", async () => {
    const { call, coordinator, workers } = harness();
    const response = await call("/resume", { workers: 4 });
    expect(response.status).toBe(200);
    expect(response.body.workers).toBe(4);

    const coordinatorOrder = coordinator.calls.map((entry) => entry.path);
    expect(coordinatorOrder.indexOf("/workers")).toBeLessThan(coordinatorOrder.indexOf("/resume"));
    expect(stopCalls(workers.calls)).toHaveLength(SWARM_WORKER_COUNT - 4);
    expect(pumpCalls(workers.calls)).toEqual(["indexer-worker-00", "indexer-worker-01", "indexer-worker-02", "indexer-worker-03"]);
  });

  test("scaling to two mid-run stops 02…127 and does not resume", async () => {
    const { call, coordinator, workers } = harness();
    const response = await call("/scale", { workers: 2 });
    expect(response.status).toBe(200);
    expect(response.body.workers).toBe(2);
    const retired = stopCalls(workers.calls);
    expect(retired).toHaveLength(SWARM_WORKER_COUNT - 2);
    expect(retired[0]).toBe("indexer-worker-02");
    expect(retired).toContain(`indexer-worker-${SWARM_WORKER_COUNT - 1}`);
    expect(pumpCalls(workers.calls)).toHaveLength(0);
    expect(coordinator.calls.map((entry) => entry.path)).not.toContain("/resume");
  });

  test("refuses a workforce the platform cannot run", async () => {
    const { call } = harness();
    for (const workers of [0, SWARM_WORKER_COUNT + 1, 3.5]) {
      const response = await call("/scale", { workers });
      expect(response.status).toBe(400);
      expect(String((response.body.error as { code?: string } | undefined)?.code)).toBe("invalid_workers");
    }
  });
});

describe("swarm admin: stopping containers never aborts the job", () => {
  test("stop-all pauses the coordinator and stops every identity", async () => {
    const { call, coordinator, workers } = harness();
    const response = await call("/stop", {});
    expect(response.status).toBe(200);
    expect(coordinator.calls.map((entry) => entry.path)).toEqual(["/pause"]);
    expect(stopCalls(workers.calls)).toHaveLength(SWARM_WORKER_COUNT);
    expect((response.body.status as SwarmStatus).stage).toBe("paused");
  });

  test("a named worker is the only one stopped", async () => {
    const { call, workers } = harness();
    const response = await call("/stop", { workers: ["indexer-worker-07"] });
    expect(response.status).toBe(200);
    expect(stopCalls(workers.calls)).toEqual(["indexer-worker-07"]);
    expect((response.body.workers as string[])).toEqual(["indexer-worker-07"]);
  });

  test("rejects an unknown worker id instead of stopping everything", async () => {
    const { call, workers } = harness();
    const response = await call("/stop", { workers: [`indexer-worker-${SWARM_WORKER_COUNT}`] });
    expect(response.status).toBe(400);
    expect(stopCalls(workers.calls)).toHaveLength(0);
  });
});
