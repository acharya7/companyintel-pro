/**
 * The container must stay alive for as long as the job runs — and recover when it
 * does not.
 *
 * Cloudflare stops a container once its Durable Object has been inactive for the
 * inactivity timeout. The Worker's start route answers 202 and goes idle, so without
 * a timeout the platform is free to stop the instance right after the first chunk —
 * which is what staging showed. The documented keep-alive is
 * `ctx.container.setInactivityTimeout()`, renewed by DO activity.
 *
 * The alarm does two things: it renews the window while `/health` reports a running
 * job, and it restarts a job whose last run stopped without finishing (interrupted,
 * terminated, failed, or a heartbeat that went stale), with bounded attempts and a
 * backoff. That is what makes a multi-hour run independent of a browser tab or a
 * human pressing Resume. R2 is authoritative; the container is replaceable.
 */

import { describe, expect, test } from "bun:test";

import { IndexerContainer } from "../worker/src/indexer-container";
import type { EnvWithContainer } from "../worker/src/indexer-container";
import { FakeR2Bucket } from "./helpers/fake-r2";

interface FakeContainer {
  running: boolean;
  started: number;
  fetched: string[];
  jobs: string[];
  timeouts: number[];
  start(): void;
  getTcpPort(port: number): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  setInactivityTimeout(durationMs: number | bigint): Promise<void>;
}

interface FakeOptions {
  jobRunning?: boolean;
  healthThrows?: boolean;
  timeoutThrows?: boolean;
  jobStatus?: number;
}

function fakeState(options: FakeOptions = {}) {
  const container: FakeContainer = {
    running: true,
    started: 0,
    fetched: [],
    jobs: [],
    timeouts: [],
    start() {
      container.running = true;
      container.started += 1;
    },
    getTcpPort() {
      return {
        fetch: async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          container.fetched.push(url);
          if (url.endsWith("/health")) {
            if (options.healthThrows) throw new Error("connection refused");
            return Response.json({ ok: true, job: { running: options.jobRunning ?? true } });
          }
          const body = input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "";
          container.jobs.push(body);
          return Response.json({ started: true, pid: 7 }, { status: options.jobStatus ?? 202 });
        },
      };
    },
    async setInactivityTimeout(durationMs) {
      if (options.timeoutThrows) throw new Error("keep-alive rejected");
      container.timeouts.push(Number(durationMs));
    },
  };
  const values = new Map<string, unknown>();
  const state = {
    container,
    storage: {
      alarmAt: null as number | null,
      async setAlarm(at: number) {
        state.storage.alarmAt = at;
      },
      async get<T>(key: string): Promise<T | undefined> {
        return values.get(key) as T | undefined;
      },
      async put(key: string, value: unknown) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    },
    values,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
  return { state, container };
}

function bucketWith(seed: Record<string, unknown> = {}): FakeR2Bucket {
  const bucket = new FakeR2Bucket();
  for (const [key, value] of Object.entries(seed)) {
    bucket.putBytes(key, Buffer.from(JSON.stringify(value), "utf8"), { contentType: "application/json" });
  }
  return bucket;
}

const baseEnv = { ENVIRONMENT: "development", CONTAINER_JOB_INACTIVITY_MS: "60000", CONTAINER_KEEPALIVE_MS: "1000" };

function env(bucket: FakeR2Bucket, overrides: Record<string, unknown> = {}): EnvWithContainer {
  return { ...baseEnv, COMPANY_DATA: bucket as unknown as R2Bucket, ...overrides } as unknown as EnvWithContainer;
}

function jobState(overrides: Record<string, unknown> = {}) {
  return {
    engine: "cloud-pass1-v1",
    jobId: "stg-watchdog",
    version: "stg-watchdog",
    stage: "pass1",
    startedAt: "2026-10-21T06:58:25.828Z",
    updatedAt: new Date().toISOString(),
    mode: "benchmark",
    partitions: 16,
    sources: [],
    totals: { rowsRead: 0, rowsRejected: 0, rowsIndexed: 0, segments: 0, segmentBytes: 0, sourceBytesRead: 0 },
    rate: { rowsPerSecond: null, bytesPerSecond: null, etaSeconds: null },
    accounting: { classA: 0, classB: 0, bytesRead: 0, bytesWritten: 0, estimatedUsd: 0, containerSeconds: 0, containerUsd: 0 },
    checkpoint: null,
    errors: [],
    ...overrides,
  };
}

