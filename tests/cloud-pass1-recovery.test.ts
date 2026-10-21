/**
 * Pass 1 stops safely and says why.
 *
 * Staging showed the failure mode this guards against: the container was stopped
 * between `putJson(checkpoint)` and `putJson(state)`. R2 held csv2's chunk, manifest
 * and checkpoint while `state.json` still said 0 rows, `stage: pass1`, and
 * `errors: []` — a job that looked alive forever.
 *
 * Three properties are asserted here:
 *
 *   1. a stop request (the container's SIGTERM, wired through `shouldStop`) stops at
 *      a chunk boundary and records `interruption` + a note;
 *   2. a thrown error is persisted as `stage: failed` with the message, then
 *      re-thrown (the CLI still exits non-zero);
 *   3. resuming the same version reads only the uncommitted bytes — the totals equal
 *      an uninterrupted run and no segment is duplicated, because segment keys are
 *      deterministic and overwritten.
 */

import { describe, expect, test } from "bun:test";

import { runPass1, syncStateFromCheckpoints, verifyRun } from "../tools/cloud/pass1";
import { MemoryBlobStore } from "../tools/cloud/store";
import { cloudKeys, type CloudJobState } from "../src/shared/cloud/types";

const COMPANY_HEADER = ["organization_id", "organization_name", "organization_domain", "description"];
const CONTACT_HEADER = ["person_name", "person_email", "sanitized_organization_name_unanalyzed"];

const SOURCES = [
  {
    id: "csv1",
    key: "raw/file1.csv",
    delimiter: "\t",
    columns: { companyid: "organization_id", companyname: "organization_name", companydomain: "organization_domain" },
  },
  {
    id: "csv2",
    key: "raw/file2.csv",
    delimiter: "\t",
    columns: { companyname: "sanitized_organization_name_unanalyzed", personname: "person_name", email: "person_email" },
  },
];

function seed(): { store: FailOnceStore; companyRows: number; contactRows: number } {
  const companies = [COMPANY_HEADER.join("\t")];
  const contacts = [CONTACT_HEADER.join("\t")];
  for (let index = 0; index < 40; index += 1) {
    companies.push([`c${index}`, `Company ${index} Ltd`, `company${index}.example`, `"plain ${index}"`].join("\t"));
  }
  for (let index = 0; index < 60; index += 1) {
    contacts.push([`Person ${index}`, `person${index}@company${index}.example`, `Company ${index % 40} Ltd`].join("\t"));
  }
  const store = new FailOnceStore({
    "raw/file1.csv": Buffer.from(`${companies.join("\n")}\n`, "utf8"),
    "raw/file2.csv": Buffer.from(`${contacts.join("\n")}\n`, "utf8"),
  });
  return { store, companyRows: 40, contactRows: 60 };
}

/** A store that can be made to fail one PUT, to simulate the container dying. */
class FailOnceStore extends MemoryBlobStore {
  failWhen: ((key: string) => boolean) | null = null;
  failure = "simulated R2 outage while writing the segment";

  override async put(key: string, body: Buffer): Promise<{ etag: string | null }> {
    if (this.failWhen?.(key)) {
      this.failWhen = null;
      throw new Error(this.failure);
    }
    return super.put(key, body);
  }
}

async function state(store: MemoryBlobStore, version: string): Promise<CloudJobState | null> {
  return store.getJson<CloudJobState>(cloudKeys.state(version));
}

