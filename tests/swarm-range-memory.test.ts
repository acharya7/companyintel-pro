/**
 * Range processing under a memory bound.
 *
 * Production's remaining ranges are the oversized ones: 14 ranges hold 15.116 GB, so a
 * single task can span gigabytes where the plan nominally cuts every 128 MiB. The
 * previous executor held every row of the range in a `Map<partition, string[]>` and
 * gzipped each partition synchronously, so peak heap tracked the range's length — the
 * shape that ends in a SIGKILL inside a 6 GiB container.
 *
 * What is asserted here:
 *   - the range is parsed in fixed windows, and the window size does not change the
 *     spool: 1 KiB windows produce the SAME bytes as one window and as Pass 1;
 *   - every window writes to disk and is released, so the temp spool is always cleaned
 *     up, on success and on failure;
 *   - a range that stops short of its leased end throws and writes NO chunk manifest, so
 *     it can never be counted as complete or merged as a hole;
 *   - a single pathological record is refused with its offset instead of buffered until
 *     the process dies.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { cloudKeys } from "../src/shared/cloud/types";
import { planSourceRanges, type SwarmBlockDescriptor } from "../src/shared/cloud/swarm";
import { scanBlock } from "../tools/cloud/blocks";
import { readChunk } from "../tools/cloud/chunker";
import { runPass1, type Pass1SourceSpec } from "../tools/cloud/pass1";
import { runRange } from "../tools/cloud/range";
import { MemoryBlobStore } from "../tools/cloud/store";

const HEADER = `"Company Name","Website","Industry","Country","Contact Name","Job Title","Email"`;

/** Rows with quoted newlines, escaped quotes, commas and non-ASCII text. */
function corpus(): string {
  const rows: string[] = [];
  for (let index = 0; index < 60; index += 1) {
    rows.push(
      `"Company ${index}, Ltd","https://company${index}.example","Software","United States","Person ${index}","Engineer","person${index}@company${index}.example"`,
    );
    if (index % 7 === 0) {
      rows.push(
        `"Multiline ${index}","https://multi${index}.example","Analytics","India","Contact ${index}","Head of\nData, ""Analytics""","contact${index}@multi${index}.example"`,
      );
    }
    if (index % 11 === 0) rows.push(`"Café 東京 ${index}","https://cafe${index}.example","Hospitality","Japan","佐藤 ${index}","Manager","cafe${index}@cafe.example"`);
  }
  return `${[HEADER, ...rows].join("\n")}\n`;
}

const CSV = corpus();
const SOURCE: Pass1SourceSpec = { id: "s1", key: "raw/s1.csv", delimiter: "," };

function storeFor(): { store: MemoryBlobStore; size: number } {
  const body = Buffer.from(CSV, "utf8");
  return { store: new MemoryBlobStore({ [SOURCE.key]: body }), size: body.length };
}

async function blocksFor(store: MemoryBlobStore, size: number, blockBytes: number): Promise<SwarmBlockDescriptor[]> {
  const blocks: SwarmBlockDescriptor[] = [];
  const count = Math.ceil(size / blockBytes);
  for (let index = 0; index < count; index += 1) {
    blocks.push(await scanBlock({ store, version: "range-window", sourceId: SOURCE.id, key: SOURCE.key, size, index, blockBytes }));
  }
  return blocks;
}

/** Decompressed rows per partition, in chunk order (exactly what Pass 2 concatenates). */
function partitionRows(store: MemoryBlobStore, version: string, chunks: number, partitions: number): string[] {
  const out: string[] = [];
  for (let partition = 0; partition < partitions; partition += 1) {
    let text = "";
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const body = store.bytes(cloudKeys.segment(version, SOURCE.id, chunk, partition));
      if (body) text += gunzipSync(body).toString("utf8");
    }
    out.push(text);
  }
  return out;
}

async function rangesFor(blockBytes: number, rangeBlocks: number) {
  const { store, size } = storeFor();
  const blocks = await blocksFor(store, size, blockBytes);
  return { store, size, ...planSourceRanges(size, blocks, { rangeBlocks }) };
}

