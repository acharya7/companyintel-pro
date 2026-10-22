/**
 * Pause / stop / lease recovery — the emergency-recovery contract.
 *
 * Production was paused with NINE containers still running, 14 ranges outstanding and
 * a resume that produced no new work. These tests pin down the four mechanisms that
 * caused it, and prove the fix does not pay for itself by damaging the job:
 *
 *   1. a pause releases every in-flight lease BEFORE any container is stopped, so an
 *      interrupted range is `pending` again — never failed, never parked, never billed
 *      against its retry budget;
 *   2. a task whose worker record no longer names it is still recovered when its lease
 *      expires (the old coordinator could only find stranded tasks through a worker, so
 *      this state was invisible and the phase could never finish);
 *   3. a worker asks the coordinator before it polls its container, so a paused run
 *      destroys the container on the next alarm and arms nothing;
 *   4. a worker id above the operator's active count is retired, so scaling to four
 *      cannot leave twelve containers running.
 */

import { describe, expect, test } from "bun:test";

import { cloudKeys } from "../src/shared/cloud/types";
import { SWARM_WORKER_COUNT, type SwarmBlockDescriptor, type SwarmPlan, type SwarmTask } from "../src/shared/cloud/swarm";
import { IndexingCoordinator } from "../worker/src/indexing-coordinator";
import { IndexerWorker } from "../worker/src/indexer-worker";
import { fakeDoState } from "./helpers/fake-do";
import { FakeR2Bucket } from "./helpers/fake-r2";

const BLOCK_BYTES = 1024;
const SIZE = 3072;
const VERSION = "full-2026-10-22";

const PLAN: SwarmPlan = {
  version: VERSION,
  createdAt: "2026-10-22T00:00:00.000Z",
  mode: "full",
  partitions: 4,
  blockBytes: BLOCK_BYTES,
  rangeBlocks: 1,
  sources: [{ id: "csv1", key: "raw/file1.csv", size: SIZE, etag: '"e1"', blocks: 3 }],
  budgetUsd: 50,
  workers: 4,
  shards: { exact: 1, prefix: 1, token: 1, trigram: 1, ids: 1 },
};

/** One block, so an interrupted task leaves the queue empty — the production shape. */
const SOLO_PLAN: SwarmPlan = {
  ...PLAN,
  blockBytes: BLOCK_BYTES,
  sources: [{ id: "csv1", key: "raw/file1.csv", size: BLOCK_BYTES, etag: '"e1"', blocks: 1 }],
};

function harness(seed: Record<string, unknown> = {}) {
  const state = fakeDoState({ seed });
  const bucket = new FakeR2Bucket();
  const coordinator = new IndexingCoordinator(state as unknown as DurableObjectState, {
    COMPANY_DATA: bucket as unknown as R2Bucket,
  });
  return { state, bucket, coordinator };
}

