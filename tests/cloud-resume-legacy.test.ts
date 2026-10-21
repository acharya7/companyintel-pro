/**
 * Resume is an action, not a flag.
 *
 * Observed on staging: `POST /api/cloud/jobs/<v>/control {action:"resume"}` cleared
 * `pause`/`abort` and nothing else happened. The job was a benchmark started before
 * the Durable Object recorded a job specification, so there was no saved execution to
 * restart — and a detached job has no process a flag could reach.
 *
 * These tests drive the real admin router against an in-memory R2 binding and a
 * container stub, with a `state.json` shaped exactly like that pre-upgrade job
 * (`mode: benchmark`, `stage: paused`, no `config`, no `run.json`). They require:
 *
 *   - a benchmark whose partial last chunk proves it stopped on its 16 MB bound is
 *     reconciled and advanced to Pass 2 instead of being restarted into a no-op;
 *   - a benchmark that stopped at a whole chunk boundary (so its limit is not
 *     recoverable) is refused rather than guessed, and an explicit limit resumes it
 *     from the verified checkpoints and is remembered;
 *   - a live attempt is left alone, so a second click cannot start a second runner;
 *   - a fresh start route refuses while a run is live (409), not silently duplicate;
 *   - a job with neither `config` nor a checkpoint refuses to be resumed rather than
 *     widening a benchmark into the full corpus.
 */

import { describe, expect, test } from "bun:test";

import { indexingAdmin } from "../worker/src/indexer-admin";
import type { Env } from "../worker/src/env";
import { cloudKeys, type CloudControl, type CloudJobState, type CloudRunStatus } from "../src/shared/cloud/types";
import { FakeR2Bucket } from "./helpers/fake-r2";

const VERSION = "stg-bench-2026-10-21";
const MIB = 1024 * 1024;
const NOW = Date.now();

interface Captured {
  body: { args?: string[]; detach?: boolean };
}

/** A container namespace stub that records the job it was asked to start. */
function container(captured: Captured[], respond: () => Response = () => json(202, { started: true, pid: 4242 })) {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ body: init?.body ? JSON.parse(String(init.body)) : {} });
        return respond();
      },
    }),
  };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function envWith(bucket: FakeR2Bucket, captured: Captured[] = [], respond?: () => Response): Env {
  return {
    COMPANY_DATA: bucket as unknown as R2Bucket,
    ENVIRONMENT: "development",
    DEV_ALLOW_UNAUTHENTICATED: "true",
    STAGING_MODE: "true",
    ACTIVE_MANIFEST_KEY: "staging/active.json",
    INDEXER_CONTAINER: container(captured, respond),
    CLOUD_JOB_BUDGET_USD: "5",
  } as unknown as Env;
}

/** The live pre-upgrade job: no `config`, no `run.json`, paused mid-benchmark. */
function legacyState(overrides: Partial<CloudJobState> = {}): CloudJobState {
  return {
    engine: "cloud-pass1-v1",
    jobId: VERSION,
    version: VERSION,
    stage: "paused",
    startedAt: "2026-10-21T06:58:25.828Z",
    updatedAt: "2026-10-21T07:42:47.345Z",
    mode: "benchmark",
    partitions: 16,
    sources: [
      {
        id: "csv1",
        key: "raw/file1.csv",
        size: 10_223_471_749,
        etag: '"9802eccace4215e92763b71e51248c8c-98"',
        nextOffset: 16_778_741,
        nextLine: 7_793,
        chunks: 1,
        rows: 7_180,
        rejected: 387,
        sourceBytes: 16_778_741,
        segments: 16,
        segmentBytes: 5_023_460,
        complete: false,
      },
      {
        id: "csv2",
        key: "raw/file2.csv",
        size: 54_038_527_871,
        etag: '"050a094261a96474e83e87baa55c39fd-516"',
        nextOffset: 16_777_313,
        nextLine: 28_867,
        chunks: 1,
        rows: 28_298,
        rejected: 567,
        sourceBytes: 16_777_313,
        segments: 16,
        segmentBytes: 5_520_706,
        complete: false,
      },
    ],
    totals: { rowsRead: 36_432, rowsRejected: 954, rowsIndexed: 35_478, segments: 32, segmentBytes: 10_544_166, sourceBytesRead: 33_556_054 },
    rate: { rowsPerSecond: 356.4, bytesPerSecond: 790_406, etaSeconds: 12_913 },
    accounting: { classA: 21, classB: 46, bytesRead: 26_519_268, bytesWritten: 5_056_469, estimatedUsd: 0.000_187, containerSeconds: 21.2, containerUsd: 0.000_425 },
    checkpoint: null,
    errors: [],
    ...overrides,
  };
}

