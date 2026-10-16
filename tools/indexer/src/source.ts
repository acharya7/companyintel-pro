/**
 * Indexer input modes.
 *
 *   MODE A — a local CSV file:      "path": "D:/data/companies_part1.csv"
 *   MODE B — an object inside R2:   "path": "r2://company-intel-data/raw/companies_part1.csv"
 *
 * Both modes feed the *same* parser, profiler and pipeline, so a run produces
 * identical output whichever side the bytes came from (a parity test asserts
 * exactly that).
 *
 * Why Mode B needs R2 credentials even though the app's Worker does not:
 * Wrangler's OAuth login is only usable by processes Wrangler itself manages
 * (the Worker runtime and its bindings). This indexer is a plain Bun/Node
 * process; the only way for it to read an object is the S3-compatible API, which
 * is signed with `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
 * from the environment. There is no way to hand a Worker binding to a local
 * script, and `wrangler` exposes no "read an object for me" command with a
 * bounded range. Least-privilege setup: an R2 API token scoped to **Object Read**
 * on `company-intel-data` alone for reading (plus a separate **Object Read &
 * Write** token only if you upload from the same shell).
 *
 * Reading stays bounded *per request* (`chunkBytes`, 8 MiB by default) and, when
 * a cache directory is configured, each object is streamed to disk exactly once
 * and reused on a re-run (resume) instead of being downloaded again.
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CsvParser, truncateAtRecordBoundary, type CsvRecord } from "../../../src/shared/csv-parse";
import type { WriteStream } from "node:fs";
import {
  consumeProfileRecord,
  createProfileAccumulator,
  finishProfile,
  profileComplete,
  type FileProfile,
  type ProfileOptions,
} from "../../../src/shared/csv-profile";
import { readCsvFile, profileCsvFile, type CsvReadOptions } from "./csv";
import { credentialsFromEnv, fileSize, R2Client, type R2Credentials } from "./r2";

export interface R2SourceLocation {
  bucket: string;
  key: string;
}

/**
 * Parse an `r2://bucket/key` source path. Returns `null` for a local path, and
 * throws for an r2 URL that is malformed or tries to escape the bucket prefix.
 */
export function parseR2Source(path: string): R2SourceLocation | null {
  if (!path.startsWith("r2://")) return null;
  const rest = path.slice("r2://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) {
    throw new Error(`Invalid R2 source "${path}". Expected r2://<bucket>/<key>.`);
  }
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (key.includes("..") || key.startsWith("/")) {
    throw new Error(`Invalid R2 source key in "${path}".`);
  }
  return { bucket, key };
}

export interface SourceLike {
  id: string;
  path: string;
  encoding?: string;
  delimiter?: string;
}

export interface SourceContext {
  /** How many bytes one ranged request asks for. */
  chunkBytes: number;
  /** Local cache directory for Mode B, or null to stream without caching. */
  cacheDir: string | null;
  /** Injected for tests; defaults to the environment credentials per bucket. */
  credentialsFor: (bucket: string) => R2Credentials | null;
  /** Progress/diagnostic messages; the CLI prints them. */
  onNotice?: (message: string) => void;
  /** Ranged GET attempts per chunk before a run fails. */
  attempts?: number;
  /**
   * How much R2 traffic this run caused, counted as it happens.
   *
   * A benchmark is only useful if its cost is measured, not guessed: this is the
   * number that goes into the Cloudflare cost estimate (Class A/B operation
   * pricing) alongside the byte volume. Every request is counted, including the
   * retried ones, so `retries` tells the operator whether a flaky link inflated
   * it. `bytesRead` counts object bytes actually transferred.
   */
  stats: SourceStats;
}

export interface SourceStats {
  /** Total HTTP requests issued (head requests and every ranged GET attempt). */
  requests: number;
  /** Requests that had to be retried after a transient failure. */
  retries: number;
  /** Response bytes transferred from R2. */
  bytesRead: number;
  /** Objects opened for streaming (one per source, per run). */
  objectsOpened: number;
  /** Bytes served from the local cache instead of R2. */
  cachedBytes: number;
}