async function call(coordinator: IndexingCoordinator, path: string, body: Record<string, unknown> = {}) {
  const read = path === "/status" || path.startsWith("/ranges");
  const response = await coordinator.fetch(
    new Request(`https://coordinator${path}`, {
      method: read ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(read ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function descriptor(index: number): SwarmBlockDescriptor {
  return {
    index,
    start: index * BLOCK_BYTES,
    end: (index + 1) * BLOCK_BYTES,
    bytes: BLOCK_BYTES,
    quotes: 0,
    newlines: 10,
    firstFalseEnd: index * BLOCK_BYTES + 100,
    firstFalseLine: 11,
    firstTrueEnd: null,
    firstTrueLine: null,
  };
}

/** Complete every block task, so the coordinator plans ranges and enters ingest. */
async function finishBlocks(coordinator: IndexingCoordinator): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    const claim = await call(coordinator, "/claim", { workerId: "indexer-worker-00" });
    const task = claim.body.task as SwarmTask;
    expect(task.kind).toBe("block");
    await call(coordinator, "/complete", {
      workerId: "indexer-worker-00",
      taskId: task.id,
      block: descriptor(task.index),
      result: { rows: 0, rejected: 0, segments: 0, segmentBytes: 0, bytesRead: BLOCK_BYTES, classA: 1, classB: 0 },
    });
  }
}

describe("coordinator: pause releases leases instead of abandoning them", () => {
  test("pause hands back the in-flight task without failing or parking it", async () => {
    const { coordinator, state } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    const claim = await call(coordinator, "/claim", { workerId: "indexer-worker-00" });
    const task = claim.body.task as SwarmTask;
    expect(task.state).toBe("leased");

    const paused = await call(coordinator, "/pause", { by: "operator@example.com", reason: "emergency stop" });
    expect(paused.status).toBe(200);
    expect(paused.body.stage).toBe("paused");
    // The lease is named in the answer, so the operator knows what was in flight.
    expect(paused.body.released).toEqual([task.id]);

    const stored = state.map.get(`t:${task.id}`) as SwarmTask;
    expect(stored.state).toBe("pending");
    expect(stored.leaseOwner).toBeUndefined();
    // An operator stop gives the attempt back: it is not the task's failure.
    expect(stored.attempts).toBe(0);
    expect(stored.interruptions).toBe(1);
    expect(stored.interruptedAt).toBeTruthy();

    const status = (await call(coordinator, "/status")).body as unknown as {
      stage: string;
      tasks: { failed: number; parked: number; blocksDone: number };
    };
    expect(status.stage).toBe("paused");
    expect(status.tasks.failed).toBe(0);
    expect(status.tasks.parked).toBe(0);
    expect(status.tasks.blocksDone).toBe(0);
  });

  test("the same version resumes and re-claims the interrupted task", async () => {
    const { coordinator } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    const first = (await call(coordinator, "/claim", { workerId: "indexer-worker-00" })).body.task as SwarmTask;
    await call(coordinator, "/pause", { by: "operator@example.com" });
    await call(coordinator, "/resume", { by: "operator@example.com" });

    const resumed = await call(coordinator, "/claim", { workerId: "indexer-worker-01" });
    expect(resumed.body.stage).toBe("blocks");
    const task = resumed.body.task as SwarmTask;
    expect(task.id).toBe(first.id);
    expect(task.attempts).toBe(1);
    expect(task.leaseOwner).toBe("indexer-worker-01");
  });

  test("a pause does not advance the phase or change the planned ranges", async () => {
    const { coordinator } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    await finishBlocks(coordinator);
    const before = (await call(coordinator, "/ranges")).body as unknown as { totals: { bytesPlanned: number }; planned: number };

    await call(coordinator, "/pause", { by: "operator@example.com" });
    await call(coordinator, "/resume", { by: "operator@example.com" });

    const after = (await call(coordinator, "/ranges")).body as unknown as { totals: { bytesPlanned: number }; planned: number };
    expect(after.planned).toBe(before.planned);
    expect(after.totals.bytesPlanned).toBe(before.totals.bytesPlanned);
    expect(after.totals.bytesPlanned).toBe(SIZE);
  });
});

describe("coordinator: stranded leases are found from the plan, not from a worker record", () => {
  test("a leased task nobody points at is requeued when its lease expires", async () => {
    const { coordinator, state } = harness();
    await call(coordinator, "/plan", SOLO_PLAN as unknown as Record<string, unknown>);
    const first = (await call(coordinator, "/claim", { workerId: "indexer-worker-00" })).body.task as SwarmTask;

    /*
     * The production shape: the task is still `leased`, the worker record that named it
     * has been cleared (an idle claim did that), there is no queue entry, and — because
     * the deployed coordinator kept no lease index — nothing indexes the lease either.
     */
    state.map.set("workers", {});
    state.map.delete("leases");
    const stored = state.map.get(`t:${first.id}`) as SwarmTask;
    state.map.set(`t:${first.id}`, { ...stored, leaseUntil: Date.now() - 60_000 });

    const second = await call(coordinator, "/claim", { workerId: "indexer-worker-01" });
    const task = second.body.task as SwarmTask;
    expect(task).not.toBeNull();
    expect(task.id).toBe(first.id);
    expect(task.attempts).toBe(2);
    expect(task.leaseOwner).toBe("indexer-worker-01");
  });

  test("a task that reaches maxAttempts is parked, not silently retried forever", async () => {
    const { coordinator, state } = harness();
    await call(coordinator, "/plan", SOLO_PLAN as unknown as Record<string, unknown>);
    const first = (await call(coordinator, "/claim", { workerId: "indexer-worker-00" })).body.task as SwarmTask;
    state.map.set("workers", {});
    state.map.delete("leases");
    const stored = state.map.get(`t:${first.id}`) as SwarmTask;
    state.map.set(`t:${first.id}`, { ...stored, attempts: 4, leaseUntil: Date.now() - 60_000 });

    const next = await call(coordinator, "/claim", { workerId: "indexer-worker-01" });
    expect(next.body.task).toBeNull();
    expect(next.body.stop).toBe("idle");
    const storedAfter = state.map.get(`t:${first.id}`) as SwarmTask;
    expect(storedAfter.state).toBe("parked");
    const status = (await call(coordinator, "/status")).body as unknown as { tasks: { parked: number } };
    expect(status.tasks.parked).toBe(1);
  });

  test("resume sweeps a lease that was interrupted before the pause existed", async () => {
    const { coordinator, state } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    const first = (await call(coordinator, "/claim", { workerId: "indexer-worker-00" })).body.task as SwarmTask;
    // Legacy state: paused by the old endpoint, which only wrote the stage.
    await call(coordinator, "/pause", { by: "operator@example.com", release: false });
    state.map.set("workers", {});
    await call(coordinator, "/resume", { by: "operator@example.com" });

    const resumed = await call(coordinator, "/claim", { workerId: "indexer-worker-02" });
    expect((resumed.body.task as SwarmTask).id).toBe(first.id);
  });
});

describe("coordinator: an operator can limit the workforce", () => {
  test("a worker above the active count is retired instead of given work", async () => {
    const { coordinator } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    const sized = await call(coordinator, "/workers", { count: 1 });
    expect(sized.body.workers).toBe(1);

    const retired = await call(coordinator, "/claim", { workerId: "indexer-worker-02" });
    expect(retired.body.task).toBeNull();
    expect(retired.body.stop).toBe("retired");

    const allowed = await call(coordinator, "/claim", { workerId: "indexer-worker-00" });
    expect((allowed.body.task as SwarmTask).kind).toBe("block");
    const status = (await call(coordinator, "/status")).body as unknown as { workersAuthorised: number };
    expect(status.workersAuthorised).toBe(1);
  });

  test("refuses a workforce outside the identity space", async () => {
    const { coordinator } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    for (const count of [0, SWARM_WORKER_COUNT + 1, 2.5]) {
      const response = await call(coordinator, "/workers", { count });
      expect(response.status).toBe(500);
    }
  });
});

describe("coordinator: a range is complete only when it covered its whole span", () => {
  test("refuses a completion whose coverage differs from the lease", async () => {
    const { coordinator, state } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    await finishBlocks(coordinator);
    const claim = await call(coordinator, "/claim", { workerId: "indexer-worker-00" });
    const task = claim.body.task as SwarmTask;

    const short = await call(coordinator, "/complete", {
      workerId: "indexer-worker-00",
      taskId: task.id,
      coverage: { start: task.start, end: task.end - 1 },
      result: { rows: 1, rejected: 0, segments: 1, segmentBytes: 10, bytesRead: task.end - task.start, classA: 1, classB: 0 },
    });
    expect(short.status).toBe(500);
    expect(String((short.body.error as { message?: string } | undefined)?.message)).toContain("partial range");

    const stored = state.map.get(`t:${task.id}`) as SwarmTask;
    expect(stored.state).toBe("leased");
    const status = (await call(coordinator, "/status")).body as unknown as { tasks: { rangesDone: number } };
    expect(status.tasks.rangesDone).toBe(0);
  });
});

describe("coordinator: the range audit reports the real outstanding work", () => {
  test("lists every range with bytes, state and attempts, and flags an oversized one", async () => {
    const { coordinator, state } = harness();
    await call(coordinator, "/plan", PLAN as unknown as Record<string, unknown>);
    await finishBlocks(coordinator);

    // Make one planned range the shape production actually has: > 512 MiB, which no
    // 128 MiB plan produces unless a cut was impossible for a very long stretch.
    const ranges = state.map.get("ranges:csv1") as { index: number; start: number; end: number; baseLine: number }[];
    state.map.set("ranges:csv1", [
      { ...ranges[0]!, start: 0, end: 900 * 1024 * 1024 },
      ...ranges.slice(1).map((range) => ({ ...range, start: range.start + 900 * 1024 * 1024, end: range.end + 900 * 1024 * 1024 })),
    ]);

    const audit = (await call(coordinator, "/ranges", {})).body as unknown as {
      planned: number;
      counts: Record<string, number>;
      totals: { bytesPlanned: number; bytesDone: number; oversized: number };
      ranges: { id: string; bytes: number; state: string; attempts: number; oversized: boolean }[];
    };
    expect(audit.planned).toBe(3);
    expect(audit.counts.pending).toBe(3);
    expect(audit.totals.oversized).toBe(1);
    expect(audit.totals.bytesDone).toBe(0);
    expect(audit.ranges[0]!.id).toBe("range:csv1:000000");
    expect(audit.ranges[0]!.oversized).toBe(true);
    expect(audit.ranges[0]!.bytes).toBe(900 * 1024 * 1024);
    expect(audit.ranges[0]!.state).toBe("pending");
    expect(audit.ranges[0]!.attempts).toBe(0);
  });
});

/* ---------------------------------- worker --------------------------------- */

const CLAIM_PLAN = { version: VERSION, partitions: 4, blockBytes: BLOCK_BYTES };

function fakeContainer(running: boolean) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const container = {
    running,
    destroyed: false,
    startCalls: 0,
    start() {
      container.startCalls += 1;
      container.running = true;
    },
    async setInactivityTimeout() {
      return undefined;
    },
    async destroy() {
      container.destroyed = true;
      container.running = false;
    },
    getTcpPort() {
      return {
        async fetch(input: string, init?: RequestInit) {
          calls.push({ url: input, init });
          if (input.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
          return new Response(JSON.stringify({ started: true }), { status: 202 });
        },
      };
    },
  };
  return { container, calls };
}

function fakeCoordinator(options: {
  heartbeat?: unknown;
  claim?: unknown;
  release?: unknown | (() => never);
}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      async fetch(input: string, init?: RequestInit) {
        const path = new URL(input).pathname;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ path, body });
        if (path === "/heartbeat") return new Response(JSON.stringify(options.heartbeat ?? { ok: true, stage: "ingest" }), { status: 200 });
        if (path === "/claim") return new Response(JSON.stringify(options.claim ?? { task: null, stage: "ingest", stop: "idle" }), { status: 200 });
        if (path === "/release") {
          if (typeof options.release === "function") return (options.release as () => never)();
          return new Response(JSON.stringify(options.release ?? { ok: true, requeued: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
  };
  return { namespace, calls };
}

function workerHarness(init: {
  container: ReturnType<typeof fakeContainer>["container"];
  coordinator: ReturnType<typeof fakeCoordinator>["namespace"];
  bucket?: FakeR2Bucket;
  current?: unknown;
}) {
  const bucket = init.bucket ?? new FakeR2Bucket();
  const state = fakeDoState({
    container: init.container,
    seed: {
      workerId: "indexer-worker-04",
      plan: CLAIM_PLAN,
      ...(init.current ? { current: init.current } : {}),
    },
  });
  const worker = new IndexerWorker(state as unknown as DurableObjectState, {
    COMPANY_DATA: bucket as unknown as R2Bucket,
    INDEXING_COORDINATOR: init.coordinator as unknown as DurableObjectNamespace,
  });
  return { state, bucket, worker };
}

const IN_FLIGHT = { id: "range:csv1:000002", kind: "range" as const, args: [], startedAt: Date.now(), start: 2048, end: 4096 };

describe("worker: a pause reaches the container before the task does", () => {
  test("releases the lease, destroys the container and arms no alarm", async () => {
    const { container } = fakeContainer(true);
    const { namespace, calls } = fakeCoordinator({ heartbeat: { ok: true, stage: "paused", stop: "paused" } });
    const { state, worker } = workerHarness({ container, coordinator: namespace, current: IN_FLIGHT });

    const response = await worker.fetch(
      new Request("https://worker/pump", { method: "POST", body: JSON.stringify({ workerId: "indexer-worker-04" }) }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.stop).toBe("paused");
    expect(body.releasedTaskId).toBe(IN_FLIGHT.id);
    expect(body.releaseConfirmed).toBe(true);
    expect(body.containerDestroyed).toBe(true);
    expect((container as unknown as { destroyed: boolean }).destroyed).toBe(true);
    // The task was never polled, never failed and never completed: nothing was lost.
    expect(calls.some((call) => call.path === "/complete")).toBe(false);
    expect(calls.some((call) => call.path === "/fail")).toBe(false);
    expect(calls.find((call) => call.path === "/release")!.body).toMatchObject({ taskId: IN_FLIGHT.id });
    // No alarm means the paused worker cannot wake itself and start the container again.
    expect(state.alarms).toHaveLength(0);
    expect(state.map.get("held")).toBe("paused");
  });

  test("a later alarm cannot restart processing while the coordinator is paused", async () => {
    const { container } = fakeContainer(true);
    const { namespace, calls } = fakeCoordinator({ heartbeat: { ok: true, stage: "paused", stop: "paused" } });
    const { state, worker } = workerHarness({ container, coordinator: namespace, current: IN_FLIGHT });

    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: JSON.stringify({ workerId: "indexer-worker-04" }) }));
    await worker.alarm();

    expect((container as unknown as { startCalls: number }).startCalls).toBe(0);
    expect((container as unknown as { running: boolean }).running).toBe(false);
    expect(calls.some((call) => call.path === "/claim")).toBe(false);
    expect(state.alarms).toHaveLength(0);
  });

  test("a retired worker stops instead of claiming, so 'four workers' means four", async () => {
    const { container } = fakeContainer(false);
    const { namespace } = fakeCoordinator({ heartbeat: { ok: true, stage: "ingest" }, claim: { task: null, stage: "ingest", stop: "retired" } });
    const { worker, state } = workerHarness({ container, coordinator: namespace });

    const body = (await (
      await worker.fetch(new Request("https://worker/pump", { method: "POST", body: JSON.stringify({ workerId: "indexer-worker-04" }) }))
    ).json()) as Record<string, unknown>;
    expect(body.stop).toBe("retired");
    expect((container as unknown as { startCalls: number }).startCalls).toBe(0);
    expect(state.alarms).toHaveLength(0);
  });

  test("an unreachable coordinator does not destroy a healthy running range", async () => {
    const { container } = fakeContainer(true);
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch(input: string) {
          if (new URL(input).pathname === "/heartbeat") throw new Error("coordinator unavailable");
          if (new URL(input).pathname === "/release") return new Response(JSON.stringify({ ok: true }), { status: 200 });
          return new Response(JSON.stringify({ task: null, stop: "idle" }), { status: 200 });
        },
      }),
    };
    const { worker } = workerHarness({ container, coordinator: namespace as never, current: IN_FLIGHT });

    // The container answers that the task is still running.
    container.getTcpPort = () => ({
      async fetch(input: string) {
        if (input.endsWith("/health")) return new Response("{}", { status: 200 });
        return new Response(JSON.stringify({ task: { running: true } }), { status: 200 });
      },
    });
    const body = (await (
      await worker.fetch(new Request("https://worker/pump", { method: "POST", body: JSON.stringify({ workerId: "indexer-worker-04" }) }))
    ).json()) as Record<string, unknown>;
    expect(body.running).toBe(IN_FLIGHT.id);
    expect((container as unknown as { destroyed: boolean }).destroyed).toBe(false);
  });
});

