/**
 * The job listing must be complete — and honest about jobs that stopped.
 *
 * Observed on staging: `state.json` existed for `stg-bench-2026-10-21`, but
 * `GET /api/cloud/jobs` answered `{"jobs":[]}`. The listing was one 200-key page of
 * `cloud/jobs/`, filtered down to `…/state.json`. A real job writes chunk manifests
 * and thousands of segments under the same prefix, and `segments/…` sorts before
 * `state.json`, so the page was full of segment keys and the job's own state never
 * appeared. These tests seed a job with more segment objects than one page and
 * require it to be listed anyway, without scanning the segment directory.
 *
 * The second half pins the "stuck Pass 1" contract: a job in an in-flight stage with
 * no heartbeat, or with an explicit interruption, must carry a reason the panel can
 * render — never `stage: pass1` with nothing else.
 */

import { describe, expect, test } from "bun:test";

import { indexingAdmin } from "../worker/src/indexer-admin";
import type { Env } from "../worker/src/env";
import { FakeR2Bucket } from "./helpers/fake-r2";

function bucketWith(seed: Record<string, unknown> = {}): FakeR2Bucket {
  const bucket = new FakeR2Bucket();
  for (const [key, value] of Object.entries(seed)) {
    bucket.putBytes(key, Buffer.from(JSON.stringify(value), "utf8"), { contentType: "application/json" });
  }
  return bucket;
}

function env(bucket: FakeR2Bucket, overrides: Record<string, string> = {}): Env {
  return {
    COMPANY_DATA: bucket as unknown as R2Bucket,
    ENVIRONMENT: "development",
    DEV_ALLOW_UNAUTHENTICATED: "true",
    ...overrides,
  } as unknown as Env;
}

function jobState(version: string, overrides: Record<string, unknown> = {}) {
  return {
    engine: "cloud-pass1-v1",
    jobId: version,
    version,
    stage: "pass1",
    startedAt: "2026-10-21T06:58:25.828Z",
    updatedAt: new Date().toISOString(),
    mode: "benchmark",
    partitions: 16,
    sources: [],
    totals: { rowsRead: 7_567, rowsRejected: 387, rowsIndexed: 7_180, segments: 16, segmentBytes: 1, sourceBytesRead: 1 },
    rate: { rowsPerSecond: 1, bytesPerSecond: 1, etaSeconds: 1 },
    accounting: { classA: 1, classB: 1, bytesRead: 1, bytesWritten: 1, estimatedUsd: 0.1, containerSeconds: 60, containerUsd: 0.01 },
    checkpoint: null,
    errors: [],
    ...overrides,
  };
}

function runStatus(version: string, overrides: Record<string, unknown> = {}) {
  return {
    version,
    stage: "pass1",
    outcome: "running",
    attempt: 1,
    recordedBy: "cli",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    pid: 42,
    ...overrides,
  };
}

interface JobsBody {
  jobs: {
    state: { version: string; stage: string; mode?: string; totals?: unknown };
    run: { outcome: string; reason?: string } | null;
    warning: { kind: string; reason: string; since: string } | null;
  }[];
  truncated: boolean;
  staging: boolean;
}

async function getJobs(target: Env): Promise<{ status: number; body: JobsBody; bucket: FakeR2Bucket }> {
  const bucket = (target as unknown as { COMPANY_DATA: FakeR2Bucket }).COMPANY_DATA;
  const response = await indexingAdmin.fetch(new Request("https://app.example/api/cloud/jobs"), target, {} as ExecutionContext);
  return { status: response.status, body: (await response.json()) as JobsBody, bucket };
}

