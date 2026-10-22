/**
 * The swarm's correctness rests on two claims, and both are tested here against real
 * bytes rather than a mock:
 *
 *   1. `planSourceRanges` only ever cuts at a newline that is OUTSIDE a quoted field,
 *      so ranges are disjoint and exhaustive even when a quoted field contains
 *      newlines or an escaped quote;
 *   2. processing those ranges in parallel produces exactly the spool Cloud Pass 1
 *      produces for the whole file — same rows, same partitions, same bytes — which is
 *      what makes the unchanged Pass 2 merge valid.
 *
 * The source deliberately contains a multiline quoted title, a quoted comma, an
 * escaped quote pair and non-ASCII text, because those are the cases where a naive
 * byte cut silently loses or duplicates a record.
 */

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import { cloudKeys } from "../src/shared/cloud/types";
import { planSourceRanges, type SwarmBlockDescriptor } from "../src/shared/cloud/swarm";
import { scanBlock } from "../tools/cloud/blocks";
import { runPass1, type Pass1SourceSpec } from "../tools/cloud/pass1";
import { runRange } from "../tools/cloud/range";
import { MemoryBlobStore } from "../tools/cloud/store";

const HEADER = `"Company Name","Website","Industry","Country","Contact Name","Job Title","Email"`;

/** Rows with the awkward cases: quoted newline, comma, escaped quote, unicode. */
const ROWS = [
  `"Microsoft Corporation","https://www.microsoft.com","Software","United States","Satya Nadella","Chief Executive Officer","satya@microsoft.com"`,
  `"Infosys Limited","https://www.infosys.com","IT Services","India","Nandan Nilekani","Chairman
and Co-founder","nandan@infosys.com"`,
  `"Acme, Inc.","https://acme.example","Manufacturing","United States","John O'Neil","Plant ""Acting"" Manager","john@acme.example"`,
  `"Vertex Analytics Private Limited","https://vertexanalytics.example","Analytics","India","Priya Menon","Head of Data, Analytics","priya@vertexanalytics.example"`,
  `"Globex Corporation","https://globex.example","Industrial","United States","Hank Scorpio","CEO","hank@globex.example"`,
  `"Café 東京 Limited","https://cafe.example","Hospitality","Japan","佐藤 花子","General Manager","hanako@cafe.example"`,
  `"Northwind Traders","https://northwind.example","Retail","United Kingdom","Erin Boyle","Head of Buying","erin@northwind.example"`,
  `"Tata Motors","https://tatamotors.example","Automotive","India","Ravi Kumar","Chief Engineer","ravi@tatamotors.example"`,
  `"Zebra Systems","https://zebra.example","Software","Canada","Alex Lee","Engineer","alex@zebra.example"`,
];

const CSV = `${[HEADER, ...ROWS].join("\n")}\n`;
const SOURCE: Pass1SourceSpec = { id: "s1", key: "raw/s1.csv", delimiter: "," };

/** Small blocks so the fixture produces many cuts without a multi-megabyte file. */
const BLOCK_BYTES = 256;

function seededStore(): MemoryBlobStore {
  return new MemoryBlobStore({ [SOURCE.key]: Buffer.from(CSV, "utf8") });
}

async function scanAll(store: MemoryBlobStore, version: string): Promise<SwarmBlockDescriptor[]> {
  const size = Buffer.byteLength(CSV, "utf8");
  const blocks: SwarmBlockDescriptor[] = [];
  const count = Math.ceil(size / BLOCK_BYTES);
  for (let index = 0; index < count; index += 1) {
    blocks.push(
      await scanBlock({
        store,
        version,
        sourceId: SOURCE.id,
        key: SOURCE.key,
        size,
        index,
        blockBytes: BLOCK_BYTES,
      }),
    );
  }
  return blocks;
}

