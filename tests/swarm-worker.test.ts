/**
 * Worker-level behaviour: the identity scheme that makes 16 containers possible, the
 * task lifecycle inside one container, and the shutdown that stops a finished run from
 * billing container time.
 *
 * The container and the coordinator are fakes, but the worker code under test is the
 * real Durable Object class — including the CLI arguments it builds, because a wrong
 * argument (a missing `--base-line`, say) would corrupt row provenance on the real run.
 */

import { describe, expect, test } from "bun:test";

import { SWARM_WORKER_COUNT, swarmKeys, swarmWorkerId, swarmWorkerIds } from "../src/shared/cloud/swarm";
import { IndexerWorker } from "../worker/src/indexer-worker";
import { fakeDoState } from "./helpers/fake-do";
import { FakeR2Bucket } from "./helpers/fake-r2";

const VERSION = "swarm-worker-test";
const PLAN = { version: VERSION, partitions: 256, blockBytes: 64 << 20 };

interface ContainerCall {
  url: string;
  init?: RequestInit;
}

function fakeContainer(state: { running: boolean; health?: number }) {
  const calls: ContainerCall[] = [];
  const container = {
    running: state.running,
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

function fakeCoordinator(responses: { claim: unknown[]; complete?: unknown[]; fail?: unknown[] }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const queue = [...responses.claim];
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      async fetch(input: string, init?: RequestInit) {
        const path = new URL(input).pathname;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ path, body });
        if (path === "/claim") {
          const next = queue.length > 1 ? queue.shift() : queue[0];
          return new Response(JSON.stringify(next), { status: 200 });
        }
        if (path === "/complete") {
          responses.complete?.push(body);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (path === "/fail") {
          responses.fail?.push(body);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
  };
  return { namespace, calls };
}

const RANGE_TASK = {
  id: "range:csv1:000002",
  kind: "range" as const,
  sourceId: "csv1",
  index: 2,
  start: 2048,
  end: 4096,
  baseLine: 41,
  state: "leased" as const,
  attempts: 1,
};

const RANGE_RESULT = {
  rows: 12,
  rejected: 1,
  segments: 3,
  segmentBytes: 4096,
  bytesRead: 2048,
  classA: 4,
  classB: 2,
};

describe("swarm worker identity", () => {
  test("16 deterministic, distinct identities", () => {
    const ids = swarmWorkerIds();
    expect(ids).toHaveLength(SWARM_WORKER_COUNT);
    expect(new Set(ids).size).toBe(SWARM_WORKER_COUNT);
    expect(ids[0]).toBe("indexer-worker-00");
    expect(ids.at(-1)).toBe("indexer-worker-15");
    expect(swarmWorkerId(7)).toBe("indexer-worker-07");
    expect(() => swarmWorkerId(16)).toThrow();
    // The identity is the DO *name*: distinct names are what create 16 instances.
    expect(new Set(ids.map((id) => `swarm:${id}`)).size).toBe(16);
  });
});

describe("swarm worker pump", () => {
  test("starts a claimed range in its own container with the full argument set", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes(swarmKeys.rangeResult(VERSION, "csv1", 2), Buffer.from(JSON.stringify(RANGE_RESULT), "utf8"));
    const { container, calls: containerCalls } = fakeContainer({ running: true, health: 200 });
    const completed: unknown[] = [];
    const { namespace, calls } = fakeCoordinator({
      claim: [{ task: RANGE_TASK, stage: "ingest", plan: PLAN }],
      complete: completed,
    });

    const state = fakeDoState({ container });
    const worker = new IndexerWorker(state as unknown as DurableObjectState, {
      COMPANY_DATA: bucket as unknown as R2Bucket,
      INDEXING_COORDINATOR: namespace as unknown as DurableObjectNamespace,
    });

    const first = await worker.fetch(
      new Request("https://worker/pump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "indexer-worker-03" }),
      }),
    );
    expect(first.status).toBe(200);
    expect((await first.json()) as unknown).toMatchObject({ started: RANGE_TASK.id });

    const task = containerCalls.find((call) => call.url.endsWith("/task"));
    expect(task).toBeDefined();
    const args = (JSON.parse(String(task!.init!.body)) as { args: string[] }).args;
    expect(args.slice(0, 2)).toEqual(["range", "--version"]);
    expect(args).toContain("--base-line");
    expect(args[args.indexOf("--base-line") + 1]).toBe("41");
    expect(args[args.indexOf("--partitions") + 1]).toBe("256");
    expect(args[args.indexOf("--start") + 1]).toBe("2048");

    // The container reports a clean exit; the worker reads the R2 result and reports it.
    container.getTcpPort = () => ({
      async fetch(input: string) {
        if (input.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response(JSON.stringify({ task: { running: false, exitCode: 0, signal: null } }), { status: 200 });
      },
    });
    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: "{}" }));

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ workerId: "indexer-worker-03", taskId: RANGE_TASK.id, result: RANGE_RESULT });
    // The worker heartbeat/claim path was used, never a direct write to the coordinator's state.
    expect(calls.some((call) => call.path === "/complete")).toBe(true);
  });

  test("destroys the container and clears its alarm when the run is complete", async () => {
    const bucket = new FakeR2Bucket();
    const { container } = fakeContainer({ running: true, health: 200 });
    const { namespace } = fakeCoordinator({ claim: [{ task: null, stage: "complete", stop: "complete" }] });
    const state = fakeDoState({ container });
    const worker = new IndexerWorker(state as unknown as DurableObjectState, {
      COMPANY_DATA: bucket as unknown as R2Bucket,
      INDEXING_COORDINATOR: namespace as unknown as DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request("https://worker/pump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "indexer-worker-09" }),
      }),
    );
    expect((await response.json()) as unknown).toMatchObject({ stop: "complete" });
    expect((container as unknown as { destroyed: boolean }).destroyed).toBe(true);
    expect(state.alarms).toHaveLength(0);
  });

  test("arms a delayed alarm instead of stopping when the queue is momentarily empty", async () => {
    const bucket = new FakeR2Bucket();
    const { container } = fakeContainer({ running: true, health: 200 });
    const { namespace } = fakeCoordinator({ claim: [{ task: null, stage: "ingest", stop: "idle" }] });
    const state = fakeDoState({ container });
    const worker = new IndexerWorker(state as unknown as DurableObjectState, {
      COMPANY_DATA: bucket as unknown as R2Bucket,
      INDEXING_COORDINATOR: namespace as unknown as DurableObjectNamespace,
    });

    await worker.fetch(
      new Request("https://worker/pump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "indexer-worker-01" }),
      }),
    );
    expect((container as unknown as { destroyed: boolean }).destroyed).toBe(false);
    expect(state.alarms).toHaveLength(1);
    expect(state.alarms[0]!).toBeGreaterThan(Date.now());
  });
});