function checkpoint(sourceId: string, nextOffset: number, rows: number) {
  return {
    engine: "cloud-pass1-v1",
    version: VERSION,
    sourceId,
    sourceKey: sourceId === "csv1" ? "raw/file1.csv" : "raw/file2.csv",
    sourceEtag: null,
    sourceSize: sourceId === "csv1" ? 10_223_471_749 : 54_038_527_871,
    chunkBytes: 32 * MIB,
    partitions: 16,
    nextOffset,
    nextLine: 1,
    chunks: 1,
    rows,
    rejected: 0,
    segmentBytes: 1_000,
    segments: 16,
    complete: false,
    updatedAt: "2026-10-21T06:58:51.875Z",
  };
}

function bucketWith(options: { state?: CloudJobState; run?: CloudRunStatus | null; atLimit?: boolean } = {}): FakeR2Bucket {
  const bucket = new FakeR2Bucket();
  const put = (key: string, value: unknown) => bucket.putBytes(key, Buffer.from(JSON.stringify(value), "utf8"), { contentType: "application/json" });
  const state = options.state ?? legacyState();
  put(cloudKeys.state(VERSION), state);
  const atLimit = options.atLimit ?? true;
  // 16 MiB exactly is the bound the live job stopped at (its last chunk crossed it).
  put(cloudKeys.checkpoint(VERSION, "csv1"), checkpoint("csv1", atLimit ? 16 * MIB + 1_525 : 4 * MIB, 7_180));
  put(cloudKeys.checkpoint(VERSION, "csv2"), checkpoint("csv2", atLimit ? 16 * MIB + 97 : 3 * MIB, 28_298));
  if (options.run) put(cloudKeys.runStatus(VERSION), options.run);
  const control: CloudControl = { version: 1, pause: false, abort: false, approvedFullRun: false, updatedAt: "2026-10-21T08:18:35.597Z" };
  put(cloudKeys.control(VERSION), control);
  return bucket;
}