describe("worker: the stop route reports what actually happened", () => {
  test("destroys the container and confirms the lease was handed back", async () => {
    const { container } = fakeContainer(true);
    const { namespace, calls } = fakeCoordinator({});
    const { worker, state } = workerHarness({ container, coordinator: namespace, current: IN_FLIGHT });

    const response = await worker.fetch(new Request("https://worker/stop", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      workerId: "indexer-worker-04",
      ok: true,
      containerRunningBefore: true,
      containerDestroyed: true,
      releasedTaskId: IN_FLIGHT.id,
      releaseConfirmed: true,
      alarmCleared: true,
    });
    expect((container as unknown as { destroyed: boolean }).destroyed).toBe(true);
    expect(calls.find((call) => call.path === "/release")).toBeDefined();
    expect(state.alarms).toHaveLength(0);
  });

  test("reports a failed release instead of a silent success", async () => {
    const { container } = fakeContainer(true);
    const { namespace } = fakeCoordinator({
      release: () => {
        throw new Error("coordinator unreachable");
      },
    });
    const { worker } = workerHarness({ container, coordinator: namespace, current: IN_FLIGHT });

    const response = await worker.fetch(new Request("https://worker/stop", { method: "POST", body: "{}" }));
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.releaseConfirmed).toBe(false);
    expect(String(body.error)).toContain("coordinator unreachable");
    // The container still stops: the lease expiry recovers the task, not the container.
    expect(body.containerDestroyed).toBe(true);
  });

  test("reports a container that refused to be destroyed", async () => {
    const { container } = fakeContainer(true);
    (container as unknown as { destroy: () => Promise<void> }).destroy = async () => {
      throw new Error("container not running");
    };
    const { namespace } = fakeCoordinator({});
    const { worker } = workerHarness({ container, coordinator: namespace, current: IN_FLIGHT });

    const response = await worker.fetch(new Request("https://worker/stop", { method: "POST", body: "{}" }));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("container not running");
  });
});

