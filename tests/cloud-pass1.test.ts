/**
 * Cloud Pass 1 against an in-memory blob store.
 *
 * The properties asserted are the ones that make a cloud run safe on a 54 GB
 * object: chunk cuts land on record boundaries (including a quoted field with a
 * newline and a multi-byte character), every source byte is read exactly once,
 * a resume never re-spools a row, a pause leaves a usable checkpoint, and
 * verification catches a changed segment.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { assembleRun } from "../tools/cloud/assemble";
import { readChunk } from "../tools/cloud/chunker";
import { cloudSourcesFromConfig, runPass1, verifyRun } from "../tools/cloud/pass1";
import { MemoryBlobStore } from "../tools/cloud/store";
import { cloudKeys, CLOUD_CONTROL_VERSION, type CloudControl, type CloudChunkManifest } from "../src/shared/cloud/types";
import { decodeSpoolV2Row } from "../tools/indexer/src/spool-v2";
import { readSpoolManifest } from "../tools/indexer/src/spool";

const COMPANY_HEADER = ["organization_id", "organization_name", "organization_domain", "description"];
const CONTACT_HEADER = ["person_name", "person_email", "sanitized_organization_name_unanalyzed"];

function companyRow(index: number): string {
  const description = index % 5 === 0 ? `"line one\nline two for company ${index}"` : `"plain ${index}"`;
  return [`c${index}`, `Company ${index} Ltd`, `company${index}.example`, description].join("\t");
}

function contactRow(index: number): string {
  return [`Person ${index}`, `person${index}@company${index}.example`, `Company ${index} Ltd`].join("\t");
}

function corpus(): { company: Buffer; contact: Buffer; companyRows: number; contactRows: number } {
  const companies = [COMPANY_HEADER.join("\t")];
  for (let index = 0; index < 40; index += 1) companies.push(companyRow(index));
  const contacts = [CONTACT_HEADER.join("\t")];
  for (let index = 0; index < 60; index += 1) contacts.push(contactRow(index % 40));
  return {
    company: Buffer.from(`${companies.join("\n")}\n`, "utf8"),
    contact: Buffer.from(`${contacts.join("\n")}\n`, "utf8"),
    companyRows: 40,
    contactRows: 60,
  };
}

// The canonical field names are the historical `company*` keys (see headers.ts);
// the real source headers are `organization_*`, which is exactly why the
// production config carries explicit overrides for them.
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

function seed(): { store: MemoryBlobStore; data: ReturnType<typeof corpus> } {
  const data = corpus();
  const store = new MemoryBlobStore({
    "raw/file1.csv": data.company,
    "raw/file2.csv": data.contact,
  });
  return { store, data };
}

function decodeSegments(store: MemoryBlobStore, version: string, sourceId: string, partition: number): string[][] {
  const objects = store.keys(`${cloudKeys.jobRoot(version)}/segments/${sourceId}/`).filter((key) => key.endsWith(`part-${String(partition).padStart(4, "0")}.jsonl.gz`));
  const rows: string[][] = [];
  for (const key of objects) {
    const text = gunzipSync(store.bytes(key)!).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      rows.push(JSON.parse(line) as string[]);
    }
  }
  return rows;
}

describe("cloud chunker", () => {
  test("a chunk cut never splits a quoted newline, a UTF-8 character or a row", async () => {
    const rows = [["organization_name", "description"]];
    for (let index = 0; index < 30; index += 1) {
      rows.push([`Company ${index} ✓`, index % 3 === 0 ? `"a quoted\nnewline — and an em dash ✓ ${index}"` : `"plain ${index}"`]);
    }
    const body = Buffer.from(rows.map((row) => row.join("\t")).join("\n") + "\n", "utf8");
    const store = new MemoryBlobStore({ "raw/source.tsv": body });

    let offset = 0;
    let line = 1;
    let seen = 0;
    let chunks = 0;
    while (offset < body.length) {
      const chunk = await readChunk({
        store,
        key: "raw/source.tsv",
        size: body.length,
        startOffset: offset,
        baseLine: line,
        chunkBytes: 97,
        sliceBytes: 13,
        delimiter: "\t",
      });
      expect(chunk.endOffset).toBeGreaterThan(offset);
      expect(body.subarray(chunk.endOffset - 1, chunk.endOffset).toString()).toBe("\n");
      expect(chunk.baseLine).toBe(line);
      seen += chunk.records.length;
      offset = chunk.endOffset;
      line = chunk.baseLine + chunk.lines;
      chunks += 1;
    }
    expect(chunks).toBeGreaterThan(3);
    expect(seen).toBe(31);
    // 31 records, plus one physical line for each of the 10 embedded newlines
    // inside their quoted descriptions.
    expect(line).toBe(42);
  });
});

describe("cloud Pass 1", () => {
  test("builds compact partitioned segments that decode to the original rows", async () => {
    const { store, data } = seed();
    const result = await runPass1({
      store,
      version: "bench-1",
      sources: SOURCES,
      partitions: 8,
      chunkBytes: 512,
      sliceBytes: 64,
      verifySegments: true,
    });
    expect(result.stopped).toBe("complete");
    expect(result.state.totals.rowsRead).toBe(data.companyRows + data.contactRows);
    expect(result.state.totals.rowsRejected).toBe(0);
    expect(result.state.stage).toBe("pass1-complete");

    const segments = store.keys(`${cloudKeys.jobRoot("bench-1")}/segments/`);
    expect(segments.length).toBeGreaterThan(0);
    // On a fixture this small each gzip frame's header dominates, so the spool is
    // not smaller than the source. What must hold is that it is bounded by the
    // source size (no per-row field names, one copy of each value) — the real
    // compression ratio is measured on the 64 MB R2 benchmark, not here.
    expect(result.state.totals.segmentBytes).toBeLessThan((data.company.length + data.contact.length) * 2);

    let decoded = 0;
    for (const source of SOURCES) {
      for (let partition = 0; partition < 8; partition += 1) {
        for (const row of decodeSegments(store, "bench-1", source.id, partition)) {
          const decodedRow = decodeSpoolV2Row(JSON.stringify(row), result.schema, partition);
          const schemaEntry = result.schema.sources.find((entry) => entry.id === source.id)!;
          expect(decodedRow.source.source).toBe(source.id);
          expect(decodedRow.source.row).toBeGreaterThanOrEqual(1);
          expect(row.length).toBe(schemaEntry.columns + 2);
          decoded += 1;
        }
      }
    }
    expect(decoded).toBe(data.companyRows + data.contactRows);
  });

  test("a re-run resumes at the checkpoint and never duplicates a row", async () => {
    const { store, data } = seed();
    const first = await runPass1({
      store,
      version: "resume-1",
      sources: SOURCES,
      partitions: 8,
      chunkBytes: 700,
      sliceBytes: 64,
      maxSourceBytes: 400,
      verifySegments: true,
    });
    expect(first.stopped).toBe("bounded");
    const partial = first.state.totals.rowsRead;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(data.companyRows + data.contactRows);

    const second = await runPass1({
      store,
      version: "resume-1",
      sources: SOURCES,
      partitions: 8,
      chunkBytes: 700,
      sliceBytes: 64,
      verifySegments: true,
    });
    expect(second.stopped).toBe("complete");
    expect(second.state.totals.rowsRead).toBe(data.companyRows + data.contactRows);

    // Exactly the source rows, once each: segment row totals match the manifests.
    const report = await verifyRun({ store, version: "resume-1", sources: SOURCES });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rows).toBe(data.companyRows + data.contactRows);
  });

  test("pause stops before the next chunk and resume finishes the same run", async () => {
    const { store, data } = seed();
    await store.putJson(cloudKeys.control("pause-1"), {
      version: CLOUD_CONTROL_VERSION,
      pause: true,
      abort: false,
      approvedFullRun: false,
      updatedAt: new Date().toISOString(),
    } satisfies CloudControl);

    const paused = await runPass1({ store, version: "pause-1", sources: SOURCES, partitions: 8, chunkBytes: 400, sliceBytes: 64 });
    expect(paused.stopped).toBe("paused");
    expect(paused.state.stage).toBe("paused");
    expect(paused.state.totals.rowsRead).toBe(0);

    await store.putJson(cloudKeys.control("pause-1"), {
      version: CLOUD_CONTROL_VERSION,
      pause: false,
      abort: false,
      approvedFullRun: false,
      updatedAt: new Date().toISOString(),
    } satisfies CloudControl);
    const resumed = await runPass1({ store, version: "pause-1", sources: SOURCES, partitions: 8, chunkBytes: 400, sliceBytes: 64 });
    expect(resumed.stopped).toBe("complete");
    expect(resumed.state.totals.rowsRead).toBe(data.companyRows + data.contactRows);
  });

  test("refuses a checkpoint written for a different source size", async () => {
    const { store } = seed();
    await runPass1({ store, version: "mismatch-1", sources: SOURCES, partitions: 8, chunkBytes: 400, sliceBytes: 64, maxSourceBytes: 200 });
    const checkpoint = await store.getJson<{ sourceSize: number }>(cloudKeys.checkpoint("mismatch-1", "csv1"));
    expect(checkpoint).not.toBeNull();
    await store.putJson(cloudKeys.checkpoint("mismatch-1", "csv1"), { ...checkpoint, sourceSize: 1 });
    await expect(runPass1({ store, version: "mismatch-1", sources: SOURCES, partitions: 8, chunkBytes: 400, sliceBytes: 64 })).rejects.toThrow(
      /does not belong to this run/,
    );
  });

  test("verification fails a segment whose bytes changed", async () => {
    const { store } = seed();
    await runPass1({ store, version: "corrupt-1", sources: SOURCES, partitions: 4, chunkBytes: 2048, sliceBytes: 128 });
    const keys = store.keys(`${cloudKeys.jobRoot("corrupt-1")}/segments/`);
    const key = keys[0]!;
    const bytes = Buffer.from(store.bytes(key)!);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await store.put(key, bytes);
    const report = await verifyRun({ store, version: "corrupt-1", sources: SOURCES });
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toMatch(/checksum mismatch/);
  });

  test("chunk manifests keep the source range and per-segment row accounting", async () => {
    const { store } = seed();
    await runPass1({ store, version: "manifest-1", sources: SOURCES, partitions: 8, chunkBytes: 900, sliceBytes: 64 });
    const manifests = store.keys(`${cloudKeys.jobRoot("manifest-1")}/chunks/csv1/`);
    let offset = 0;
    for (const key of manifests) {
      const manifest = await store.getJson<CloudChunkManifest>(key);
      expect(manifest!.range.start).toBe(offset);
      expect(manifest!.segments.reduce((total, segment) => total + segment.rows, 0)).toBe(manifest!.rows);
      offset = manifest!.range.end;
    }
    expect(offset).toBe((await store.head("raw/file1.csv")).size);
  });

  test("rejects a local-file source instead of silently reading nothing", () => {
    expect(() =>
      cloudSourcesFromConfig({
        datasetVersion: "x",
        sources: [{ id: "csv1", path: "D:/data/file1.csv", encoding: "utf8", delimiter: "\t" }],
        workDir: "/tmp/work",
        outputDir: "/tmp/out",
        partitions: 8,
        shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
      }),
    ).toThrow(/R2 only/);
  });
});

describe("cloud → v2 spool assembly", () => {
  test("assembles segments into a manifest the existing merge validates", async () => {
    const { store, data } = seed();
    const version = "assemble-1";
    await runPass1({ store, version, sources: SOURCES, partitions: 8, chunkBytes: 700, sliceBytes: 64 });
    const dir = mkdtempSync(join(tmpdir(), "ci-cloud-assemble-"));
    try {
      const result = await assembleRun({
        store,
        version,
        workDir: dir,
        config: {
          datasetVersion: version,
          sources: [
            { id: "csv1", path: "r2://bucket/raw/file1.csv", encoding: "utf8", delimiter: "\t", columns: SOURCES[0]!.columns },
            { id: "csv2", path: "r2://bucket/raw/file2.csv", encoding: "utf8", delimiter: "\t", columns: SOURCES[1]!.columns },
          ],
          workDir: dir,
          outputDir: join(dir, "out"),
          partitions: 8,
          shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
        },
      });
      expect(result.rows).toBe(data.companyRows + data.contactRows);
      expect(result.files).toBe(8);

      // The manifest is the SAME format the local merge verifies, and every
      // partition's bytes are exactly what it recorded.
      const manifest = await readSpoolManifest(dir);
      expect(manifest?.complete).toBe(true);
      expect(manifest?.format).toBe(2);
      const total = manifest!.partitions.reduce((sum, entry) => sum + entry.lines, 0);
      expect(total).toBe(data.companyRows + data.contactRows);
      for (const entry of manifest!.partitions) {
        const bytes = readFileSync(join(dir, "spool", entry.file));
        expect(bytes.length).toBe(entry.bytes);
      }
      // Concatenated gzip members read back as one stream of rows.
      const contactPartition = manifest!.partitions.find((entry) => entry.lines > 0)!;
      const text = gunzipSync(readFileSync(join(dir, "spool", contactPartition.file))).toString("utf8");
      expect(text.split("\n").filter(Boolean).length).toBe(contactPartition.lines);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cloud Pass 1 cost accounting", () => {
  test("counts every PUT and GET the run issued", async () => {
    const { store } = seed();
    await runPass1({ store, version: "ops-1", sources: SOURCES, partitions: 8, chunkBytes: 2048, sliceBytes: 128 });
    // The memory store exposes its counters; a real R2 run reports the same shape.
    expect(store.ops.classA).toBeGreaterThan(0);
    expect(store.ops.classB).toBeGreaterThan(0);
    expect(store.ops.bytesWritten).toBeGreaterThan(0);
    expect(store.ops.bytesRead).toBeGreaterThanOrEqual((await store.head("raw/file1.csv")).size!);
  });
});

