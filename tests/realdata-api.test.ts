/**
 * REAL DATA API routes, driven through the real Worker fetch handler.
 *
 * The container is a recording stub: these tests prove what the Worker sends to it
 * (budget clamp, dataset version, query), that a duplicate start reuses the job,
 * that a completed scan is cached per dataset version, and that cancellation writes
 * the durable flag the scan command reads. They do not prove the container boots.
 */

import { describe, expect, test } from "bun:test";

import { app } from "../worker/src/app";
import type { Env } from "../worker/src/env";
import { FakeR2Bucket } from "./helpers/fake-r2";
import { buildFixtureDataset } from "./helpers/fixture-dataset";
import { realDataKeys, type RealDataScanStatus } from "../src/shared/realdata/types";

const fixture = await buildFixtureDataset();

function makeEnv(): { env: Env; bucket: FakeR2Bucket; starts: { args: string[]; detach?: boolean }[] } {
  const bucket = new FakeR2Bucket();
  bucket.loadObjects(
    fixture.outputDir,
    fixture.result.objects.map((object) => object.key),
  );
  bucket.putBytes(
    "staging/active.json",
    Buffer.from(JSON.stringify({ version: fixture.version, previousVersion: null, activatedAt: new Date().toISOString() }), "utf8"),
  );
  bucket.putBytes(
    realDataKeys.coverage(fixture.version),
    Buffer.from(
      JSON.stringify({
        format: 1,
        version: fixture.version,
        label: "REAL DATA — PARTIAL COVERAGE",
        partial: true,
        dataOrigin: "r2",
        generatedAt: new Date().toISOString(),
        sources: [
          { id: "csv1", key: "raw/file1.csv", sizeBytes: 10_000_000, bytesCovered: 1_000_000, recordsRead: 500, coveragePercent: 10, method: "prefix" },
          { id: "csv2", key: "raw/file2.csv", sizeBytes: 90_000_000, bytesCovered: 2_000_000, recordsRead: 900, coveragePercent: 2.22, method: "prefix" },
        ],
        totals: { sourceBytesCovered: 3_000_000, sourceBytesTotal: 100_000_000, coveragePercent: 3 },
        note: "Partial test coverage.",
      }),
      "utf8",
    ),
  );

  const starts: { args: string[]; detach?: boolean }[] = [];
  const container = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input as string, init);
        const body = (await request.json()) as { args: string[]; detach?: boolean };
        starts.push(body);
        return new Response(JSON.stringify({ started: true, pid: 1 }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };

  const env = {
    COMPANY_DATA: bucket,
    ENVIRONMENT: "development",
    DEV_ALLOW_UNAUTHENTICATED: "true",
    MAX_SEARCHES_PER_MINUTE: "100000",
    APP_VERSION: "test",
    ACTIVE_MANIFEST_KEY: "staging/active.json",
    REALDATA_SCAN_MAX_MB: "12",
    INDEXER_CONTAINER: container,
  } as unknown as Env;
  return { env, bucket, starts };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function api(env: Env, path: string, init?: RequestInit): Promise<{ status: number; body: ReturnType<typeof JSON.parse> }> {
  const response = await app.fetch(new Request(`https://companyintel.example${path}`, init), env, ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const json = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

describe("REAL DATA coverage", () => {
  test("reports the activated version, real counts and measured source coverage", async () => {
    const { env } = makeEnv();
    const { status, body } = await api(env, "/api/realdata/coverage");
    expect(status).toBe(200);
    expect(body.dataOrigin).toBe("r2");
    expect(body.version).toBe(fixture.version);
    expect(body.label).toBe("REAL DATA — PARTIAL COVERAGE");
    expect(body.partial).toBe(true);
    expect(body.companies).toBe(fixture.result.counters.uniqueCompanies);
    expect(body.contacts).toBe(fixture.result.counters.uniqueContacts);
    expect(body.coverage.totals.sourceBytesCovered).toBe(3_000_000);
    expect(body.coverage.lastRefreshAt).toBeTruthy();
    expect(body.scanBudgetMb).toBe(12);
    expect(body.scanAvailable).toBe(true);
    expect(body.directScan).toBe(true);
  });

  test("says NO REAL DATA ACTIVE instead of inventing a dataset", async () => {
    const { env, bucket } = makeEnv();
    await bucket.delete("staging/active.json");
    const { status, body } = await api(env, "/api/realdata/coverage");
    expect(status).toBe(200);
    expect(body.dataOrigin).toBe("none");
    expect(body.version).toBeNull();
    expect(body.companies).toBe(0);
    expect(body.coverage).toBeNull();
  });
});

describe("REAL DATA direct scans", () => {
  test("clamps the budget to the deployment setting and starts the scan command", async () => {
    const { env, starts } = makeEnv();
    const { status, body } = await api(env, "/api/realdata/scan", json({ q: "Microsoft", kind: "companies", maxMb: 999 }));
    expect(status).toBe(202);
    expect(body.state).toBe("queued");
    expect(starts).toHaveLength(1);
    expect(starts[0].detach).toBe(true);
    expect(starts[0].args[0]).toBe("scan");
    expect(starts[0].args).toContain("--max-mb");
    expect(starts[0].args[starts[0].args.indexOf("--max-mb") + 1]).toBe("12");
    expect(starts[0].args[starts[0].args.indexOf("--dataset-version") + 1]).toBe(fixture.version);
    expect(starts[0].args[starts[0].args.indexOf("--query") + 1]).toBe("Microsoft");
  });

  test("a duplicate start reuses the running job instead of launching a second scan", async () => {
    const { env, bucket, starts } = makeEnv();
    const first = await api(env, "/api/realdata/scan", json({ q: "Microsoft", kind: "companies" }));
    const jobId = first.body.jobId as string;
    const status: RealDataScanStatus = {
      format: 1,
      jobId,
      query: "Microsoft",
      normalizedQuery: "microsoft",
      kind: "companies",
      state: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      sources: [],
      totals: { bytesScanned: 10, bytesTotal: 100, coveragePercent: 0.01, recordsScanned: 2, companies: 0, contacts: 0, dropped: 0 },
      limit: 50,
      maxMbPerSource: 12,
      datasetVersion: fixture.version,
      complete: false,
    };
    await bucket.putBytes(realDataKeys.scanStatus(jobId), Buffer.from(JSON.stringify(status), "utf8"));
    const second = await api(env, "/api/realdata/scan", json({ q: "Microsoft", kind: "companies" }));
    expect(second.status).toBe(202);
    expect(second.body.jobId).toBe(jobId);
    expect(second.body.message).toContain("already running");
    expect(starts).toHaveLength(1);
  });

  test("returns an uncompleted job's progressive results and only claims its scanned scope", async () => {
    const { env } = makeEnv();
    const start = await api(env, "/api/realdata/scan", json({ q: "Tata Motors", kind: "both" }));
    const jobId = start.body.jobId as string;
    const poll = await api(env, `/api/realdata/scan/${jobId}`);
    expect(poll.status).toBe(200);
    expect(poll.body.status.state).toBe("queued");
    expect(poll.body.results).toBeNull();
    expect(poll.body.datasetVersion).toBe(fixture.version);
  });

  test("caches a completed scan per dataset version and serves it without another scan", async () => {
    const { env, bucket, starts } = makeEnv();
    const start = await api(env, "/api/realdata/scan", json({ q: "Infosys", kind: "companies" }));
    const jobId = start.body.jobId as string;
    const status: RealDataScanStatus = {
      format: 1,
      jobId,
      query: "Infosys",
      normalizedQuery: "infosys",
      kind: "companies",
      state: "complete",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      sources: [
        { id: "csv1", key: "raw/file1.csv", sizeBytes: 1000, bytesScanned: 1000, recordsRead: 3, complete: true },
        { id: "csv2", key: "raw/file2.csv", sizeBytes: 1000, bytesScanned: 1000, recordsRead: 4, complete: true },
      ],
      totals: { bytesScanned: 2000, bytesTotal: 2000, coveragePercent: 100, recordsScanned: 7, companies: 1, contacts: 0, dropped: 0 },
      limit: 50,
      maxMbPerSource: 48,
      datasetVersion: fixture.version,
      complete: true,
    };
    const results = {
      format: 1,
      jobId,
      generatedAt: new Date().toISOString(),
      companies: [
        {
          id: "c_scan",
          name: "Infosys",
          normalizedName: "infosys",
          contacts: [],
          source: { id: "csv1", row: 2 },
          attributes: { organization_industry: "IT services" },
        },
      ],
      contacts: [],
      truncated: false,
    };
    await bucket.putBytes(realDataKeys.scanStatus(jobId), Buffer.from(JSON.stringify(status), "utf8"));
    await bucket.putBytes(realDataKeys.scanResults(jobId), Buffer.from(JSON.stringify(results), "utf8"));

    const firstPoll = await api(env, `/api/realdata/scan/${jobId}`);
    expect(firstPoll.body.status.state).toBe("complete");
    expect(firstPoll.body.results.companies[0].name).toBe("Infosys");
    expect(firstPoll.body.cacheHit).toBe(false);

    const repeat = await api(env, "/api/realdata/scan", json({ q: "Infosys", kind: "companies" }));
    expect(repeat.status).toBe(200);
    expect(repeat.body.cacheHit).toBe(true);
    expect(repeat.body.cached.results.companies[0].name).toBe("Infosys");
    // The cached answer did not start another scan.
    expect(starts).toHaveLength(1);
  });

  test("cancel writes the durable flag the container reads", async () => {
    const { env, bucket } = makeEnv();
    const start = await api(env, "/api/realdata/scan", json({ q: "Acme", kind: "both" }));
    const jobId = start.body.jobId as string;
    const cancel = await api(env, `/api/realdata/scan/${jobId}/cancel`, json({}));
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled).toBe(true);
    const flag = await bucket.get(realDataKeys.scanCancel(jobId));
    expect(flag).toBeTruthy();
  });

  test("rejects an invalid job id and a scan when no dataset is active", async () => {
    const { env, bucket } = makeEnv();
    const bad = await api(env, "/api/realdata/scan/not-a-scan");
    expect(bad.status).toBe(400);
    await bucket.delete("staging/active.json");
    const noDataset = await api(env, "/api/realdata/scan", json({ q: "Microsoft" }));
    expect(noDataset.status).toBe(503);
    expect(noDataset.body.error.code).toBe("dataset_unavailable");
  });

  test("reports the container as unavailable instead of pretending a scan started", async () => {
    const { env } = makeEnv();
    delete (env as unknown as { INDEXER_CONTAINER?: unknown }).INDEXER_CONTAINER;
    const start = await api(env, "/api/realdata/scan", json({ q: "Microsoft" }));
    expect(start.status).toBe(503);
    expect(start.body.error.code).toBe("scan_unavailable");
  });
});