describe("worker: committed range output is never thrown away", () => {
  const manifestKey = cloudKeys.chunkManifest(VERSION, "csv1", 2);
  const rangeClaim = {
    task: {
      id: "range:csv1:000002",
      kind: "range",
      sourceId: "csv1",
      index: 2,
      start: 2048,
      end: 4096,
      baseLine: 41,
      state: "leased",
      attempts: 1,
    },
    stage: "ingest",
    plan: CLAIM_PLAN,
  };

  test("a manifest without a result object completes instead of failing", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes(
      manifestKey,
      Buffer.from(
        JSON.stringify({
          complete: true,
          range: { start: 2048, end: 4096 },
          rows: 12,
          rejected: 1,
          segments: [
            { partition: 1, key: "k1", bytes: 100, rows: 5, sha256: "a" },
            { partition: 2, key: "k2", bytes: 200, rows: 7, sha256: "b" },
          ],
          rejectedKey: "rej",
        }),
        "utf8",
      ),
    );
    const { container } = fakeContainer(true);
    const { namespace } = fakeCoordinator({ claim: rangeClaim });
    const { worker } = workerHarness({ container, coordinator: namespace, bucket });
    container.getTcpPort = () => ({
      async fetch(input: string) {
        if (input.endsWith("/health")) return new Response("{}", { status: 200 });
        return new Response(JSON.stringify({ task: { running: false, exitCode: 0, signal: null } }), { status: 200 });
      },
    });

    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const spy = namespace as unknown as { get: () => { fetch: (input: string, init?: RequestInit) => Promise<Response> } };
    const original = spy.get;
    spy.get = () => {
      const stub = original();
      return {
        fetch: async (input: string, init?: RequestInit) => {
          const path = new URL(input).pathname;
          if (init?.body) calls.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
          return stub.fetch(input, init);
        },
      };
    };

    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: JSON.stringify({ workerId: "indexer-worker-04" }) }));
    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: "{}" }));

    const complete = calls.find((call) => call.path === "/complete");
    expect(complete).toBeDefined();
    expect(complete!.body).toMatchObject({
      taskId: "range:csv1:000002",
      coverage: { start: 2048, end: 4096 },
      result: { rows: 12, rejected: 1, segments: 2, segmentBytes: 300, bytesRead: 2048 },
    });
    expect(calls.some((call) => call.path === "/fail")).toBe(false);
  });

  test("a manifest that stops short of the lease is failed, never completed", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes(
      manifestKey,
      Buffer.from(JSON.stringify({ complete: true, range: { start: 2048, end: 3000 }, rows: 3, rejected: 0, segments: [] }), "utf8"),
    );
    const { container } = fakeContainer(true);
    const { namespace } = fakeCoordinator({ claim: rangeClaim });
    const { worker } = workerHarness({ container, coordinator: namespace, bucket });
    container.getTcpPort = () => ({
      async fetch(input: string) {
        if (input.endsWith("/health")) return new Response("{}", { status: 200 });
        return new Response(JSON.stringify({ task: { running: false, exitCode: 0, signal: null } }), { status: 200 });
      },
    });

    const completed: unknown[] = [];
    const failures: unknown[] = [];
    const spy = namespace as unknown as { get: () => { fetch: (input: string, init?: RequestInit) => Promise<Response> } };
    const original = spy.get;
    spy.get = () => {
      const stub = original();
      return {
        fetch: async (input: string, init?: RequestInit) => {
          const path = new URL(input).pathname;
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
          if (path === "/complete") completed.push(body);
          if (path === "/fail") failures.push(body);
          return stub.fetch(input, init);
        },
      };
    };

    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: JSON.stringify({ workerId: "indexer-worker-04" }) }));
    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: "{}" }));

    expect(completed).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(String((failures[0] as { error: string }).error)).toContain("partial range");
  });
});