const ARGS = ["benchmark", "--version", "stg-watchdog", "--max-source-mb", "16", "--partitions", "16"];

function jobRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: "stg-watchdog",
    stage: "pass1",
    args: ARGS,
    attempts: 0,
    lastStartAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    ...overrides,
  };
}

describe("IndexerContainer keep-alive", () => {
  test("accepting a detached job sets an inactivity timeout, remembers the job and arms the alarm", async () => {
    const { state, container } = fakeState();
    const r2 = bucketWith();
    // Cold start: the constructor has nothing to restore, so exactly one timeout is
    // expected from accepting the job.
    container.running = false;
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env(r2));

    const response = await durable.fetch(
      new Request("http://container/job", {
        method: "POST",
        body: JSON.stringify({ args: ARGS, detach: true }),
      }),
    );

    expect(response.status).toBe(202);
    expect(container.timeouts).toEqual([60_000]);
    expect(state.storage.alarmAt).not.toBeNull();
    const remembered = state.values.get("job") as { version: string; args: string[]; attempts: number };
    expect(remembered.version).toBe("stg-watchdog");
    expect(remembered.args).toEqual(ARGS);
    expect(remembered.attempts).toBe(0);
  });

  test("the alarm renews while the job is alive and stops once the stage finished", async () => {
    const { state, container } = fakeState({ jobRunning: true });
    const r2 = bucketWith({
      "cloud/jobs/stg-watchdog/state.json": jobState({ stage: "pass1" }),
      "cloud/jobs/stg-watchdog/run.json": { outcome: "running", heartbeatAt: new Date().toISOString(), version: "stg-watchdog" },
    });
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env(r2));
    await state.storage.put("job", jobRecord());
    container.timeouts.length = 0;
    state.storage.alarmAt = null;

    await durable.alarm();
    expect(container.timeouts).toEqual([60_000]);
    expect(state.storage.alarmAt).not.toBeNull();
    expect(container.jobs).toEqual([]);

    // A completed Pass 1 means nothing to keep alive: the record is dropped and the
    // container is left to sleep.
    const finished = fakeState({ jobRunning: true });
    const doneBucket = bucketWith({
      "cloud/jobs/stg-watchdog/state.json": jobState({ stage: "pass1-complete" }),
      "cloud/jobs/stg-watchdog/run.json": { outcome: "completed", heartbeatAt: new Date().toISOString() },
    });
    const doneDo = new IndexerContainer(finished.state as unknown as DurableObjectState, env(doneBucket));
    await finished.state.storage.put("job", jobRecord());
    finished.container.timeouts.length = 0;
    finished.state.storage.alarmAt = null;
    await doneDo.alarm();
    expect(finished.container.timeouts).toEqual([]);
    expect(finished.state.storage.alarmAt).toBeNull();
    expect(finished.state.values.has("job")).toBe(false);
  });

  test("an interrupted run is resumed automatically from its checkpoint", async () => {
    const { state, container } = fakeState();
    const r2 = bucketWith({
      "cloud/jobs/stg-watchdog/state.json": jobState({ stage: "paused", interruption: { at: "2026-10-21T07:00:19.518Z", outcome: "interrupted", reason: "the container was stopped (SIGTERM)" } }),
      "cloud/jobs/stg-watchdog/control.json": { version: 1, pause: false, abort: false, approvedFullRun: false, updatedAt: "2026-10-21T07:00:00.000Z" },
      "cloud/jobs/stg-watchdog/run.json": { outcome: "interrupted", heartbeatAt: "2026-10-21T07:00:19.518Z", version: "stg-watchdog" },
    });
    // The instance was stopped with the job.
    container.running = false;
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env(r2));
    await state.storage.put("job", jobRecord());
    state.storage.alarmAt = null;

    await durable.alarm();

    // It restarted the container and re-issued the original arguments, detached.
    expect(container.started).toBe(1);
    expect(container.jobs).toHaveLength(1);
    const posted = JSON.parse(container.jobs[0]!) as { args: string[]; detach: boolean };
    expect(posted.args).toEqual(ARGS);
    expect(posted.detach).toBe(true);
    const remembered = state.values.get("job") as { attempts: number };
    expect(remembered.attempts).toBe(1);
    expect(state.storage.alarmAt).not.toBeNull();
  });

  test("a job that is merely quiet is left alone; a stale heartbeat is recovered", async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const quiet = fakeState({ jobRunning: true });
    const quietBucket = bucketWith({
      "cloud/jobs/stg-watchdog/state.json": jobState({ stage: "pass1" }),
      "cloud/jobs/stg-watchdog/run.json": { outcome: "running", heartbeatAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const quietDo = new IndexerContainer(quiet.state as unknown as DurableObjectState, env(quietBucket));
    await quiet.state.storage.put("job", jobRecord());
    quiet.state.storage.alarmAt = null;
    await quietDo.alarm();
    expect(quiet.container.jobs).toEqual([]);

    // `outcome: running` with an hour-old heartbeat is a process that died without
    // recording anything (the exact staging shape).
    const stale = fakeState();
    const staleBucket = bucketWith({
      "cloud/jobs/stg-watchdog/state.json": jobState({ stage: "pass1", updatedAt: old }),
      "cloud/jobs/stg-watchdog/run.json": { outcome: "running", heartbeatAt: old },
    });
    const staleDo = new IndexerContainer(stale.state as unknown as DurableObjectState, env(staleBucket));
    await stale.state.storage.put("job", jobRecord());
    stale.state.storage.alarmAt = null;
    await staleDo.alarm();
    expect(stale.container.jobs).toHaveLength(1);
  });

  test("operator pause, abort and the job budget are never overridden", async () => {
    for (const control of [
      { version: 1, pause: true, abort: false, approvedFullRun: false, updatedAt: "2026-10-21T07:00:00.000Z" },
      { version: 1, pause: false, abort: true, approvedFullRun: false, updatedAt: "2026-10-21T07:00:00.000Z" },
    ]) {
      const { state, container } = fakeState();
      const r2 = bucketWith({
        "cloud/jobs/stg-watchdog/state.json": jobState({ stage: "paused" }),
        "cloud/jobs/stg-watchdog/run.json": { outcome: "interrupted", heartbeatAt: new Date().toISOString() },
        "cloud/jobs/stg-watchdog/control.json": control,
      });
      const durable = new IndexerContainer(state as unknown as DurableObjectState, env(r2));
      await state.storage.put("job", jobRecord());
      await durable.alarm();
      expect(container.jobs).toEqual([]);
      expect(state.values.has("job")).toBe(false);
    }

    const { state, container } = fakeState();
    const r2 = bucketWith({
      "cloud/jobs/stg-watchdog/state.json": jobState({
        stage: "paused",
        mode: "full",
        accounting: { classA: 0, classB: 0, bytesRead: 0, bytesWritten: 0, estimatedUsd: 20, containerSeconds: 0, containerUsd: 21 },
      }),
      "cloud/jobs/stg-watchdog/run.json": { outcome: "interrupted", heartbeatAt: new Date().toISOString() },
    });
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env(r2, { CLOUD_JOB_BUDGET_USD: "30" }));
    await state.storage.put("job", jobRecord());
    await durable.alarm();
    expect(container.jobs).toEqual([]);
    expect(state.values.has("job")).toBe(false);
  });

  test("automatic resumes stop at the configured limit and can be disabled", async () => {
    const stopped = () =>
      bucketWith({
        "cloud/jobs/stg-watchdog/state.json": jobState({ stage: "paused" }),
        "cloud/jobs/stg-watchdog/run.json": { outcome: "terminated", heartbeatAt: new Date().toISOString() },
      });

    const exhausted = fakeState();
    const exhaustedDo = new IndexerContainer(
      exhausted.state as unknown as DurableObjectState,
      env(stopped(), { CONTAINER_MAX_RESUMES: "2" }),
    );
    await exhausted.state.storage.put("job", jobRecord({ attempts: 2 }));
    await exhaustedDo.alarm();
    expect(exhausted.container.jobs).toEqual([]);
    expect(exhausted.state.values.has("job")).toBe(false);

    const disabled = fakeState();
    const disabledDo = new IndexerContainer(
      disabled.state as unknown as DurableObjectState,
      env(stopped(), { CONTAINER_AUTO_RESUME: "false" }),
    );
    await disabled.state.storage.put("job", jobRecord());
    await disabledDo.alarm();
    expect(disabled.container.jobs).toEqual([]);
  });

  test("a failed resume backs off instead of retrying immediately", async () => {
    const { state, container } = fakeState({ jobStatus: 500 });
    const r2 = bucketWith({
      "cloud/jobs/stg-watchdog/state.json": jobState({
        stage: "failed",
        interruption: { at: new Date().toISOString(), outcome: "failed", reason: "simulated R2 outage" },
      }),
      "cloud/jobs/stg-watchdog/run.json": { outcome: "failed", heartbeatAt: new Date().toISOString() },
    });
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env(r2));
    await state.storage.put("job", jobRecord());
    state.storage.alarmAt = null;
    const before = Date.now();

    await durable.alarm();

    expect(container.jobs).toHaveLength(1);
    // The next attempt is at least one keep-alive interval away, not immediate.
    expect(state.storage.alarmAt).toBeGreaterThanOrEqual(before + 1_000);
  });

  test("a probe failure during recovery backs off instead of declaring the job finished", async () => {
    const { state, container } = fakeState({ healthThrows: true });
    const r2 = bucketWith({
      "cloud/jobs/stg-watchdog/state.json": jobState({ stage: "paused" }),
      "cloud/jobs/stg-watchdog/run.json": { outcome: "interrupted", heartbeatAt: new Date().toISOString() },
    });
    const durable = new IndexerContainer(
      state as unknown as DurableObjectState,
      env(r2, { CONTAINER_READY_TIMEOUT_MS: "300" }),
    );
    await state.storage.put("job", jobRecord());
    container.timeouts.length = 0;
    state.storage.alarmAt = null;

    await durable.alarm();
    // Readiness never answered: no job was posted, the attempt is still recorded and
    // the next alarm is scheduled. Nothing was marked as finished.
    expect(container.jobs).toEqual([]);
    expect(state.values.has("job")).toBe(true);
    expect(state.storage.alarmAt).not.toBeNull();
  });

  test("a rejected keep-alive never turns an accepted start into an error", async () => {
    const { state } = fakeState({ timeoutThrows: true });
    const durable = new IndexerContainer(state as unknown as DurableObjectState, env(bucketWith()));
    const response = await durable.fetch(
      new Request("http://container/job", { method: "POST", body: JSON.stringify({ args: ["benchmark"], detach: true }) }),
    );
    expect(response.status).toBe(202);
  });

  test("a constructor after a DO restart restores the timeout and the alarm", async () => {
    const flush = () => new Promise((done) => setTimeout(done, 0));
    const { state, container } = fakeState();
    new IndexerContainer(state as unknown as DurableObjectState, env(bucketWith()));
    await flush();
    expect(container.timeouts).toEqual([60_000]);
    expect(state.storage.alarmAt).toBeNull();

    const { state: withJob, container: withJobContainer } = fakeState();
    await withJob.storage.put("job", jobRecord());
    new IndexerContainer(withJob as unknown as DurableObjectState, env(bucketWith()));
    await flush();
    expect(withJobContainer.timeouts).toEqual([60_000]);
    expect(withJob.storage.alarmAt).not.toBeNull();
  });
});