describe("cloud Pass 1 interruption and resume", () => {
  test("a stop request stops at the chunk boundary, persists the reason, and resumes exactly", async () => {
    const clean = seed();
    const baseline = await runPass1({ store: clean.store, version: "clean-1", sources: SOURCES, partitions: 8, chunkBytes: 700, sliceBytes: 64 });
    expect(baseline.stopped).toBe("complete");
    const baselineSegments = clean.store.keys(`${cloudKeys.jobRoot("clean-1")}/segments/`).length;

    const { store, companyRows, contactRows } = seed();
    let chunksWritten = 0;
    const interrupted = await runPass1({
      store,
      version: "stopped-1",
      sources: SOURCES,
      partitions: 8,
      chunkBytes: 700,
      sliceBytes: 64,
      heartbeat: () => {
        chunksWritten += 1;
      },
      // Exactly the container's SIGTERM path: the reason is checked between chunks.
      shouldStop: () => (chunksWritten >= 1 ? "the container received SIGTERM; the job stopped at the last committed chunk" : null),
    });

    expect(interrupted.stopped).toBe("interrupted");
    expect(interrupted.state.stage).toBe("paused");
    expect(interrupted.state.interruption?.outcome).toBe("interrupted");
    expect(interrupted.state.interruption?.reason).toContain("SIGTERM");
    expect(interrupted.state.note).toContain("SIGTERM");
    // The first chunk is committed and durable; later chunks and csv2 were not read.
    expect(interrupted.state.totals.rowsRead).toBeGreaterThan(0);
    expect(interrupted.state.totals.rowsRead).toBeLessThan(companyRows + contactRows);
    const checkpoint = await store.getJson<{ chunks: number; nextOffset: number }>(cloudKeys.checkpoint("stopped-1", "csv1"));
    expect(checkpoint!.chunks).toBe(1);
    expect(checkpoint!.nextOffset).toBeGreaterThan(0);

    // Resuming is the same command with the same version: no shouldStop this time.
    const resumed = await runPass1({ store, version: "stopped-1", sources: SOURCES, partitions: 8, chunkBytes: 700, sliceBytes: 64 });
    expect(resumed.stopped).toBe("complete");
    expect(resumed.state.stage).toBe("pass1-complete");
    expect(resumed.state.interruption).toBeUndefined();
    expect(resumed.state.totals.rowsRead).toBe(companyRows + contactRows);
    // No duplicated object: deterministic segment keys mean the same number of
    // segments as an uninterrupted run, and verification agrees the ranges cover
    // every source byte exactly once.
    expect(store.keys(`${cloudKeys.jobRoot("stopped-1")}/segments/`).length).toBe(baselineSegments);
    const report = await verifyRun({ store, version: "stopped-1", sources: SOURCES });
    expect(report.problems).toEqual([]);
    expect(report.rows).toBe(companyRows + contactRows);
  });

  test("a thrown error is recorded as failed + the message, and the run can resume", async () => {
    const clean = seed();
    const baseline = await runPass1({ store: clean.store, version: "clean-2", sources: SOURCES, partitions: 8, chunkBytes: 700, sliceBytes: 64 });

    const { store, companyRows, contactRows } = seed();
    // Fail while writing the SECOND chunk of csv1: chunk 0 (segments, manifest,
    // checkpoint, state) must survive, which is what a resume reads.
    store.failWhen = (key) => key.startsWith(`${cloudKeys.jobRoot("failed-1")}/segments/csv1/000001/`);

    await expect(
      runPass1({ store, version: "failed-1", sources: SOURCES, partitions: 8, chunkBytes: 700, sliceBytes: 64 }),
    ).rejects.toThrow(/simulated R2 outage/);

    const failed = await state(store, "failed-1");
    expect(failed?.stage).toBe("failed");
    expect(failed?.interruption?.outcome).toBe("failed");
    expect(failed?.interruption?.reason).toContain("simulated R2 outage");
    expect(failed?.errors.at(-1)?.message).toContain("simulated R2 outage");
    expect(failed?.note).toContain("re-run the same version");
    const checkpoint = await store.getJson<{ chunks: number }>(cloudKeys.checkpoint("failed-1", "csv1"));
    expect(checkpoint!.chunks).toBe(1);

    const resumed = await runPass1({ store, version: "failed-1", sources: SOURCES, partitions: 8, chunkBytes: 700, sliceBytes: 64 });
    expect(resumed.stopped).toBe("complete");
    expect(resumed.state.totals.rowsRead).toBe(baseline.state.totals.rowsRead);
    expect(resumed.state.totals.rowsRead).toBe(companyRows + contactRows);
    expect(resumed.state.interruption).toBeUndefined();
  });

  test("re-running a bounded benchmark at its limit reports bounded, not a stuck job", async () => {
    const { store } = seed();
    const options = {
      store,
      version: "bounded-1",
      sources: SOURCES,
      partitions: 8,
      chunkBytes: 700,
      sliceBytes: 64,
      maxSourceBytes: 400,
    } as const;
    const first = await runPass1({ ...options });
    expect(first.stopped).toBe("bounded");
    const rows = first.state.totals.rowsRead;
    expect(rows).toBeGreaterThan(0);

    const second = await runPass1({ ...options });
    expect(second.stopped).toBe("bounded");
    expect(second.state.stage).toBe("pass1");
    expect(second.state.note).toMatch(/per-source limit/);
    expect(second.state.totals.rowsRead).toBe(rows);
    // Nothing was re-read and nothing was re-uploaded for a chunk already committed.
    expect(second.state.totals.segments).toBe(first.state.totals.segments);
  });

  test("a state that lagged its checkpoint is repaired from the checkpoint, never the reverse", async () => {
    const { store } = seed();
    await runPass1({ store, version: "sync-1", sources: SOURCES, partitions: 8, chunkBytes: 700, sliceBytes: 64, maxSourceBytes: 1_200 });
    const truthful = (await state(store, "sync-1"))!;
    const checkpoint = await store.getJson<{ rows: number; chunks: number }>(cloudKeys.checkpoint("sync-1", "csv1"));
    const lagging = { ...truthful, sources: truthful.sources.map((source) => ({ ...source })) };
    lagging.sources[0] = { ...lagging.sources[0]!, rows: 0, chunks: 0, nextOffset: 0, sourceBytes: 0, segments: 0 };
    lagging.totals = { ...lagging.totals, rowsRead: 0, rowsIndexed: 0, segments: 0, sourceBytesRead: 0 };

    expect(await syncStateFromCheckpoints(store, lagging)).toBe(true);
    expect(lagging.sources[0]!.rows).toBe(checkpoint!.rows);
    expect(lagging.sources[0]!.chunks).toBe(checkpoint!.chunks);
    expect(lagging.totals.rowsRead).toBeGreaterThan(0);
    // A job already at least as advanced is left alone.
    expect(await syncStateFromCheckpoints(store, lagging)).toBe(false);
  });

  test("state.json is never behind the durable checkpoint on resume", async () => {
    const { store } = seed();
    await runPass1({ store, version: "lag-1", sources: SOURCES, partitions: 8, chunkBytes: 700, sliceBytes: 64, maxSourceBytes: 1_200 });
    // Reproduce the staging window: the checkpoint advanced, then the process died
    // before state.json was rewritten.
    const checkpoint = await store.getJson<{ rows: number; chunks: number }>(cloudKeys.checkpoint("lag-1", "csv1"));
    const staleState = (await state(store, "lag-1"))!;
    staleState.sources[0] = { ...staleState.sources[0]!, rows: 0, chunks: 0, nextOffset: 0, sourceBytes: 0 };
    staleState.totals.rowsRead = 0;
    await store.putJson(cloudKeys.state("lag-1"), staleState);

    let heartbeatRows = 0;
    const result = await runPass1({
      store,
      version: "lag-1",
      sources: SOURCES,
      partitions: 8,
      chunkBytes: 700,
      sliceBytes: 64,
      maxSourceBytes: 1_200,
      heartbeat: (committed) => {
        heartbeatRows = committed.rows;
      },
    });
    expect(result.state.sources[0]!.rows).toBeGreaterThanOrEqual(checkpoint!.rows);
    // Re-reading from the checkpoint does not re-process the committed chunk.
    expect(heartbeatRows === 0 || heartbeatRows >= checkpoint!.rows).toBe(true);
    const reread = await store.getJson<{ chunks: number }>(cloudKeys.checkpoint("lag-1", "csv1"));
    expect(reread!.chunks).toBe(checkpoint!.chunks);
  });
});