describe("cloud job listing", () => {
  test("lists a job whose segment directory is larger than one listing page", async () => {
    const version = "stg-bench-2026-10-21";
    const seed: Record<string, unknown> = {
      [`cloud/jobs/${version}/state.json`]: jobState(version),
      [`cloud/jobs/${version}/run.json`]: runStatus(version),
      [`cloud/jobs/${version}/chunks/csv1/000000.json`]: { chunk: 0 },
    };
    // 1,200 segment objects is six pages of keys; the old single-page listing never
    // reached `state.json` because `segments/` sorts before it.
    for (let index = 0; index < 1_200; index += 1) {
      seed[`cloud/jobs/${version}/segments/csv1/000000/part-${String(index % 16).padStart(4, "0")}-${index}.jsonl.gz`] = "x";
    }
    const bucket = bucketWith(seed);
    bucket.resetCounters();

    const { status, body } = await getJobs(env(bucket));

    expect(status).toBe(200);
    expect(body.jobs.map((job) => job.state.version)).toEqual([version]);
    expect(body.truncated).toBe(false);
    // A live run has no warning, and the run attempt is included.
    expect(body.jobs[0]!.warning).toBeNull();
    expect(body.jobs[0]!.run?.outcome).toBe("running");
    // Nothing under segments/ was fetched or listed: the delimiter returns the
    // version directory once, not its contents.
    expect(bucket.counters.readKeys.some((key) => key.includes("/segments/"))).toBe(false);
    expect(bucket.counters.lists).toBeLessThanOrEqual(2);
  });

  test("staging still hides production jobs, with the same complete listing", async () => {
    const bucket = bucketWith({
      "cloud/jobs/stg-owned/state.json": jobState("stg-owned"),
      "cloud/jobs/v1-prod/state.json": jobState("v1-prod"),
      "cloud/jobs/stg-owned/segments/csv1/000000/part-0000.jsonl.gz": "x",
    });
    const { body } = await getJobs(env(bucket, { STAGING_MODE: "true", ACTIVE_MANIFEST_KEY: "staging/active.json" }));
    expect(body.staging).toBe(true);
    expect(body.jobs.map((job) => job.state.version)).toEqual(["stg-owned"]);
  });

  test("a finalizing job with a fresh heartbeat is not reported as stalled", async () => {
    const version = "stg-finalizing";
    const now = Date.now();
    const bucket = bucketWith({
      [`cloud/jobs/${version}/state.json`]: jobState(version, {
        stage: "pass2",
        pass2: {
          partitionsDone: 16,
          partitionsTotal: 16,
          shardParts: 11_264,
          indexObjects: 366,
          indexBytes: 512_000,
          rowsPerSecond: 5,
          phase: "finalize",
          finalizeDone: 368,
          finalizeTotal: 2_817,
          validationDone: 0,
          validationTotal: 0,
          updatedAt: new Date(now - 20_000).toISOString(),
        },
      }),
      [`cloud/jobs/${version}/run.json`]: runStatus(version, {
        stage: "pass2",
        // Finalize has no partition boundaries; the new heartbeat is what keeps this
        // from looking stopped for the whole upload.
        heartbeatAt: new Date(now - 20_000).toISOString(),
      }),
    });

    const { body } = await getJobs(env(bucket));

    expect(body.jobs[0]!.warning).toBeNull();
    expect(body.jobs[0]!.state.pass2).toMatchObject({ phase: "finalize", finalizeDone: 368, finalizeTotal: 2_817 });
  });

  test("a job with no heartbeat for a while is reported as stale, not as running", async () => {
    const version = "stg-silent";
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const bucket = bucketWith({ [`cloud/jobs/${version}/state.json`]: jobState(version, { updatedAt: old }) });
    const { body } = await getJobs(env(bucket));

    expect(body.jobs).toHaveLength(1);
    const warning = body.jobs[0]!.warning;
    expect(warning?.kind).toBe("stale");
    expect(warning?.reason).toMatch(/No progress for/);
    expect(warning?.reason).toMatch(/resume/);
    expect(warning?.since).toBe(old);
  });

  test("an explicit interruption reason from the container runner is surfaced", async () => {
    const version = "stg-stopped";
    const bucket = bucketWith({
      [`cloud/jobs/${version}/state.json`]: jobState(version, {
        stage: "paused",
        interruption: { at: "2026-10-21T07:00:19.518Z", outcome: "interrupted", reason: "the container was stopped (SIGTERM)" },
      }),
      [`cloud/jobs/${version}/run.json`]: runStatus(version, {
        outcome: "interrupted",
        reason: "the container was stopped (SIGTERM)",
        heartbeatAt: "2026-10-21T07:00:19.518Z",
      }),
    });
    const { body } = await getJobs(env(bucket));
    // `paused` is not an in-flight stage, so no warning banner is needed; the reason
    // travels with the job either way and the panel shows it as a stopped run.
    expect(body.jobs[0]!.run?.reason).toContain("SIGTERM");
  });

  test("a failed run keeps its error message", async () => {
    const version = "stg-failed";
    const bucket = bucketWith({
      [`cloud/jobs/${version}/state.json`]: jobState(version, { stage: "failed" }),
      [`cloud/jobs/${version}/run.json`]: runStatus(version, {
        outcome: "failed",
        reason: "simulated R2 outage while writing the segment",
        heartbeatAt: "2026-10-21T07:00:19.518Z",
      }),
    });
    const { body } = await getJobs(env(bucket));
    expect(body.jobs[0]!.run?.outcome).toBe("failed");
    expect(body.jobs[0]!.run?.reason).toContain("simulated R2 outage");
  });

  test("a direct-scan record is listed untouched: no rewrite, no delete, no invented totals", async () => {
    // `tools/realdata/scan.ts` writes a state.json with `mode: "scan"` and a
    // `progress` block — no `totals`. The listing must keep serving it verbatim so
    // history is preserved; the panel is what tolerates the missing metrics.
    const version = "scan-2026-10-22";
    const bucket = bucketWith({
      [`cloud/jobs/${version}/state.json`]: {
        version,
        mode: "scan",
        stage: "pass1-complete",
        startedAt: "2026-10-22T08:00:00.000Z",
        updatedAt: new Date().toISOString(),
        note: 'Direct R2 scan for "acme"',
        config: { query: "acme", kind: "companies", maxMbPerSource: 64, limit: 50 },
        progress: { bytesScanned: 1024, bytesTotal: 2048, coveragePercent: 50 },
        accounting: { estimatedUsd: null, containerUsd: null },
      },
    });
    bucket.resetCounters();

    const { status, body } = await getJobs(env(bucket));

    expect(status).toBe(200);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]!.state).toMatchObject({ version, mode: "scan", stage: "pass1-complete" });
    expect(body.jobs[0]!.state).not.toHaveProperty("totals");
    // Reading the listing never writes: history is not repaired by a GET.
    expect(bucket.counters.puts).toBe(0);
    expect(bucket.counters.readKeys.every((key) => key.endsWith("/state.json"))).toBe(true);
  });

  test("more job directories than one page are reported as truncated, newest first", async () => {
    const seed: Record<string, unknown> = {};
    for (let index = 0; index < 30; index += 1) {
      const version = `stg-bench-2026-10-${String(index + 1).padStart(2, "0")}`;
      seed[`cloud/jobs/${version}/state.json`] = jobState(version, { updatedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` });
    }
    const { body } = await getJobs(env(bucketWith(seed)));
    expect(body.jobs).toHaveLength(25);
    expect(body.truncated).toBe(true);
    // Newest `updatedAt` first.
    expect(body.jobs[0]!.state.version).toBe("stg-bench-2026-10-30");
  });
});
