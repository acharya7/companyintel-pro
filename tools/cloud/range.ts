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
 *
 * Bounded memory
 *   A range's length is a property of the DATA, not of the plan: a cut is only legal
 *   at a record boundary, so a run of blocks without one produces a range far larger
 *   than the nominal 128 MiB. The previous implementation kept every row of the range
 *   in a `Map<partition, string[]>` and gzipped each partition with `gzipSync`, so peak
 *   heap grew with the range — and a several-gigabyte range inside a 6 GiB container is
 *   exactly the shape that ends in SIGKILL.
 *
 *   This version parses the range in fixed windows (`SWARM.rangeChunkBytes`), streams
 *   each partition's rows straight into its own gzip file on the container's disk, and
 *   uploads one finished segment at a time. Peak heap is now a property of the window,
 *   not of the range; the range itself stays one atomic, idempotent unit.
 *
 * Atomic completion
 *   The chunk manifest is written LAST, and only after the loop has proved it covered
 *   `end - start` bytes exactly. A killed attempt leaves segments behind (same keys,
 *   same bytes on a retry) but no manifest, and a range without a manifest is never
 *   counted as done by the coordinator or by Pass 2.
 */

import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { WriteStream } from "node:fs";
import { createGzip, type Gzip } from "node:zlib";

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
  /**
   * Source bytes per parse window (default `SWARM.rangeChunkBytes`, 8 MiB).
   *
   * This is NOT the range length: it only bounds how much of the range is held in
   * memory at once. Tests lower it to exercise multi-window ranges.
   */
  chunkBytes?: number;
  /** Directory for the per-range spool (default the OS temp dir). */
  spoolDir?: string;
  /** Bytes a single range may spool to disk before the task refuses (default 8 GiB). */
  maxSpoolBytes?: number;
  onLog?: (line: string) => void;
}

/** One partition's rows, streamed straight into its own gzip file. */
interface PartitionSpool {
  path: string;
  gzip: Gzip;
  closed: Promise<void>;
  rows: number;
  bytes: number;
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
  // A window can be made smaller (diagnostics and tests), never unbounded.
  const chunkBytes = Math.max(64 << 10, options.chunkBytes ?? SWARM.rangeChunkBytes);
  const maxSpoolBytes = options.maxSpoolBytes ?? SWARM.maxRangeSpoolBytes;

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

  const workDir = mkdtempSync(join(options.spoolDir ?? tmpdir(), `companyintel-range-${options.index}-`));
  const spools = new Map<number, PartitionSpool>();
  const files: WriteStream[] = [];
  let rejectedSpool: PartitionSpool | null = null;
  let spooledBytes = 0;

  /** A spool whose `closed` promise is never awaited must not raise an unhandled rejection. */
  const spoolStreams = (path: string): { gzip: Gzip; closed: Promise<void> } => {
    const file = createWriteStream(path);
    files.push(file);
    const gzip = createGzip({ level: 6 });
    gzip.pipe(file);
    const closed = new Promise<void>((resolve, reject) => {
      file.on("close", () => resolve());
      file.on("error", reject);
      gzip.on("error", reject);
    });
    // Cleanup (or a failed task) destroys the streams before they are finished; the
    // rejection is reported to whoever awaits `closed`, and handled here so a task that
    // is already failing does not also crash the process.
    void closed.catch(() => undefined);
    return { gzip, closed };
  };

  const spoolFor = (partition: number): PartitionSpool => {
    const existing = spools.get(partition);
    if (existing) return existing;
    const path = join(workDir, `part-${String(partition).padStart(4, "0")}.jsonl.gz`);
    const spool: PartitionSpool = { path, ...spoolStreams(path), rows: 0, bytes: 0 };
    spools.set(partition, spool);
    return spool;
  };

  const write = async (spool: PartitionSpool, text: string, rows: number): Promise<void> => {
    spooledBytes += Buffer.byteLength(text, "utf8");
    if (spooledBytes > maxSpoolBytes) {
      throw new Error(
        `Range ${options.index} would spool more than ${Math.round(maxSpoolBytes / (1024 * 1024))} MB; ` +
          "refusing rather than filling the container's disk. The range is unreasonably large for one task.",
      );
    }
    spool.rows += rows;
    if (!spool.gzip.write(text)) await once(spool.gzip, "drain");
  };