export interface SourceContextOptions {
  cacheDir?: string | null;
  chunkBytes?: number;
  credentialsFor?: (bucket: string) => R2Credentials | null;
  onNotice?: (message: string) => void;
  attempts?: number;
}

export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
/** Sample size for profiling a Mode B source (one bounded range read). */
export const DEFAULT_SAMPLE_BYTES = 6 * 1024 * 1024;
export const DEFAULT_CACHE_DIR = ".indexer-raw-cache";

export function createSourceContext(options: SourceContextOptions = {}): SourceContext {
  return {
    chunkBytes: options.chunkBytes ?? DEFAULT_CHUNK_BYTES,
    cacheDir: options.cacheDir === undefined ? DEFAULT_CACHE_DIR : options.cacheDir,
    credentialsFor: options.credentialsFor ?? ((bucket: string) => credentialsFromEnv(bucket)),
    onNotice: options.onNotice,
    attempts: options.attempts ?? 3,
    stats: { requests: 0, retries: 0, bytesRead: 0, objectsOpened: 0, cachedBytes: 0 },
  };
}

/**
 * Describe an unreachable Mode B object without hiding the real reason: a refused
 * credential is not a missing file, and confusing the two wastes hours.
 */
function unreachableMessage(sourceId: string, location: R2SourceLocation, status: number | null): string {
  const where = `r2://${location.bucket}/${location.key}`;
  if (status === 404) return `source ${sourceId}: ${where} does not exist (HTTP 404). Check the key against the probe report.`;
  if (status === 403) {
    return `source ${sourceId}: ${where} could not be read (HTTP 403) — the credentials in this shell cannot read bucket ${location.bucket}.`;
  }
  return `source ${sourceId}: ${where} could not be read${status === null ? " (HEAD returned no metadata)" : ` (HTTP ${status})`}.`;
}

/** Buckets referenced by `r2://` sources that have no usable credentials. */
export function missingCredentialBuckets(sources: SourceLike[], context: SourceContext): string[] {
  const missing = new Set<string>();
  for (const source of sources) {
    const location = parseR2Source(source.path);
    if (!location) continue;
    if (!context.credentialsFor(location.bucket)) missing.add(location.bucket);
  }
  return [...missing];
}

