/**
 * One range task: process a byte range of one source into segment objects.
 *
 * This is the parallel unit of the swarm. It writes EXACTLY what Cloud Pass 1
 * writes for one chunk — `segments/<source>/<chunk>/part-NNNN.jsonl.gz`, the
 * rejected rows, and `chunks/<source>/<chunk>.json` — with the chunk index equal to
 * the range index. Everything downstream (the verified Pass 2 merge, which reads
 * chunk manifests in order and concatenates each partition's segments) is therefore
 * unchanged and unaware that 16 containers produced the chunks.
 *
 * What it deliberately does NOT write: the source checkpoint and `state.json`. In a
 * swarm those are aggregate facts — they can only be written once every range of a
 * source has committed — so the coordinator owns them. A worker writes only its own
 * deterministic range keys, which makes a retried or duplicated task harmless.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { companyKeysFromInput, extractCompanyInput, partitionFor } from "../indexer/src/mapping";
import { encodeJsonlLine } from "../indexer/src/jsonl";
import { encodeSpoolV2Row, normalizeValues } from "../indexer/src/spool-v2";
import { cloudKeys, type CloudChunkManifest, type CloudSegmentRef } from "../../src/shared/cloud/types";
import { SWARM, swarmKeys, type SwarmTaskResult } from "../../src/shared/cloud/swarm";

import { readChunk } from "./chunker";
import { ensureSchema, type Pass1SourceSpec } from "./pass1";
import type { BlobStore } from "./store";

export interface RunRangeOptions {
  store: BlobStore;
  version: string;
  /** Every source in the run, in the SAME order Pass 1 uses (the spool schema is positional). */
  sources: Pass1SourceSpec[];
  sourceId: string;
  partitions: number;
  /** Range ordinal; also the chunk index in the chunk manifests. */
  index: number;
  start: number;
  end: number;
  /** Physical source line of the range's first record. */
  baseLine: number;
  /** Re-read every uploaded segment and compare its checksum (default true). */
  verifySegments?: boolean;
  /** Source bytes per inner read (default 64 MiB — the range size). */
  chunkBytes?: number;
  onLog?: (line: string) => void;
}

/**
 * Run one range and return its counters.
 *
 * `start` and `end` are record boundaries chosen by the coordinator (`planSourceRanges`),
 * so no record spans a range: the sub-reader stops at the record that ends exactly at
 * `end`, and the next range begins with the following record.
 */
