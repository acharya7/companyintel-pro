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

  test("runs a partition merge with the ref base it was assigned", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes(
      `cloud/jobs/${VERSION}/partitions/0007.json`,
      Buffer.from(JSON.stringify({ partition: 7, rows: 120, companies: 118, contacts: 300, shardParts: 41, objectBytes: 9000 }), "utf8"),
    );
    const { container, calls: containerCalls } = fakeContainer({ running: true, health: 200 });
    const completed: unknown[] = [];
    const { namespace } = fakeCoordinator({
      claim: [
        {
          task: {
            id: "merge_partition:all:000007",
            kind: "merge_partition",
            sourceId: "all",
            index: 7,
            partition: 7,
            refBase: 9000,
            refCapacity: 1000,
            start: 0,
            end: 0,
            state: "leased",
            attempts: 1,
          },
          stage: "merge_partitions",
          plan: PLAN,
        },
      ],
      complete: completed,
    });
    const state = fakeDoState({ container });
    const worker = new IndexerWorker(state as unknown as DurableObjectState, {
      COMPANY_DATA: bucket as unknown as R2Bucket,
      INDEXING_COORDINATOR: namespace as unknown as DurableObjectNamespace,
    });

    await worker.fetch(
      new Request("https://worker/pump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "indexer-worker-02" }),
      }),
    );
    const args = (JSON.parse(String(containerCalls.find((call) => call.url.endsWith("/task"))!.init!.body)) as { args: string[] }).args;
    expect(args[0]).toBe("merge-partition");
    expect(args[args.indexOf("--partition") + 1]).toBe("7");
    expect(args[args.indexOf("--ref-base") + 1]).toBe("9000");

    container.getTcpPort = () => ({
      async fetch(input: string) {
        if (input.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response(JSON.stringify({ task: { running: false, exitCode: 0, signal: null } }), { status: 200 });
      },
    });
    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: "{}" }));
    expect(completed[0]).toMatchObject({ taskId: "merge_partition:all:000007" });
    // Merging must not inflate the ingest row count: the ranges already counted them.
    expect((completed[0] as { result: { rows: number } }).result.rows).toBe(0);
  });

  test("assembles one shard and reports its own result object", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes(
      `cloud/jobs/${VERSION}/shards/exact/0003.json`,
      Buffer.from(JSON.stringify({ kind: "exact", shard: 3, key: `indexes/${VERSION}/exact/0003.json.gz`, bytes: 2048, sha256: "x", terms: 11, postings: 22, empty: false }), "utf8"),
    );
    const { container, calls: containerCalls } = fakeContainer({ running: true, health: 200 });
    const completed: unknown[] = [];
    const { namespace } = fakeCoordinator({
      claim: [
        {
          task: {
            id: "assemble_shard:exact:000003",
            kind: "assemble_shard",
            sourceId: "exact",
            index: 3,
            shardKind: "exact",
            shard: 3,
            start: 0,
            end: 0,
            state: "leased",
            attempts: 1,
          },
          stage: "assemble_shards",
          plan: PLAN,
        },
      ],
      complete: completed,
    });
    const state = fakeDoState({ container });
    const worker = new IndexerWorker(state as unknown as DurableObjectState, {
      COMPANY_DATA: bucket as unknown as R2Bucket,
      INDEXING_COORDINATOR: namespace as unknown as DurableObjectNamespace,
    });

    await worker.fetch(
      new Request("https://worker/pump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "indexer-worker-04" }),
      }),
    );
    const args = (JSON.parse(String(containerCalls.find((call) => call.url.endsWith("/task"))!.init!.body)) as { args: string[] }).args;
    expect(args).toEqual(["assemble-shard", "--version", VERSION, "--kind", "exact", "--shard", "3"]);

    container.getTcpPort = () => ({
      async fetch(input: string) {
        if (input.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response(JSON.stringify({ task: { running: false, exitCode: 0, signal: null } }), { status: 200 });
      },
    });
    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: "{}" }));
    expect((completed[0] as { result: { note: string } }).result.note).toContain("11 terms");
  });

  test("refuses to report a finalize whose manifest failed validation", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes(
      `manifests/${VERSION}/manifest.json`,
      Buffer.from(JSON.stringify({ version: VERSION, validationPassed: false, counters: { rowsRead: 10 } }), "utf8"),
    );
    const { container } = fakeContainer({ running: true, health: 200 });
    const failures: unknown[] = [];
    const { namespace } = fakeCoordinator({
      claim: [
        {
          task: {
            id: "finalize:all:000000",
            kind: "finalize",
            sourceId: "all",
            index: 0,
            start: 0,
            end: 0,
            state: "leased",
            attempts: 1,
          },
          stage: "finalize",
          plan: PLAN,
        },
      ],
      fail: failures,
    });
    const state = fakeDoState({ container });
    const worker = new IndexerWorker(state as unknown as DurableObjectState, {
      COMPANY_DATA: bucket as unknown as R2Bucket,
      INDEXING_COORDINATOR: namespace as unknown as DurableObjectNamespace,
    });

    await worker.fetch(
      new Request("https://worker/pump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "indexer-worker-05" }),
      }),
    );
    container.getTcpPort = () => ({
      async fetch(input: string) {
        if (input.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response(JSON.stringify({ task: { running: false, exitCode: 0, signal: null } }), { status: 200 });
      },
    });
    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: "{}" }));
    expect(failures).toHaveLength(1);
    expect((failures[0] as { error: string }).error).toContain("validation failed");
  });

  test("reports a validated finalize as the searchable generation", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putBytes(
      `manifests/${VERSION}/manifest.json`,
      Buffer.from(
        JSON.stringify({ version: VERSION, validationPassed: true, counters: { rowsRead: 1234, uniqueCompanies: 50, uniqueContacts: 60 } }),
        "utf8",
      ),
    );
    const { container } = fakeContainer({ running: true, health: 200 });
    const completed: unknown[] = [];
    const { namespace } = fakeCoordinator({
      claim: [
        {
          task: {
            id: "finalize:all:000000",
            kind: "finalize",
            sourceId: "all",
            index: 0,
            start: 0,
            end: 0,
            state: "leased",
            attempts: 1,
          },
          stage: "finalize",
          plan: PLAN,
        },
      ],
      complete: completed,
    });
    const state = fakeDoState({ container });
    const worker = new IndexerWorker(state as unknown as DurableObjectState, {
      COMPANY_DATA: bucket as unknown as R2Bucket,
      INDEXING_COORDINATOR: namespace as unknown as DurableObjectNamespace,
    });

    await worker.fetch(
      new Request("https://worker/pump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "indexer-worker-06" }),
      }),
    );
    container.getTcpPort = () => ({
      async fetch(input: string) {
        if (input.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response(JSON.stringify({ task: { running: false, exitCode: 0, signal: null } }), { status: 200 });
      },
    });
    await worker.fetch(new Request("https://worker/pump", { method: "POST", body: "{}" }));
    expect(completed[0]).toMatchObject({ searchable: { rows: 1234, companies: 50, contacts: 60 } });
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
