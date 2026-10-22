/**
 * The indexing screen against every record shape production can hold.
 *
 * HONEST SCOPE: this is `react-dom/server`, not a browser. Effects do not run, so
 * the page is asserted on its initial state and the job detail is rendered from a
 * normalised view directly. That is exactly where the production crash lived —
 * `state.totals.rowsRead` was dereferenced during render — and rendering the same
 * component with a scan record, a partial record, a complete record and a fresh
 * record proves the page can no longer throw on any of them.
 *
 * The launch control's visibility is a function of authorisation alone
 * (`SwarmLaunch authorized`), which `tests/swarm-launch-control.test.tsx` and
 * `tests/cloud-jobs-client.test.ts` cover; it sits outside the job listing in the
 * page, so a legacy record cannot hide it.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { JobDetail, type JobDetailProps } from "../src/components/indexing-job";
import IndexingControl from "../src/pages/IndexingControl";
import { normalizeJobState, type CloudJobView } from "../src/shared/cloud/job-view";

function view(overrides: Partial<CloudJobView> = {}): CloudJobView {
  return {
    version: "prod-real-2026-10-22",
    jobId: "prod-real-2026-10-22",
    stage: "pass1",
    mode: "full",
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    note: null,
    partitions: 256,
    totals: null,
    rate: null,
    accounting: null,
    checkpoint: null,
    sources: [],
    sourcesKnown: false,
    errors: [],
    pass2: null,
    interruption: null,
    ...overrides,
  };
}

function renderDetail(job: CloudJobView, overrides: Partial<JobDetailProps> = {}): string {
  return renderToString(
    <JobDetail
      job={job}
      control={null}
      run={null}
      warning={null}
      busy={null}
      verifyOutput={null}
      onAction={() => undefined}
      onVerify={() => undefined}
      onPreflight={() => undefined}
      onStartFull={() => undefined}
      onStartPass2={() => undefined}
      onActivate={() => undefined}
      {...overrides}
    />,
  );
}

describe("indexing screen", () => {
  test("renders before any job exists, with the launch control gated on authorisation", () => {
    const html = renderToString(<IndexingControl />);
    expect(html).toContain("Cloud indexing");
    expect(html).toContain("No cloud indexing job yet");
    expect(html).toContain("Bounded benchmark");
    // No authorised read has happened during server rendering, so the control is
    // absent rather than optimistically shown.
    expect(html).not.toContain("START FULL INDEXING");
  });

  test("a legacy scan record renders with dashes and a diagnostic, not a crash", () => {
    const job = normalizeJobState({
      version: "scan-2026-10-22",
      mode: "scan",
      stage: "pass1-complete",
      startedAt: "2026-10-22T08:00:00.000Z",
      updatedAt: "2026-10-22T08:05:00.000Z",
      note: 'Direct R2 scan for "acme"',
      progress: { bytesScanned: 1024, bytesTotal: 2048, coveragePercent: 50 },
      accounting: { estimatedUsd: null, containerUsd: null },
    })!;

    const html = renderDetail(job);
    // The diagnostic names what is missing instead of showing 0 rows read.
    expect(html).toContain("does not include");
    expect(html).toContain("indexing totals, throughput, per-source progress");
    expect(html).toContain("This job record carries no per-source progress");
    // Unknown metrics are dashes.
    expect(html).toContain(">—<");
    expect(html).toContain("not reported by this job");
    // The controls for a real job are still on screen and usable.
    expect(html).toContain("Approve full run");
    expect(html).toContain("Start / resume Cloud Pass 2");
    // No fabricated zero in the headline stats.
    expect(html).not.toContain(">0<");
  });

  test("a job without rate or accounting renders its totals and dashes elsewhere", () => {
    const job = view({
      totals: { rowsRead: 1_234, rowsRejected: 0, rowsIndexed: 1_234, segments: 2, segmentBytes: 2_048, sourceBytesRead: 4_096 },
      sourcesKnown: true,
      sources: [{ id: "csv1", complete: false, rows: 1_234, rejected: 0, chunks: 1, segments: 2, sourceBytes: 4_096, size: 10_220_000_000 }],
    });

    const html = renderDetail(job);
    expect(html).toContain(">1,234<");
    // A measured zero stays a zero.
    expect(html).toContain("0 rejected");
    expect(html).toContain(">0<");
    // Missing sections are named, never zero-filled.
    expect(html).toContain("does not include");
    expect(html).toContain("throughput, spend");
    expect(html).toContain("not reported by this job");
  });

  test("complete job statistics render as measured values", () => {
    const job = view({
      stage: "pass2",
      totals: { rowsRead: 1_004, rowsRejected: 4, rowsIndexed: 1_000, segments: 160, segmentBytes: 90_000, sourceBytesRead: 10_220_000_000 },
      rate: { rowsPerSecond: 120, etaSeconds: 3_600 },
      accounting: { estimatedUsd: 1.25, containerUsd: 0.5, classA: 10, classB: 20, budgetUsd: 50 },
      sourcesKnown: true,
      sources: [{ id: "csv1", complete: true, rows: 1_000, rejected: 4, chunks: 10, segments: 160, sourceBytes: 10_220_000_000, size: 10_220_000_000 }],
      checkpoint: { at: "2026-10-22T06:29:00.000Z" },
      pass2: {
        phase: "merge",
        partitionsDone: 12,
        partitionsTotal: 256,
        shardParts: 40,
        indexObjects: 10,
        indexBytes: 5_000,
        finalizeDone: 0,
        finalizeTotal: 0,
        validationDone: 0,
        validationTotal: 0,
      },
    });

    const html = renderDetail(job);
    expect(html).toContain("1,004");
    expect(html).toContain("120 rows/s");
    expect(html).toContain("$1.250");
    expect(html).toContain("12 / 256");
    expect(html).toContain("csv1");
    expect(html).toContain("complete");
    // No diagnostic when every section is present.
    expect(html).not.toContain("does not include");
    expect(html).not.toContain("not reported by this job");
  });

  test("an initial production job with no progress shows zeros, not unknowns", () => {
    const job = view({
      totals: { rowsRead: 0, rowsRejected: 0, rowsIndexed: 0, segments: 0, segmentBytes: 0, sourceBytesRead: 0 },
      rate: { rowsPerSecond: 0, etaSeconds: 0 },
      accounting: { estimatedUsd: 0, containerUsd: 0, classA: 0, classB: 0, budgetUsd: 50 },
      sourcesKnown: true,
      sources: [{ id: "csv1", complete: false, rows: 0, rejected: 0, chunks: 0, segments: 0, sourceBytes: 0, size: 10_220_000_000 }],
      mode: "full",
    });

    const html = renderDetail(job);
    expect(html).toContain(">0<");
    expect(html).toContain("0 rows/s");
    // Zero is a real reading here: no "not reported" note and no missing-section warning.
    expect(html).not.toContain("does not include");
    expect(html).not.toContain("not reported by this job");
  });

  test("a stale-run warning renders its reason without touching unknown metrics", () => {
    const job = normalizeJobState({ version: "legacy-1", stage: "pass1" })!;
    const html = renderDetail(job, {
      warning: { kind: "stale", since: "2026-10-21T00:00:00.000Z", reason: "No progress for 12 min. Start the same version to resume." },
      control: { pause: false, abort: false, approvedFullRun: false },
      run: { outcome: "running", stage: "pass1", attempt: 1, pid: 42, heartbeatAt: "2026-10-21T00:00:00.000Z", reason: null },
    });

    expect(html).toContain("Run is not advancing");
    expect(html).toContain("Start the same version to resume");
    expect(html).toContain("Approve full run");
    // Nothing was invented for the four summary cards.
    expect(html).toContain(">—<");
  });
});