  try {
    let rows = 0;
    let rejectedRows = 0;
    let lines = 0;
    let bytesRead = 0;
    let offset = options.start;
    let baseLine = options.baseLine;

    while (offset < options.end) {
      /*
       * `chunkBytes` is clamped to the remaining range so the parser stops exactly at
       * `end`. Passing the full window for a smaller tail would read past the cut and
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
        maxRecordBytes: SWARM.maxRecordBytes,
      });
      if (chunk.records.length === 0) {
        // Never "finish" a range that produced nothing: a manifest here would claim
        // bytes that were never parsed, and Pass 2 would merge a hole.
        throw new Error(
          `Range ${options.index} read no record between ${offset} and ${options.end}; refusing to write a partial chunk.`,
        );
      }
      if (chunk.endOffset <= offset) {
        throw new Error(`Range ${options.index} made no progress at byte ${offset}; refusing to loop on the same bytes.`);
      }

      // The header is a record only at the very start of the file.
      const dataRecords = offset === 0 ? chunk.records.slice(1) : chunk.records;
      // Per-window buckets: at most one window's rows are ever in memory.
      const buckets = new Map<number, string[]>();
      for (const record of dataRecords) {
        if (record.fields.every((field) => field.trim() === "")) continue;
        const input = extractCompanyInput(record.fields, map, captured);
        if (!input) {
          rejectedRows += 1;
          const line = encodeJsonlLine({
            source: source.id,
            line: record.line,
            reason: "missing_company_name",
            fields: record.fields.slice(0, 8),
          });
          if (!rejectedSpool) {
            const path = join(workDir, "rejected.jsonl.gz");
            rejectedSpool = { path, ...spoolStreams(path), rows: 0, bytes: 0 };
          }
          await write(rejectedSpool, `${line}\n`, 1);
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

      // Flush this window into each partition's spool, then drop it.
      for (const [partition, partitionLines] of buckets) {
        if (!partitionLines.length) continue;
        await write(spoolFor(partition), `${partitionLines.join("\n")}\n`, partitionLines.length);
      }
      buckets.clear();

      lines += chunk.lines;
      bytesRead += chunk.endOffset - offset;
      offset = chunk.endOffset;
      baseLine = chunk.baseLine + chunk.lines;
    }

    /*
     * The end of the range must be the exact byte the coordinator leased — not "close".
     * Anything else means bytes between the last record and `end` were never parsed,
     * and a manifest for them would be a lie that Pass 2 cannot detect.
     */
    if (offset !== options.end) {
      throw new Error(
        `Range ${options.index} stopped at ${offset}, ${options.end - offset} byte(s) short of ${options.end}; ` +
          "refusing to write a complete chunk manifest for a partial range.",
      );
    }

    const segments: CloudSegmentRef[] = [];
    let segmentBytes = 0;
    let classA = 0;
    for (const partition of [...spools.keys()].sort((a, b) => a - b)) {
      const spool = spools.get(partition)!;
      spool.gzip.end();
      await spool.closed;
      const body = readFileSync(spool.path);
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
      segments.push({ partition, key, bytes: body.length, rows: spool.rows, sha256: sha256(body) });
      // Free the compressed bytes before the next partition is read.
      rmSync(spool.path, { force: true });
    }

    let rejectedKey: string | null = null;
    if (rejectedSpool && rejectedRows > 0) {
      rejectedSpool.gzip.end();
      await rejectedSpool.closed;
      const body = readFileSync(rejectedSpool.path);
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
  } finally {
    // A killed attempt can never run this, which is safe: keys are deterministic, the
    // next attempt overwrites them, and the temp directory is per-process.
    for (const spool of spools.values()) spool.gzip.destroy();
    if (rejectedSpool) rejectedSpool.gzip.destroy();
    for (const file of files) file.destroy();
    rmSync(workDir, { recursive: true, force: true });
  }
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