/** Human-readable explanation for a Mode B run without credentials. */
export function credentialsHelp(buckets: string[]): string {
  return [
    `R2 credentials are missing for: ${buckets.join(", ")}.`,
    "",
    "A local indexer is not a Worker: Wrangler's login (and the native COMPANY_DATA",
    "binding) cannot be handed to a Bun/Node process, so a source read from R2 has to",
    "use the S3-compatible API with its own keys. Least privilege:",
    "",
    "  1. Cloudflare dashboard → R2 → API → Manage API tokens → Create API token.",
    "  2. Permissions: Object Read (that is all a read-only run needs).",
    "  3. Scope it to the single bucket company-intel-data. Never to all buckets.",
    "  4. In your own terminal, for this session only:",
    "       export R2_ACCOUNT_ID=<account id>",
    "       export R2_ACCESS_KEY_ID=<access key id>",
    "       export R2_SECRET_ACCESS_KEY=<secret access key>",
    "",
    "Or avoid Mode B entirely: copy the objects to local disk with rclone and use",
    "Mode A paths (rclone reuses your existing rclone configuration):",
    `  rclone copy r2:${buckets[0] ?? "company-intel-data"}/raw/ ./raw-copy --progress`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Object size                                                                */
/* -------------------------------------------------------------------------- */

export async function sourceBytes(source: SourceLike, context: SourceContext): Promise<number | null> {
  const location = parseR2Source(source.path);
  if (!location) return fileSize(source.path);
  const client = clientFor(location.bucket, context);
  context.stats.requests += 1;
  const head = await client.headDetailed(location.key);
  return head.exists ? head.size : null;
}

/* -------------------------------------------------------------------------- */
/* Mode B: streaming an object                                                */
/* -------------------------------------------------------------------------- */

function clientFor(bucket: string, context: SourceContext): R2Client {
  const credentials = context.credentialsFor(bucket);
  if (!credentials) throw new Error(credentialsHelp([bucket]));
  return new R2Client({ ...credentials, bucket });
}

interface CacheTarget {
  final: string;
  part: string;
}

function cacheTargetFor(context: SourceContext, location: R2SourceLocation): CacheTarget | null {
  if (!context.cacheDir) return null;
  const safeKey = location.key.replace(/[^A-Za-z0-9._/-]/g, "_");
  const base = join(context.cacheDir, location.bucket, safeKey);
  return { final: base, part: `${base}.part` };
}

/** True when a completed cache file exists and matches the remote size. */
async function cachedComplete(target: CacheTarget, remoteBytes: number | null): Promise<boolean> {
  if (!existsSync(target.final)) return false;
  const info = await stat(target.final).catch(() => null);
  if (!info) return false;
  if (remoteBytes === null) return info.size > 0;
  return info.size === remoteBytes;
}

async function writeChunk(stream: WriteStream, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
  }
}

/** Read one ranged chunk, retrying transient failures with backoff. */
async function rangedChunk(
  client: R2Client,
  key: string,
  offset: number,
  length: number,
  attempts: number,
  stats: SourceStats,
): Promise<Buffer> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      stats.requests += 1;
      const body = await client.getRange(key, length, offset);
      stats.bytesRead += body.length;
      return body;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // A 404/403 will not succeed on retry; a 5xx or a network error may.
      if (/HTTP 4\d\d/.test(message) && !/HTTP 429/.test(message)) break;
      if (attempt < attempts) {
        stats.retries += 1;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw new Error(`failed to read bytes ${offset}-${offset + length - 1} of ${key}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Stream a Mode B source as CSV records.
 *
 * The object is read in bounded chunks and, when a cache directory is configured,
 * written once to `<cacheDir>/<bucket>/<key>` (via a `.part` file that is renamed
 * only after the full object verified by size) so a re-run reads local disk.
 */
export async function* r2SourceRecords(
  source: SourceLike,
  options: CsvReadOptions,
  context: SourceContext,
): AsyncGenerator<CsvRecord> {
  const location = parseR2Source(source.path);
  if (!location) throw new Error(`r2SourceRecords called with a local path: ${source.path}`);
  const client = clientFor(location.bucket, context);
  const head = await client.headDetailed(location.key);
  if (!head.exists) throw new Error(unreachableMessage(source.id, location, head.status));
  const remoteBytes = head.size;

  const target = cacheTargetFor(context, location);
  if (target && (await cachedComplete(target, remoteBytes))) {
    context.onNotice?.(`using the cached copy of ${source.path} (${remoteBytes ?? "unknown"} bytes) — no download needed`);
    context.stats.cachedBytes += remoteBytes ?? 0;
    yield* readCsvFile(target.final, options);
    return;
  }
  context.stats.objectsOpened += 1;

  const parser = new CsvParser(options);
  const decoder = new TextDecoder(options.encoding ?? "utf8", { fatal: false, ignoreBOM: true });
  let sink: WriteStream | null = null;
  let written = 0;
  let seen = 0;
  let offset = 0;
  let completed = false;
  // `maxRecords` (sample runs) stops early on purpose, and an early stop must not
  // leave a cache file that looks complete.
  const cacheIncomplete = async () => {
    if (sink) {
      sink.destroy();
      sink = null;
    }
    if (target) await unlink(target.part).catch(() => undefined);
  };

  try {
    if (target) {
      await mkdir(dirname(target.part), { recursive: true });
      sink = createWriteStream(target.part, { flags: "w" });
    }

    const limit = options.maxRecords === undefined ? Number.POSITIVE_INFINITY : options.maxRecords;
    let firstChunk = true;

    while (remoteBytes === null || offset < remoteBytes) {
      const want = context.chunkBytes;
      const remaining = remoteBytes === null ? want : Math.min(want, remoteBytes - offset);
      if (remaining <= 0) break;
      const chunk = await rangedChunk(client, location.key, offset, remaining, context.attempts ?? 3, context.stats);
      if (!chunk.length) break;
      offset += chunk.length;
      if (sink) await writeChunk(sink, chunk);
      written += chunk.length;
      if (firstChunk) {
        firstChunk = false;
        context.onNotice?.(
          `streaming ${source.path} in ${Math.round(context.chunkBytes / (1024 * 1024))} MiB chunks` +
            `${remoteBytes === null ? " (object size unknown)" : ` (${remoteBytes} bytes)`}`,
        );
      }

      for (const record of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (seen >= limit) {
          await cacheIncomplete();
          return;
        }
        seen += 1;
        yield record;
      }
      if (chunk.length < remaining) break; // shorter than asked: end of object
    }

    for (const record of parser.push(decoder.decode())) {
      if (seen >= limit) {
        await cacheIncomplete();
        return;
      }
      seen += 1;
      yield record;
    }
    for (const record of parser.end()) {
      if (seen >= limit) {
        await cacheIncomplete();
        return;
      }
      seen += 1;
      yield record;
    }

    if (sink) {
      const stream = sink;
      sink = null;
      await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve());
        stream.once("error", reject);
      });
      if (remoteBytes !== null && written !== remoteBytes) {
        await unlink(target!.part).catch(() => undefined);
        throw new Error(
          `source ${source.id}: read ${written} of ${remoteBytes} bytes of ${source.path} — the cache file was discarded; re-run to try again.`,
        );
      }
      await rename(target!.part, target!.final);
    }
    completed = true;
  } finally {
    if (!completed && sink === null && target) {
      // An exception (not an early sample stop) also leaves no half cache file.
      await unlink(target.part).catch(() => undefined);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Unified access                                                             */
/* -------------------------------------------------------------------------- */

/** Records for either mode, so the pipeline never knows which one it is using. */
export async function* sourceRecords(
  source: SourceLike,
  options: CsvReadOptions,
  context: SourceContext,
): AsyncGenerator<CsvRecord> {
  if (parseR2Source(source.path)) {
    yield* r2SourceRecords(source, options, context);
    return;
  }
  yield* readCsvFile(source.path, options);
}

/**
 * Profile either mode. A Mode B source is profiled from a bounded sample (one
 * range read), which is why the run can inspect a 50 GB object in seconds.
 */
export async function sourceProfile(
  source: SourceLike,
  options: ProfileOptions & { sampleBytes?: number },
  context: SourceContext,
): Promise<FileProfile> {
  const location = parseR2Source(source.path);
  if (!location) {
    return profileCsvFile(source.path, {
      encoding: source.encoding,
      delimiter: source.delimiter,
      sampleRows: options.sampleRows,
      knownFields: options.knownFields,
      maxSamplesPerColumn: options.maxSamplesPerColumn,
    });
  }

  const client = clientFor(location.bucket, context);
  const head = await client.headDetailed(location.key);
  if (!head.exists) throw new Error(unreachableMessage(source.id, location, head.status));
  const sampleBytes = options.sampleBytes ?? DEFAULT_SAMPLE_BYTES;
  const want = head.size === null ? sampleBytes : Math.min(sampleBytes, head.size);
  const bytes = await rangedChunk(client, location.key, 0, want, context.attempts ?? 3, context.stats);
  const truncatedByBound = head.size !== null && head.size > bytes.length;
  const encoding = source.encoding ?? "utf8";
  let text = new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(bytes);
  if (truncatedByBound) {
    // The sample may end inside a quoted multiline record; drop the tail with the
    // same quoting rules the parser uses (a plain lastIndexOf("\n") keeps a field
    // that is still open, and its half record would be profiled as a real row).
    text = truncateAtRecordBoundary(text, { delimiter: source.delimiter });
  }

  const accumulator = createProfileAccumulator({ sampleRows: options.sampleRows, maxSamplesPerColumn: options.maxSamplesPerColumn });
  const parser = new CsvParser({ delimiter: source.delimiter, quote: '"' });
  const records = [...parser.push(text), ...parser.end()];
  for (const record of records) {
    if (profileComplete(accumulator)) break;
    consumeProfileRecord(accumulator, record);
  }

  return finishProfile(accumulator, {
    path: source.path,
    delimiter: source.delimiter ?? ",",
    encoding,
    knownFields: options.knownFields,
    bytes: bytes.length,
  });
}

/** Path a Mode B run caches one object at (null when caching is disabled). */
export function cachePathFor(context: SourceContext, bucket: string, key: string): string | null {
  const target = cacheTargetFor(context, { bucket, key });
  return target ? target.final : null;
}