describe("bounded-memory range processing", () => {
  test("a small parse window produces identical spool bytes to one window and to Pass 1", async () => {
    const { size, ranges } = await rangesFor(2048, 2);
    expect(ranges.length).toBeGreaterThan(1);
    const partitions = 8;

    const referenceStore = storeFor().store;
    const reference = await runPass1({
      store: referenceStore,
      version: "reference",
      sources: [SOURCE],
      partitions,
      chunkBytes: size,
      mode: "full",
      verifySegments: true,
      onLog: () => {},
    });
    expect(reference.stopped).toBe("complete");
    const referenceRows = partitionRows(referenceStore, "reference", 1, partitions);

    const whole = storeFor().store;
    for (const range of ranges) {
      await runRange({
        store: whole,
        version: "whole",
        sources: [SOURCE],
        sourceId: SOURCE.id,
        partitions,
        index: range.index,
        start: range.start,
        end: range.end,
        baseLine: range.baseLine,
        verifySegments: true,
        chunkBytes: 32 << 20,
      });
    }

    const windowed = storeFor().store;
    const spoolDir = mkdtempSync(join(tmpdir(), "range-spool-test-"));
    try {
      for (const range of ranges) {
        await runRange({
          store: windowed,
          version: "windowed",
          sources: [SOURCE],
          sourceId: SOURCE.id,
          partitions,
          index: range.index,
          start: range.start,
          end: range.end,
          baseLine: range.baseLine,
          verifySegments: true,
          // Four-plus windows per range: the point of the test.
          chunkBytes: 1 << 10,
          spoolDir,
        });
      }
      // Every temp spool is removed, whatever the window count.
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }

    for (let partition = 0; partition < partitions; partition += 1) {
      expect(partitionRows(windowed, "windowed", ranges.length, partitions)[partition]).toBe(
        partitionRows(whole, "whole", ranges.length, partitions)[partition],
      );
      expect(partitionRows(windowed, "windowed", ranges.length, partitions)[partition]).toBe(referenceRows[partition]);
    }

    // Each manifest claims exactly the bytes its task leased, and the chain covers the
    // source once: no gap and no overlap, whatever the window size.
    let covered = 0;
    for (const range of ranges) {
      const manifest = await windowed.getJson<{ chunk: number; complete: boolean; range: { start: number; end: number }; rows: number }>(
        cloudKeys.chunkManifest("windowed", SOURCE.id, range.index),
      );
      expect(manifest).not.toBeNull();
      expect(manifest!.complete).toBe(true);
      expect(manifest!.range).toEqual({ start: range.start, end: range.end });
      expect(manifest!.rows).toBeGreaterThan(0);
      covered += manifest!.range.end - manifest!.range.start;
    }
    expect(covered).toBe(size);
  }, 120_000);

  test("a range that cannot reach its end writes no manifest and fails loudly", async () => {
    const { size } = storeFor();
    const truncated = new MemoryBlobStore({ [SOURCE.key]: Buffer.from(CSV, "utf8") });
    /*
     * HEAD says the object is bigger than the bytes that can be read (a truncated or
     * inconsistent source), while cloud objects read back normally. A range that cannot
     * reach its leased end must NOT present itself as complete: Pass 2 has no way to
     * detect a hole a manifest claims to have covered.
     */
    const originalHead = truncated.head.bind(truncated);
    truncated.head = async (key: string) => {
      const info = await originalHead(key);
      return key.startsWith("raw/") ? { ...info, size: (info.size ?? 0) + 5000 } : info;
    };
    const originalGet = truncated.getRange.bind(truncated);
    truncated.getRange = async (key, offset, length) =>
      key.startsWith("raw/") ? originalGet(key, offset, Math.min(length, 200)) : originalGet(key, offset, length);

    const index = 0;
    await expect(
      runRange({
        store: truncated,
        version: "short",
        sources: [SOURCE],
        sourceId: SOURCE.id,
        partitions: 4,
        index,
        start: 0,
        end: size + 5000,
        baseLine: 1,
        chunkBytes: 512,
        verifySegments: true,
      }),
    ).rejects.toThrow(/partial range|read no record|made no progress/);

    expect(await truncated.getJson(cloudKeys.chunkManifest("short", SOURCE.id, index))).toBeNull();
    expect(await truncated.getJson(`cloud/jobs/short/swarm/ranges/${SOURCE.id}/000000.json`)).toBeNull();
  });

  test("the temp spool is removed even when the range throws", async () => {
    const spoolDir = mkdtempSync(join(tmpdir(), "range-spool-fail-"));
    const store = new MemoryBlobStore({ [SOURCE.key]: Buffer.from(CSV, "utf8") });
    try {
      await expect(
        runRange({
          store,
          version: "fail",
          sources: [SOURCE],
          sourceId: SOURCE.id,
          partitions: 4,
          index: 0,
          start: 0,
          end: 1,
          baseLine: 1,
          spoolDir,
        }),
      ).rejects.toThrow();
      expect(existsSync(spoolDir)).toBe(true);
      expect(readdirSync(spoolDir)).toHaveLength(0);
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });
});

describe("a pathological record is refused instead of buffered", () => {
  test("readChunk reports the offset of a record that never ends", async () => {
    // One quoted field that never closes: no newline outside quotes, so the parser keeps
    // growing a buffer. The guard must fire long before the container runs out of memory.
    const body = Buffer.from(`"Company","Notes"\n"Acme","${"x".repeat(300_000)}`, "utf8");
    const store = new MemoryBlobStore({ "raw/big.csv": body });
    await expect(
      readChunk({
        store,
        key: "raw/big.csv",
        size: body.length,
        startOffset: 0,
        baseLine: 1,
        chunkBytes: 64 << 10,
        sliceBytes: 64 << 10,
        maxRecordBytes: 128 << 10,
      }),
    ).rejects.toThrow(/without ending/);
  });
});
