/**
 * Normalisation of `GET /api/cloud/jobs` records.
 *
 * The production crash was `state.totals.rowsRead` on a job whose state.json came
 * from the direct real-data scan: that record has `mode: "scan"` and no `totals`,
 * `sources`, `rate`, `errors` or `checkpoint`. It is a legitimate historical job,
 * so the correct answer is to render it with unknown values — not to delete it, and
 * not to invent zeros.
 *
 * These tests pin the contract the panel relies on: missing is `null`, a real 0
 * stays 0, and a malformed payload becomes an issue string instead of an exception.
 */

import { describe, expect, test } from "bun:test";

import { normalizeJobState, normalizeJobsResponse } from "../src/shared/cloud/job-view";

/** What `tools/realdata/scan.ts` writes to cloud/jobs/<job>/state.json. */
const scanState = {
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

function completeState() {
  return {
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
    accounting: {
      classA: 10,
      classB: 20,
      bytesRead: 1,
      bytesWritten: 1,
      estimatedUsd: 1.25,
      containerSeconds: 60,
      containerUsd: 0.5,
      budgetUsd: 50,
    },
    checkpoint: { at: "2026-10-22T06:29:00.000Z", sources: [] },
    errors: [{ at: "2026-10-22T06:20:00.000Z", stage: "pass2", message: "a merge task retried" }],
    pass2: {
      partitionsDone: 12,
      partitionsTotal: 256,
      shardParts: 40,
      indexObjects: 10,
      indexBytes: 5_000,
      rowsPerSecond: 90,
      phase: "merge",
      updatedAt: "2026-10-22T06:30:00.000Z",
    },
  };
}

describe("normalizeJobState", () => {
  test("a scan record has no totals, sources or rate — and normalises without throwing", () => {
    const job = normalizeJobState(scanState)!;
    expect(job.version).toBe("scan-2026-10-22");
    expect(job.mode).toBe("scan");
    expect(job.stage).toBe("pass1-complete");
    expect(job.totals).toBeNull();
    expect(job.rate).toBeNull();
    expect(job.sourcesKnown).toBe(false);
    expect(job.sources).toEqual([]);
    expect(job.checkpoint).toBeNull();
    expect(job.pass2).toBeNull();
    expect(job.errors).toEqual([]);
    // The accounting block exists but its numbers do not: unknown, not 0.
    expect(job.accounting).toEqual({ estimatedUsd: null, containerUsd: null, classA: null, classB: null, budgetUsd: null });
    expect(job.interruption).toBeNull();
  });

  test("a job without rate or accounting keeps its totals", () => {
    const raw = completeState();
    delete (raw as Record<string, unknown>).rate;
    delete (raw as Record<string, unknown>).accounting;
    const job = normalizeJobState(raw)!;
    expect(job.totals?.rowsRead).toBe(1_004);
    expect(job.rate).toBeNull();
    expect(job.accounting).toBeNull();
    expect(job.sourcesKnown).toBe(true);
  });

  test("complete statistics are preserved, including a real zero", () => {
    const raw = completeState();
    raw.totals.rowsRejected = 0;
    raw.totals.segments = 0;
    const job = normalizeJobState(raw)!;
    expect(job.totals).toEqual({
      rowsRead: 1_004,
      rowsRejected: 0,
      rowsIndexed: 1_000,
      segments: 0,
      segmentBytes: 90_000,
      sourceBytesRead: 10_220_000_000,
    });
    expect(job.rate).toEqual({ rowsPerSecond: 120, etaSeconds: 3_600 });
    expect(job.accounting).toEqual({ estimatedUsd: 1.25, containerUsd: 0.5, classA: 10, classB: 20, budgetUsd: 50 });
    expect(job.checkpoint?.at).toBe("2026-10-22T06:29:00.000Z");
    expect(job.pass2?.phase).toBe("merge");
    expect(job.errors).toHaveLength(1);
  });

  test("an initial job with zero progress reports zeros, not unknowns", () => {
    const job = normalizeJobState({
      version: "prod-real-2026-10-22",
      stage: "pass1",
      mode: "full",
      totals: { rowsRead: 0, rowsRejected: 0, rowsIndexed: 0, segments: 0, segmentBytes: 0, sourceBytesRead: 0 },
      rate: { rowsPerSecond: 0, etaSeconds: 0 },
      accounting: { classA: 0, classB: 0, estimatedUsd: 0, containerUsd: 0 },
      sources: [],
      errors: [],
    })!;
    expect(job.totals?.rowsRead).toBe(0);
    expect(job.rate?.rowsPerSecond).toBe(0);
    expect(job.accounting?.estimatedUsd).toBe(0);
    expect(job.sourcesKnown).toBe(true);
  });

  test("numbers that are not finite numbers are unknown", () => {
    const job = normalizeJobState({
      version: "odd",
      totals: { rowsRead: "12", rowsRejected: null, segments: Number.POSITIVE_INFINITY },
      rate: { rowsPerSecond: Number.NaN },
    })!;
    expect(job.totals?.rowsRead).toBeNull();
    expect(job.totals?.rowsRejected).toBeNull();
    expect(job.totals?.segments).toBeNull();
    expect(job.rate?.rowsPerSecond).toBeNull();
  });

  test("a record without a version cannot be selected, so it is not returned", () => {
    expect(normalizeJobState({ stage: "pass1" })).toBeNull();
    expect(normalizeJobState("state.json")).toBeNull();
    expect(normalizeJobState(null)).toBeNull();
  });
});

describe("normalizeJobsResponse", () => {
  test("keeps a legacy record alongside a complete one and reports no issues", () => {
    const view = normalizeJobsResponse({
      jobs: [
        { state: scanState, control: null, run: null, warning: null },
        {
          state: completeState(),
          control: { pause: false, abort: false, approvedFullRun: true, updatedAt: "x" },
          run: { version: "prod-real-2026-10-22", stage: "pass2", outcome: "running", attempt: 2, heartbeatAt: "2026-10-22T06:30:00.000Z", pid: 7 },
          warning: null,
        },
      ],
      truncated: false,
      staging: false,
      containerBound: true,
    });
    expect(view.jobs.map((entry) => entry.job.version)).toEqual(["scan-2026-10-22", "prod-real-2026-10-22"]);
    expect(view.jobs[0]!.job.totals).toBeNull();
    expect(view.jobs[1]!.control?.approvedFullRun).toBe(true);
    expect(view.jobs[1]!.run?.outcome).toBe("running");
    expect(view.issues).toEqual([]);
    expect(view.containerBound).toBe(true);
  });

  test("an empty listing is a valid view", () => {
    const view = normalizeJobsResponse({ jobs: [], truncated: false, staging: false, containerBound: false });
    expect(view.jobs).toEqual([]);
    expect(view.issues).toEqual([]);
  });

  test("a malformed payload becomes issues, never an exception", () => {
    for (const payload of [null, undefined, 42, "ok", [], { jobs: "none" }]) {
      const view = normalizeJobsResponse(payload);
      expect(view.jobs).toEqual([]);
      expect(view.issues.length).toBeGreaterThan(0);
    }
  });

  test("one unreadable entry does not discard the readable ones", () => {
    const view = normalizeJobsResponse({
      jobs: [{ state: null }, { state: { stage: "pass1" } }, { state: scanState }],
      containerBound: "yes",
    });
    expect(view.jobs).toHaveLength(1);
    expect(view.jobs[0]!.job.version).toBe("scan-2026-10-22");
    expect(view.issues).toHaveLength(2);
    // A non-boolean containerBound is unknown, not false.
    expect(view.containerBound).toBeNull();
  });

  test("a warning without a reason is dropped rather than rendered as an empty alert", () => {
    const view = normalizeJobsResponse({
      jobs: [{ state: scanState, warning: { kind: "stale", since: "2026-10-22T08:00:00.000Z" } }],
    });
    expect(view.jobs[0]!.warning).toBeNull();
  });
});