export async function runRange(options: RunRangeOptions): Promise<SwarmTaskResult> {
  const { store, version } = options;
  const log = options.onLog ?? (() => {});
  const verifySegments = options.verifySegments ?? true;
  const chunkBytes = Math.max(1 << 20, options.chunkBytes ?? SWARM.blockBytes * SWARM.rangeBlocks);

  if (options.start < 0 || options.end <= options.start) {
    throw new Error(`Range ${options.index} has an empty or inverted byte range (${options.start}..${options.end}).`);
  }

  const sourceIndex = options.sources.findIndex((source) => source.id === options.sourceId);
  if (sourceIndex === -1) throw new Error(`Source ${options.sourceId} is not part of this run.`);
  const source = options.sources[sourceIndex]!;
  const head = await store.head(source.key);
  if (!head.exists || head.size === null) throw new Error(`Source ${options.sourceId} is missing at ${source.key}.`);
  if (options.end > head.size) {
    throw new Error(`Range ${options.index} ends at ${options.end} but ${source.key} is only ${head.size} bytes.`);
  }

  const schema = await ensureSchema(store, version, options.sources);
  const sourceSchema = schema.sources[sourceIndex];
  if (!sourceSchema) throw new Error(`The spool schema has no entry for ${options.sourceId}.`);
  const map = sourceSchema.map;
  const columns = sourceSchema.columns;
  const captured = sourceSchema.captured.map((column) => ({ index: column.index, label: column.label }));

  const buckets = new Map<number, string[]>();
  const rejected: string[] = [];
  let rows = 0;
  let rejectedRows = 0;
  let lines = 0;
  let bytesRead = 0;

  let offset = options.start;
  let baseLine = options.baseLine;
  while (offset < options.end) {
    /*
     * `chunkBytes` is clamped to the remaining range so the parser stops exactly at
     * `end`. Passing the full 64 MiB for a smaller tail would read past the cut and
     * hand the next range's rows to this one.
     */
    const chunk = await readChunk({
      store,
      key: source.key,
      size: head.size,
      startOffset: offset,
      baseLine,
      chunkBytes: Math.min(chunkBytes, options.end - offset),
      sliceBytes: SWARM.sliceBytes,
      delimiter: source.delimiter,
      quote: source.quote,
    });
    if (chunk.records.length === 0) break;

    // The header is a record only at the very start of the file.
    const dataRecords = offset === 0 ? chunk.records.slice(1) : chunk.records;
    for (const record of dataRecords) {
      if (record.fields.every((field) => field.trim() === "")) continue;
      const input = extractCompanyInput(record.fields, map, captured);
      if (!input) {
        rejectedRows += 1;
        rejected.push(
          encodeJsonlLine({ source: source.id, line: record.line, reason: "missing_company_name", fields: record.fields.slice(0, 8) }),
        );
        continue;
      }
      rows += 1;
      const keys = companyKeysFromInput(input, source.id);
      const partition = partitionFor(keys.partitionKey, options.partitions);
      const line = encodeSpoolV2Row(sourceIndex, record.line, normalizeValues(record.fields, columns));
      const bucket = buckets.get(partition);
      if (bucket) bucket.push(line);
      else buckets.set(partition, [line]);
    }

    lines += chunk.lines;
    bytesRead += chunk.endOffset - offset;
    offset = chunk.endOffset;
    baseLine = chunk.baseLine + chunk.lines;
    if (chunk.endOffset <= chunk.startOffset) break;
  }

  const segments: CloudSegmentRef[] = [];
  let segmentBytes = 0;
  let classA = 0;
  await Promise.all(
    [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(async ([partition, partitionLines]) => {
        const body = gzipSync(Buffer.from(`${partitionLines.join("\n")}\n`, "utf8"), { level: 6 });
        const key = cloudKeys.segment(version, source.id, options.index, partition);
        await store.put(key, body, "application/gzip");
        classA += 1;
        if (verifySegments) {
          const readBack = await store.getRange(key, 0, body.length);
          if (readBack.length !== body.length || sha256(readBack) !== sha256(body)) {
            throw new Error(`Segment verification failed for ${key}: uploaded ${body.length} B, read back ${readBack.length} B.`);
          }
        }
        segmentBytes += body.length;
        segments.push({ partition, key, bytes: body.length, rows: partitionLines.length, sha256: sha256(body) });
      }),
  );
  segments.sort((a, b) => a.partition - b.partition);

  let rejectedKey: string | null = null;
  if (rejected.length) {
    const body = gzipSync(Buffer.from(`${rejected.join("\n")}\n`, "utf8"), { level: 6 });
    rejectedKey = cloudKeys.rejected(version, source.id, options.index);
    await store.put(rejectedKey, body, "application/gzip");
    classA += 1;
  }

  const covered = offset - options.start;
  const manifest: CloudChunkManifest = {
    engine: "cloud-pass1-v1",
    jobId: version,
    version,
    sourceId: source.id,
    sourceKey: source.key,
    sourceEtag: head.etag,
    sourceSize: head.size,
    chunk: options.index,
    range: { start: options.start, end: offset },
    baseLine: options.baseLine,
    rows,
    rejected: rejectedRows,
    lines,
    segments,
    rejectedKey,
    completedAt: new Date().toISOString(),
    complete: true,
  };
  await store.putJson(cloudKeys.chunkManifest(version, source.id, options.index), manifest);
  classA += 1;

  const counters =
    "countersSnapshot" in store && typeof (store as { countersSnapshot?: () => unknown }).countersSnapshot === "function"
      ? (store as { countersSnapshot: () => { classA: number; classB: number } }).countersSnapshot()
      : null;

  const result: SwarmTaskResult = {
    rows,
    rejected: rejectedRows,
    segments: segments.length,
    segmentBytes,
    bytesRead,
    classA,
    classB: counters?.classB ?? 0,
    note: `${source.id} range ${options.index}: ${(covered / (1024 * 1024)).toFixed(0)} MiB, ${rows.toLocaleString()} rows`,
  };
  await store.putJson(swarmKeys.rangeResult(version, source.id, options.index), {
    ...result,
    index: options.index,
    start: options.start,
    end: offset,
    baseLine: options.baseLine,
    partitions: segments.length,
    completedAt: manifest.completedAt,
  });
  classA += 1;

  log(
    `${source.id} range ${options.index}: ${rows.toLocaleString()} rows, ${rejectedRows} rejected, ` +
      `${segments.length} segment(s), ${(segmentBytes / (1024 * 1024)).toFixed(1)} MiB spool`,
  );
  return result;
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
