/**
 * The client boundary for `GET /api/cloud/jobs`.
 *
 * The launch control is rendered only after an authorised read of this endpoint, so
 * the three answers must stay distinguishable:
 *
 *   - 200 + a job list (even a list of legacy records) → `ok`, authorised;
 *   - 401/403 → `denied`, which hides the control;
 *   - anything else, including a body that is not JSON → `error`, surfaced as a
 *     diagnostic without pretending the identity was rejected or accepted.
 */

import { describe, expect, test } from "bun:test";

import { loadJobs } from "../src/lib/api/cloud-admin";

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** The record the direct real-data scan writes: no totals, no sources, no rate. */
const scanRecord = {
  version: "scan-2026-10-22",
  mode: "scan",
  stage: "pass1-complete",
  startedAt: "2026-10-22T08:00:00.000Z",
  updatedAt: "2026-10-22T08:05:00.000Z",
  note: 'Direct R2 scan for "acme"',
  config: { query: "acme", kind: "companies", maxMbPerSource: 64, limit: 50 },
  progress: { bytesScanned: 1024, bytesTotal: 2048, coveragePercent: 50 },
  accounting: { estimatedUsd: null, containerUsd: null },
};

const fullRecord = {
  engine: "cloud-pass1-v1",
  jobId: "prod-real-2026-10-22",
  version: "prod-real-2026-10-22",
  stage: "pass2",
  startedAt: "2026-10-22T06:00:00.000Z",
  updatedAt: "2026-10-22T06:30:00.000Z",
  mode: "full",
  partitions: 256,
  sources: [
    {
      id: "csv1",
      key: "raw/file1.csv",
      size: 10_220_000_000,
      complete: true,
      rows: 1_000,
      rejected: 4,
      chunks: 10,
      sourceBytes: 10_220_000_000,
      segments: 160,
      segmentBytes: 90_000,
    },
  ],
  totals: { rowsRead: 1_004, rowsRejected: 4, rowsIndexed: 1_000, segments: 160, segmentBytes: 90_000, sourceBytesRead: 10_220_000_000 },
  rate: { rowsPerSecond: 120, bytesPerSecond: 1_000, etaSeconds: 3_600 },
  accounting: { classA: 10, classB: 20, bytesRead: 1, bytesWritten: 1, estimatedUsd: 1.25, containerSeconds: 60, containerUsd: 0.5 },
  checkpoint: null,
  errors: [],
};

describe("loadJobs", () => {
  test("an authorised listing is ok, and a legacy record does not stop it", async () => {
    const result = await loadJobs(
      respond({
        jobs: [
          { state: scanRecord, control: null, run: null, warning: null },
          { state: fullRecord, control: { pause: false, abort: false, approvedFullRun: true, updatedAt: "2026-10-22T06:30:00.000Z" }, run: null, warning: null },
        ],
        truncated: false,
        staging: false,
        containerBound: true,
      }),
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.view.jobs.map((entry) => entry.job.version)).toEqual(["scan-2026-10-22", "prod-real-2026-10-22"]);
    // The scan record carries no indexing totals; that stays unknown, not zero.
    expect(result.view.jobs[0]!.job.totals).toBeNull();
    expect(result.view.jobs[0]!.job.sourcesKnown).toBe(false);
    expect(result.view.jobs[1]!.job.totals?.rowsRead).toBe(1_004);
    expect(result.view.jobs[1]!.control?.approvedFullRun).toBe(true);
    expect(result.view.containerBound).toBe(true);
    expect(result.view.issues).toEqual([]);
  });

  test("an empty listing is a successful, authorised read", async () => {
    const result = await loadJobs(respond({ jobs: [], truncated: false, staging: false, containerBound: false }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.view.jobs).toEqual([]);
    expect(result.view.containerBound).toBe(false);
  });

  test("401 and 403 are authorisation answers, not transport errors", async () => {
    for (const status of [401, 403]) {
      const result = await loadJobs(respond({ error: { code: "forbidden", message: "Admin access required." } }, status));
      expect(result.kind).toBe("denied");
      if (result.kind !== "denied") return;
      expect(result.message).toBe("Admin access required.");
    }
  });

  test("a 500 is reported as a failure, without claiming the identity was rejected", async () => {
    const result = await loadJobs(respond({ error: { message: "The worker threw." } }, 500));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("The worker threw.");
  });

  test("a 200 whose body is not JSON surfaces a diagnostic instead of throwing", async () => {
    const result = await loadJobs(respond("<html>not json</html>", 200));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("not JSON");
    expect(result.message).toContain("200");
  });

  test("an unreachable control plane is an error, not a crash", async () => {
    const result = await loadJobs((async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("network down");
  });
});
