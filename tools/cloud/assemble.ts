/**
 * Assemble cloud Pass 1 segments into a local v2 spool.
 *
 * This is the compatibility bridge that lets the EXISTING, tested Pass 2 run on
 * cloud output without a second merge implementation:
 *
 *   - each partition's segment objects are concatenated in chunk order (concatenated
 *     gzip members are a valid gzip stream, so no decompress/recompress is needed);
 *   - the SHA-256, row count and frame count of the result are recomputed locally;
 *   - `progress.json`, `spool-manifest.json` and a `pass2-merge` checkpoint are
 *     written in exactly the formats `tools/indexer/src/build.ts` validates.
 *
 * The merge then treats the result like any other verified spool: it re-hashes
 * every partition, refuses a mismatch, and resolves companies/contacts with the
 * unchanged single-process logic — which is the equivalence proof for a bounded
 * cloud run.
 *
 * Disk note: the assembled spool is ~23 GB for the full corpus. A Cloudflare
 * container has at most 20 GB of ephemeral disk, so a full-corpus merge must
 * stream (see docs/cloud.md); assembly is for bounded runs and for an operator
 * with local disk.
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { IndexerConfig } from "../indexer/src/build";
import { identityFor } from "../indexer/src/build";
import { SPOOL_FORMAT_VERSION, spoolV2SidecarName, type SpoolFrameEntry, type SpoolProgress, type SpoolSchema } from "../indexer/src/spool-v2";
import type { SpoolManifest } from "../indexer/src/spool";
import { cloudKeys, type CloudChunkManifest } from "../../src/shared/cloud/types";

import type { SourceCheckpoint } from "./pass1";
import type { BlobStore } from "./store";

export interface AssembleResult {
  workDir: string;
  partitions: number;
  rows: number;
  bytes: number;
  files: number;
}

export async function assembleRun(options: {
  store: BlobStore;
  version: string;
  config: IndexerConfig;
  workDir: string;
  onLog?: (line: string) => void;
}): Promise<AssembleResult> {
  const workDir = resolve(options.workDir);
  const spoolDir = join(workDir, "spool");
  if (existsSync(spoolDir) && readdirSync(spoolDir).some((name) => /^part-\d{4}\.jsonl\.gz$/.test(name))) {
    throw new Error(`${spoolDir} already contains spool partitions. Assembly writes into a NEW directory; nothing was touched.`);
  }
  mkdirSync(spoolDir, { recursive: true });

  const schema = await options.store.getJson<SpoolSchema>(cloudKeys.schema(options.version));
  if (!schema) throw new Error(`No cloud schema at ${cloudKeys.schema(options.version)}; the job has no verified Pass 1 output.`);

  const checkpoints: SourceCheckpoint[] = [];
  for (const source of options.config.sources) {
    const checkpoint = await options.store.getJson<SourceCheckpoint>(cloudKeys.checkpoint(options.version, source.id));
    if (!checkpoint) throw new Error(`No checkpoint for ${source.id}; Pass 1 did not produce a resumable result.`);
    if (!checkpoint.complete) throw new Error(`${source.id} is incomplete (${checkpoint.nextOffset} of ${checkpoint.sourceSize} bytes). Finish Pass 1 before assembling.`);
    checkpoints.push(checkpoint);
  }

  const identity = { ...identityFor({ ...options.config, datasetVersion: options.version }, undefined) };
  const partitions = options.config.partitions;
  const entries: SpoolManifest["partitions"] = [];
  let totalRows = 0;
  let totalBytes = 0;

  for (let partition = 0; partition < partitions; partition += 1) {
    const file = `part-${String(partition).padStart(4, "0")}.jsonl.gz`;
    const path = join(spoolDir, file);
    const hash = createHash("sha256");
    const ledger: SpoolFrameEntry[] = [];
    let rows = 0;
    let frames = 0;
    let offset = 0;
    const chunks = Math.max(...checkpoints.map((entry) => entry.chunks), 0);
    const stream = createWriteStream(path);
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      for (const checkpoint of checkpoints) {
        if (chunk >= checkpoint.chunks) continue;
        const key = cloudKeys.segment(options.version, checkpoint.sourceId, chunk, partition);
        const head = await options.store.head(key);
        if (!head.exists || head.size === null) continue;
        const body = await options.store.getRange(key, 0, head.size);
        const info = await segmentInfo(options.store, options.version, checkpoint.sourceId, chunk, partition);
        ledger.push({ offset, bytes: body.length, rows: info.rows, sha256: info.sha256 });
        hash.update(body);
        offset += body.length;
        frames += 1;
        await new Promise<void>((resolveWrite, rejectWrite) => {
          stream.write(body, (error) => (error ? rejectWrite(error) : resolveWrite()));
        });
        rows += info.rows;
      }
    }
    await new Promise<void>((resolveEnd, rejectEnd) => stream.end((error?: Error | null) => (error ? rejectEnd(error) : resolveEnd())));
    if (!frames) {
      // An empty partition is legal: no company key hashes to it. The merge expects
      // a file for every manifest entry, and an empty gzip member is a valid one.
      const { gzipSync } = await import("node:zlib");
      const { createHash } = await import("node:crypto");
      const empty = gzipSync(Buffer.alloc(0));
      writeFileSync(path, empty);
      hash.update(empty);
      ledger.push({ offset: 0, bytes: empty.length, rows: 0, sha256: createHash("sha256").update(empty).digest("hex") });
      offset = empty.length;
      frames = 1;
    }
    const bytes = statSync(path).size;
    const sha256 = hash.digest("hex");
    writeFileSync(join(spoolDir, spoolV2SidecarName(partition)), ledger.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
    entries.push({ file, partition, bytes, lines: rows, sha256, frames });
    totalRows += rows;
    totalBytes += bytes;
    options.onLog?.(`partition ${partition + 1}/${partitions}: ${rows.toLocaleString()} rows, ${(bytes / 1e6).toFixed(1)} MB, ${frames} frame(s)`);
  }

  const now = new Date().toISOString();
  const progress: SpoolProgress = {
    format: SPOOL_FORMAT_VERSION,
    identity,
    schema,
    createdAt: now,
    updatedAt: now,
    status: "pass1-complete",
    sources: Object.fromEntries(
      checkpoints.map((checkpoint) => [checkpoint.sourceId, { rowsRead: checkpoint.rows, rowsRejected: checkpoint.rejected, complete: true }]),
    ),
    partitions: Object.fromEntries(
      entries.map((entry) => [String(entry.partition), { partition: entry.partition, file: entry.file, bytes: entry.bytes, rows: entry.lines, frames: entry.frames ?? 0 }]),
    ),
    totals: { files: entries.length, rows: totalRows, bytes: totalBytes },
  };
  const manifest: SpoolManifest = {
    format: 2,
    schema,
    identity,
    complete: true,
    createdAt: now,
    partitions: entries,
    totals: { files: entries.length, lines: totalRows, bytes: totalBytes },
  };
  writeFileSync(join(spoolDir, "schema.json"), `${JSON.stringify(schema)}\n`);
  writeFileSync(join(spoolDir, "progress.json"), `${JSON.stringify(progress)}\n`);
  writeFileSync(join(workDir, "spool-manifest.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(
    join(workDir, "checkpoint.json"),
    `${JSON.stringify({ stage: "pass2-merge", identity, counters: { rowsRead: totalRows } })}\n`,
  );

  return { workDir, partitions, rows: totalRows, bytes: totalBytes, files: entries.length };
}

/** Row count and checksum recorded for one (partition, chunk) segment. */
const manifestCache = new Map<string, CloudChunkManifest | null>();
async function segmentInfo(
  store: BlobStore,
  version: string,
  sourceId: string,
  chunk: number,
  partition: number,
): Promise<{ rows: number; sha256: string }> {
  const key = cloudKeys.chunkManifest(version, sourceId, chunk);
  let manifest = manifestCache.get(key);
  if (manifest === undefined) {
    manifest = await store.getJson<CloudChunkManifest>(key);
    manifestCache.set(key, manifest);
  }
  const segment = manifest?.segments.find((entry) => entry.partition === partition);
  return { rows: segment?.rows ?? 0, sha256: segment?.sha256 ?? createHash("sha256").update(Buffer.alloc(0)).digest("hex") };
}