async function post(env: Env, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await indexingAdmin.fetch(
    new Request(`https://app.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const resume = (env: Env) => post(env, `/api/cloud/jobs/${VERSION}/control`, { action: "resume" });

async function stateOf(env: Env): Promise<CloudJobState> {
  const object = await (env.COMPANY_DATA as unknown as { get: (key: string) => Promise<{ json: () => Promise<unknown> } | null> }).get(
    cloudKeys.state(VERSION),
  );
  return (await object!.json()) as CloudJobState;
}

describe("resuming a job started before execution metadata existed", () => {
  test("a bounded benchmark already at its limit is reconciled and advanced to Pass 2", async () => {
    const captured: Captured[] = [];
    const bucket = bucketWith({ atLimit: true });
    const env = envWith(bucket, captured);

    const response = await resume(env);

    expect(response.status).toBe(202);
    expect(response.body.started).toBe(true);
    expect(response.body.stage).toBe("pass2");
    // The original bound is preserved: 16 partitions, --allow-bounded, no full run.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.args).toEqual(["pass2", "--version", VERSION, "--partitions", "16", "--allow-bounded"]);
    // The panel message explains what actually happened.
    expect(String(response.body.message)).toContain("Pass 1 is complete");

    const state = await stateOf(env);
    expect(state.stage).toBe("pass1-complete");
    expect(state.coverage).toBe("bounded");
    expect(state.config).toEqual({
      stage: "pass1",
      mode: "benchmark",
      partitions: 16,
      maxSourceMb: 16,
      chunkMb: 32,
      requestedAt: expect.any(String),
    });
    expect(state.note).toContain("Bounded benchmark complete");
  });

  test("an interrupted job whose limit R2 cannot prove is refused, not guessed", async () => {
    const captured: Captured[] = [];
    // 32 MiB = exactly one 32 MiB chunk: a signal/pause stop, not a bound stop.
    const bucket = bucketWith({ atLimit: false });
    for (const sourceId of ["csv1", "csv2"]) {
      bucket.putBytes(cloudKeys.checkpoint(VERSION, sourceId), Buffer.from(JSON.stringify(checkpoint(sourceId, 32 * MIB, 9_000))), {
        contentType: "application/json",
      });
    }
    const env = envWith(bucket, captured);

    const response = await resume(env);

    expect(response.status).toBe(400);
    expect((response.body.error as { code?: string }).code).toBe("benchmark_limit_unknown");
    expect(String((response.body.error as { message?: string }).message)).toContain("maxSourceMb");
    expect(captured).toEqual([]);
  });

  test("an explicit limit resumes from the checkpoints and is recorded for next time", async () => {
    const captured: Captured[] = [];
    const bucket = bucketWith({ atLimit: false });
    for (const sourceId of ["csv1", "csv2"]) {
      bucket.putBytes(cloudKeys.checkpoint(VERSION, sourceId), Buffer.from(JSON.stringify(checkpoint(sourceId, 8 * MIB, 9_000))), {
        contentType: "application/json",
      });
    }
    const env = envWith(bucket, captured);

    const response = await post(env, `/api/cloud/jobs/${VERSION}/control`, { action: "resume", maxSourceMb: 16 });

    expect(response.status).toBe(202);
    expect(response.body.stage).toBe("pass1");
    expect(captured[0]!.body.args).toEqual([
      "benchmark",
      "--version",
      VERSION,
      "--max-source-mb",
      "16",
      "--partitions",
      "16",
      "--chunk-mb",
      "32",
    ]);
    // Same version, same partitions, and now a durable limit for the next resume.
    const state = await stateOf(env);
    expect(state.mode).toBe("benchmark");
    expect(state.partitions).toBe(16);
    expect(state.config?.maxSourceMb).toBe(16);
    expect(state.config?.partitions).toBe(16);
  });

  test("a recorded limit below the bound resumes with exactly that limit", async () => {
    const captured: Captured[] = [];
    const state = legacyState({
      stage: "pass1",
      config: { stage: "pass1", mode: "benchmark", partitions: 16, maxSourceMb: 12, chunkMb: 32, requestedAt: "2026-10-21T07:00:00.000Z" },
    });
    const env = envWith(bucketWith({ state, atLimit: false }), captured);

    const response = await resume(env);

    expect(response.status).toBe(202);
    expect(captured[0]!.body.args).toEqual([
      "benchmark",
      "--version",
      VERSION,
      "--max-source-mb",
      "12",
      "--partitions",
      "16",
      "--chunk-mb",
      "32",
    ]);
  });

  test("a live attempt is never started twice", async () => {
    const captured: Captured[] = [];
    const run: CloudRunStatus = {
      version: VERSION,
      stage: "pass1",
      outcome: "running",
      attempt: 2,
      recordedBy: "cli",
      startedAt: new Date(NOW - 30_000).toISOString(),
      heartbeatAt: new Date(NOW - 5_000).toISOString(),
      pid: 777,
    };
    const env = envWith(bucketWith({ run }), captured);

    const response = await resume(env);

    expect(response.status).toBe(200);
    expect(response.body.started).toBe(false);
    expect(response.body.alreadyRunning).toBe(true);
    expect(String(response.body.message)).toContain("attempt 2");
    expect(captured).toEqual([]);
  });

  test("a start route refuses while a run is live instead of starting a second one", async () => {
    const captured: Captured[] = [];
    const run: CloudRunStatus = {
      version: VERSION,
      stage: "pass1",
      outcome: "running",
      attempt: 1,
      recordedBy: "cli",
      startedAt: new Date(NOW - 20_000).toISOString(),
      heartbeatAt: new Date(NOW - 2_000).toISOString(),
      pid: 31,
    };
    const env = envWith(bucketWith({ run }), captured);

    const response = await post(env, `/api/cloud/jobs/${VERSION}/start`, { confirm: "START", stage: "pass1", maxSourceMb: 16 });

    expect(response.status).toBe(409);
    expect((response.body.error as { code?: string }).code).toBe("job_already_running");
    expect(captured).toEqual([]);
  });

  test("a benchmark with neither a recorded limit nor a checkpoint is not guessed into a full run", async () => {
    const captured: Captured[] = [];
    const bucket = bucketWith();
    await bucket.delete(cloudKeys.checkpoint(VERSION, "csv1"));
    await bucket.delete(cloudKeys.checkpoint(VERSION, "csv2"));
    const env = envWith(bucket, captured);

    const response = await resume(env);

    expect(response.status).toBe(400);
    expect((response.body.error as { code?: string }).code).toBe("benchmark_limit_unknown");
    expect(captured).toEqual([]);
  });

  test("a full-corpus job is refused on staging, so a resume can never widen a benchmark", async () => {
    const captured: Captured[] = [];
    const env = envWith(bucketWith({ state: legacyState({ mode: "full", stage: "pass1" }) }), captured);

    const response = await resume(env);

    expect(response.status).toBe(403);
    expect((response.body.error as { code?: string }).code).toBe("staging_bounded_only");
    expect(captured).toEqual([]);
  });
});
