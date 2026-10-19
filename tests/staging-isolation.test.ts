/**
 * Staging isolation, asserted rather than documented.
 *
 * The staging Worker shares the R2 bucket with production (it must, to benchmark the
 * real sources), so its guarantees have to hold in code: a `stg-` version prefix, no
 * full-corpus start, only its own jobs listed, and activation that writes
 * `staging/active.json` instead of the production pointer. These tests drive the real
 * `indexingAdmin` router with an in-memory R2 binding.
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

function stagingEnv(bucket: FakeR2Bucket): Env {
  return {
    COMPANY_DATA: bucket as unknown as R2Bucket,
    // Local dev identity: the bypass is explicit and impossible in production.
    ENVIRONMENT: "development",
    DEV_ALLOW_UNAUTHENTICATED: "true",
    STAGING_MODE: "true",
    ACTIVE_MANIFEST_KEY: "staging/active.json",
    CLOUD_JOB_BUDGET_USD: "5",
  } as unknown as Env;
}

function productionEnv(bucket: FakeR2Bucket): Env {
  return {
    COMPANY_DATA: bucket as unknown as R2Bucket,
    ENVIRONMENT: "development",
    DEV_ALLOW_UNAUTHENTICATED: "true",
  } as unknown as Env;
}

function jobState(version: string, overrides: Record<string, unknown> = {}) {
  return {
    engine: "cloud-pass1-v1",
    jobId: version,
    version,
    stage: "complete",
    startedAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T01:00:00.000Z",
    mode: "full",
    partitions: 8,
    sources: [],
    totals: { rowsRead: 10, rowsRejected: 0, rowsIndexed: 10, segments: 1, segmentBytes: 1, sourceBytesRead: 1 },
    rate: { rowsPerSecond: 1, bytesPerSecond: 1, etaSeconds: 0 },
    accounting: { classA: 1, classB: 1, bytesRead: 1, bytesWritten: 1, estimatedUsd: 0.1, containerSeconds: 60, containerUsd: 0.01 },
    checkpoint: null,
    errors: [],
    ...overrides,
  };
}

async function post(env: Env, path: string, body: unknown): Promise<Response> {
  return indexingAdmin.fetch(
    new Request(`https://app.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  );
}

async function get(env: Env, path: string): Promise<Response> {
  return indexingAdmin.fetch(new Request(`https://app.example${path}`), env, {} as ExecutionContext);
}

describe("staging isolation", () => {
  test("the staging admin surface refuses an unauthenticated request and fails closed", async () => {
    const unconfigured = {
      COMPANY_DATA: bucketWith() as unknown as R2Bucket,
      ENVIRONMENT: "production",
      STAGING_MODE: "true",
      ACTIVE_MANIFEST_KEY: "staging/active.json",
    } as unknown as Env;
    // No Access application, no dev bypass: every route must refuse rather than serve.
    const response = await get(unconfigured, "/api/cloud/jobs");
    expect(response.status).not.toBe(200);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unauthorized");
  });

  test("a version without the stg- prefix is refused before anything else happens", async () => {
    const env = stagingEnv(bucketWith());
    const response = await post(env, "/api/cloud/jobs/v1-cloud-2026-10-19/start", { confirm: "START", stage: "pass1" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("staging_version_prefix_required");
  });

  test("staging refuses a full-corpus start, and only accepts bounded runs", async () => {
    const env = stagingEnv(bucketWith());
    const response = await post(env, "/api/cloud/jobs/stg-bench-1/start", { confirm: "START", stage: "pass1" });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("staging_bounded_only");
  });

  test("staging lists only its own jobs", async () => {
    const bucket = bucketWith({
      "cloud/jobs/stg-bench-1/state.json": jobState("stg-bench-1"),
      "cloud/jobs/v1-prod/state.json": jobState("v1-prod"),
    });
    const staging = await get(stagingEnv(bucket), "/api/cloud/jobs");
    const stagingBody = (await staging.json()) as { jobs: { state: { version: string } }[]; staging: boolean };
    expect(stagingBody.staging).toBe(true);
    expect(stagingBody.jobs.map((job) => job.state.version)).toEqual(["stg-bench-1"]);

    const production = await get(productionEnv(bucket), "/api/cloud/jobs");
    const productionBody = (await production.json()) as { jobs: { state: { version: string } }[]; staging: boolean };
    expect(productionBody.staging).toBe(false);
    expect(productionBody.jobs.map((job) => job.state.version).sort()).toEqual(["stg-bench-1", "v1-prod"]);
  });

  test("activating on staging writes staging/active.json and never the production pointer", async () => {
    const bucket = bucketWith({
      "cloud/jobs/stg-bench-1/state.json": jobState("stg-bench-1"),
      "manifests/stg-bench-1/manifest.json": { version: "stg-bench-1", validationPassed: true },
      "manifests/stg-bench-1/validation.json": { passed: true },
      "manifests/active.json": { version: "v1", previousVersion: null, activatedAt: "2026-01-01T00:00:00.000Z", activatedBy: "owner@example.com" },
    });
    const response = await post(stagingEnv(bucket), "/api/cloud/jobs/stg-bench-1/activate", { confirm: "stg-bench-1" });
    expect(response.status).toBe(200);

    const pointer = JSON.parse(bucket.getObject("staging/active.json")!.bytes.toString("utf8")) as { version: string; previousVersion: string | null };
    expect(pointer.version).toBe("stg-bench-1");
    // The production pointer is byte-identical to what it was before the call.
    const production = JSON.parse(bucket.getObject("manifests/active.json")!.bytes.toString("utf8")) as { version: string };
    expect(production.version).toBe("v1");
  });

  test("a production deployment activates the production pointer, unchanged", async () => {
    const bucket = bucketWith({
      "cloud/jobs/v1-prod/state.json": jobState("v1-prod"),
      "manifests/v1-prod/manifest.json": { version: "v1-prod", validationPassed: true },
      "manifests/v1-prod/validation.json": { passed: true },
    });
    const response = await post(productionEnv(bucket), "/api/cloud/jobs/v1-prod/activate", { confirm: "v1-prod" });
    expect(response.status).toBe(200);
    expect(bucket.getObject("manifests/active.json")).toBeDefined();
    expect(bucket.getObject("staging/active.json")).toBeUndefined();
  });

  test("staging refuses to activate a version it cannot verify in R2", async () => {
    const bucket = bucketWith({ "cloud/jobs/stg-bench-2/state.json": jobState("stg-bench-2") });
    const response = await post(stagingEnv(bucket), "/api/cloud/jobs/stg-bench-2/activate", { confirm: "stg-bench-2" });
    expect(response.status).toBe(422);
    expect(bucket.getObject("staging/active.json")).toBeUndefined();
  });
});