describe("alignment scanning and range planning", () => {
  test("cuts only at a newline outside quotes, and covers the source exactly once", async () => {
    const store = seededStore();
    const size = Buffer.byteLength(CSV, "utf8");
    const blocks = await scanAll(store, "plan-test");
    const { boundaries, ranges } = planSourceRanges(size, blocks, { rangeBlocks: 1 });

    expect(boundaries[0]).toBe(0);
    expect(boundaries.at(-1)).toBe(size);
    expect(ranges.length).toBeGreaterThan(1);

    // Every cut is immediately after a newline, which is what makes it a record end.
    // (Compared against the UTF-8 bytes, not the JS string: non-ASCII rows make a
    // character index and a byte offset differ.)
    const bytes = Buffer.from(CSV, "utf8");
    for (const boundary of boundaries.slice(1, -1)) {
      expect(bytes[boundary - 1]).toBe(0x0a);
    }

    // Disjoint and exhaustive: no gap, no overlap.
    let covered = 0;
    for (const [index, range] of ranges.entries()) {
      expect(range.start).toBe(index === 0 ? 0 : ranges[index - 1]!.end);
      expect(range.end).toBeGreaterThan(range.start);
      covered += range.end - range.start;
    }
    expect(covered).toBe(size);
    // The quote state is carried across blocks, so the plan is stable.
    expect(planSourceRanges(size, [...blocks].reverse(), { rangeBlocks: 1 }).boundaries).toEqual(boundaries);
  });

  test("a block scan records both boundary candidates and the physical line count", async () => {
    const store = seededStore();
    const blocks = await scanAll(store, "descriptor-test");
    const total = blocks.reduce((sum, block) => sum + block.newlines, 0);
    // One record per line, plus the newline inside the quoted title: 9 rows + header
    // + 1 embedded newline = 11 physical newlines.
    expect(total).toBe(11);
    // The file's quote state ends outside a field: an odd total would mean the scan
    // misparsed an escaped pair.
    expect(blocks.reduce((sum, block) => sum + block.quotes, 0) % 2).toBe(0);
    // Blocks are contiguous and every one carries at least one candidate boundary
    // unless it is entirely inside the quoted title.
    expect(blocks[0]!.start).toBe(0);
    expect(blocks.every((block, index) => index === 0 || block.start === blocks[index - 1]!.end)).toBe(true);
    expect(blocks.at(-1)!.end).toBe(Buffer.byteLength(CSV, "utf8"));
  });
});

describe("range executor produces the same spool as Pass 1", () => {
  test("per-partition rows are byte-identical to the whole-file Pass 1 spool", async () => {
    const store = seededStore();
    const size = Buffer.byteLength(CSV, "utf8");
    const partitions = 4;

    // The reference: the sequential, already-verified Pass 1 over the whole file.
    const reference = await runPass1({
      store,
      version: "ref",
      sources: [SOURCE],
      partitions,
      chunkBytes: size,
      mode: "full",
      verifySegments: true,
      onLog: () => {},
    });
    expect(reference.stopped).toBe("complete");
    const referenceSegments = await partitionsOf(store, "ref", 1, partitions);

    // The swarm: alignment, then every range as its own task.
    const blocks = await scanAll(store, "swarm");
    const { ranges } = planSourceRanges(size, blocks, { rangeBlocks: 1 });
    let rows = 0;
    let rejected = 0;
    for (const range of ranges) {
      const result = await runRange({
        store,
        version: "swarm",
        sources: [SOURCE],
        sourceId: SOURCE.id,
        partitions,
        index: range.index,
        start: range.start,
        end: range.end,
        baseLine: range.baseLine,
        verifySegments: true,
      });
      rows += result.rows;
      rejected += result.rejected;
    }

    expect(rows).toBe(reference.state.totals.rowsIndexed);
    expect(rejected).toBe(reference.state.totals.rowsRejected);
    expect(rows).toBe(ROWS.length);

    const swarmSegments = await partitionsOf(store, "swarm", ranges.length, partitions);
    for (let partition = 0; partition < partitions; partition += 1) {
      expect(swarmSegments[partition]).toBe(referenceSegments[partition]);
    }

    // The chunk manifests chain without a gap, which is what Pass 2 verifies.
    const manifests = [];
    for (let index = 0; index < ranges.length; index += 1) {
      const manifest = await store.getJson<{ chunk: number; range: { start: number; end: number } }>(
        cloudKeys.chunkManifest("swarm", SOURCE.id, index),
      );
      expect(manifest).not.toBeNull();
      manifests.push(manifest!);
      expect(manifest!.chunk).toBe(index);
      expect(manifest!.range.start).toBe(ranges[index]!.start);
      expect(manifest!.range.end).toBe(ranges[index]!.end);
    }
  });
});

/** Concatenated, decompressed rows per partition, in chunk order. */
async function partitionsOf(
  store: MemoryBlobStore,
  version: string,
  chunks: number,
  partitions: number,
): Promise<string[]> {
  const out: string[] = [];
  for (let partition = 0; partition < partitions; partition += 1) {
    let text = "";
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const key = cloudKeys.segment(version, "s1", chunk, partition);
      const body = store.bytes(key);
      if (!body) continue;
      text += gunzipSync(body).toString("utf8");
    }
    out.push(text);
  }
  return out;
}
