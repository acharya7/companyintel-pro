/**
 * Spool format v2 — the disk-bounded, resumable Pass 1 intermediate.
 *
 * WHY v1 EXHAUSTED THE DISK
 * -------------------------
 * The first full run wrote 66,333,763 rows and produced ~217 GB: **3.27 KB per
 * spool row**, against a 700 B/row estimate. There were two defects, and neither
 * was only "the estimate is too low":
 *
 *   1. every row carried `company.attributes` AND `contact.attributes`. On a
 *      contact row both maps were captured from the SAME record (every call site
 *      passes the same `captured` array), so the whole 39-column source row was
 *      serialized **twice**;
 *   2. each attribute map repeats the header text on every record. For 39
 *      columns averaging ~25 characters of header, that is ~1 KB of field names
 *      per row before a single value is written.
 *
 * The source is 64.26 GB for ~99 M rows (650 B/row). v1 therefore expanded the
 * data by 3.4x and its spool grew without bound as Pass 1 ran. The estimator's
 * 700 B/row constant had been measured on a spool written before full-column
 * capture existed, so it under-counted the real row by 4.7x.
 *
 * WHAT v2 CHANGES
 * ---------------
 *   - ONE serialized copy of the source values per row, in COLUMN ORDER, with no
 *     field names. The header text lives once in `spool/schema.json`.
 *   - Canonical company/contact inputs and identity keys are DERIVED on read by
 *     the same mapping functions Pass 1 used, so nothing is lost and nothing is
 *     stored twice. `extractCompanyInput`, `extractContactInput` and
 *     `companyKeysFromInput` are the definition of a row either way.
 *   - Frames of gzip (default 1 MiB uncompressed each), appended to a partition
 *     file. A frame is either fully committed or not committed at all, and the
 *     sidecar ledger records its offset, length and SHA-256, so Pass 2 can read,
 *     count and verify exactly what was written.
 *   - `spool/progress.json` is written and fsynced at every checkpoint: the run
 *     identity, the schema, per-source `rowsRead`/`complete`, and per-partition
 *     committed bytes. Pass 1 resumes from that row, never by appending a second
 *     copy of a row it already wrote.
 *
 * The encoding is a JSON array so it stays inspectable and strictly parseable:
 *
 *     [sourceIndex, sourceLine, value0, value1, ...]
 *
 * Empty cells are stored as `""` (a positional array has to keep the columns
 * aligned); every non-empty value is kept verbatim and unbounded.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { companyKeysFromInput, extractCompanyInput, extractContactInput } from "./mapping";
import type { SourceRef } from "../../../src/shared/models";

export const SPOOL_FORMAT_VERSION = 2 as const;
export const SPOOL_PROGRESS_FILE = "progress.json";
export const SPOOL_SCHEMA_FILE = "schema.json";
export const SPOOL_V2_EXTENSION = ".jsonl.gz";
export const SPOOL_V2_SIDECAR = ".frames";
/** Rows read between two durable checkpoints when the row count is the trigger. */
export const DEFAULT_CHECKPOINT_ROWS = 100_000;
/** Milliseconds between durable checkpoints while the reader is slow. */
export const DEFAULT_CHECKPOINT_MS = 60_000;
/** Uncompressed bytes buffered per partition before a frame is sealed. */
export const DEFAULT_FRAME_BYTES = 1 << 20;

/** One column of one source: its position in the record and its header text. */
export interface SpoolColumn {
  index: number;
  label: string;
}

/** Everything Pass 2 needs to decode a row without re-reading the source. */
export interface SpoolSourceSchema {
  id: string;
  delimiter: string;
  /** Column count of the source record (values are padded/truncated to this). */
  columns: number;
  /** Canonical field → column index, exactly as Pass 1 used it. */
  map: Record<string, number>;
  /** Captured columns in file order (the attribute map's keys). */
  captured: SpoolColumn[];
}

export interface SpoolSchema {
  format: typeof SPOOL_FORMAT_VERSION;
  sources: SpoolSourceSchema[];
}

/** One committed gzip frame of one partition. */
export interface SpoolFrameEntry {
  /** Byte offset of the frame in the `.jsonl.gz` file. */
  offset: number;
  /** Compressed length in bytes. */
  bytes: number;
  /** Records in this frame. */
  rows: number;
  /** SHA-256 of the compressed frame bytes. */
  sha256: string;
}

/** Per-partition progress, as recorded in `progress.json`. */
export interface SpoolPartitionProgress {
  partition: number;
  file: string;
  /** Bytes committed (complete frames only). */
  bytes: number;
  rows: number;
  frames: number;
}

/** Provenance of the Pass 1 run that owns a spool. */
export interface SpoolProgressIdentity {
  version: string;
  sampleLimit: number | null;
  partitions: number;
  sources: { id: string; path: string; delimiter: string; columns: number }[];
}

export interface SpoolProgress {
  format: typeof SPOOL_FORMAT_VERSION;
  identity: SpoolProgressIdentity;
  schema: SpoolSchema;
  createdAt: string;
  updatedAt: string;
  /**
   * `pass1` while rows are still being written, `pass1-complete` after every
   * stream is flushed and the final manifest exists. `complete` is per SOURCE so
   * a run that finished csv1 does not read 10 GB again to resume csv2.
   */
  status: "pass1" | "pass1-complete";
  sources: Record<string, { rowsRead: number; rowsRejected: number; complete: boolean }>;
  partitions: Record<string, SpoolPartitionProgress>;
  totals: { files: number; rows: number; bytes: number };
  /**
   * Present when this spool was converted from a legacy one. It records what was
   * proven about the source spool — never a checkpoint that source never wrote.
   */
  recoveredFrom?: {
    workDir: string;
    format: 1;
    files: number;
    bytes: number;
    records: number;
    duplicates: number;
    sources: { id: string; prefixRows: number }[];
    recoveredAt: string;
  };
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

export function spoolV2FileName(partition: number): string {
  return `part-${String(partition).padStart(4, "0")}${SPOOL_V2_EXTENSION}`;
}

export function spoolV2SidecarName(partition: number): string {
  return `part-${String(partition).padStart(4, "0")}${SPOOL_V2_SIDECAR}`;
}

export const SPOOL_V2_FILE_RE = /^part-(\d{4})\.jsonl\.gz$/;
export const SPOOL_V1_FILE_RE = /^part-(\d{4})\.jsonl$/;

export function progressPathFor(workDir: string): string {
  return join(workDir, "spool", SPOOL_PROGRESS_FILE);
}

export function schemaPathFor(workDir: string): string {
  return join(workDir, "spool", SPOOL_SCHEMA_FILE);
}

/* -------------------------------------------------------------------------- */
/* Row encoding                                                               */
/* -------------------------------------------------------------------------- */

/** A decoded v2 row — structurally identical to build.ts's internal SpoolRow. */
export interface DecodedSpoolRow {
  keys: string[];
  bucket: string;
  partitionKey: string;
  strong: boolean;
  normalizedName: string;
  company: NonNullable<ReturnType<typeof extractCompanyInput>>;
  contact: ReturnType<typeof extractContactInput>;
  source: SourceRef;
  /** Partition the row was written to (from the file/ledger, not the record). */
  partition: number;
}

/**
 * Trimmed source values, padded to the source's column count.
 *
 * Trimming is what `captureAttributes` did for every captured value, so this is
 * the same value set v1 preserved — just written once.
 */
export function normalizeValues(record: string[], columns: number): string[] {
  const values: string[] = new Array(columns);
  for (let index = 0; index < columns; index += 1) {
    const raw = record[index];
    values[index] = raw === undefined || raw === null ? "" : String(raw).trim();
  }
  return values;
}

/** Serialize one v2 record (no trailing newline). */
export function encodeSpoolV2Row(sourceIndex: number, sourceLine: number, values: string[]): string {
  // JSON.stringify escapes control characters; the values were already trimmed.
  // U+2028/U+2029 are legal in JSON and cannot appear in a JSONL line if the
  // reader splits on \n only — which `spoolFrameLines` does.
  return JSON.stringify([sourceIndex, sourceLine, ...values]);
}

/** Decode one v2 record back into the canonical Pass 2 row. */
export function decodeSpoolV2Row(text: string, schema: SpoolSchema, partition: number): DecodedSpoolRow {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new Error("spool record is not a [sourceIndex, sourceLine, ...values] array");
  }
  const sourceIndex = parsed[0];
  const sourceLine = parsed[1];
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= schema.sources.length) {
    throw new Error(`spool record names source #${String(sourceIndex)}, which the schema does not have`);
  }
  if (!Number.isInteger(sourceLine) || sourceLine < 1) {
    throw new Error(`spool record has an invalid source row number (${String(sourceLine)})`);
  }
  const source = schema.sources[sourceIndex];
  const values: string[] = new Array(source.columns);
  for (let index = 0; index < source.columns; index += 1) {
    const value = parsed[index + 2];
    values[index] = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  }
  // The SAME functions Pass 1 used — the spool stores the source row, and the
  // canonical record is a pure function of it plus the recorded mapping.
  const company = extractCompanyInput(values, source.map, source.captured);
  if (!company) throw new Error("spool record has no company name under the recorded mapping");
  const contact = extractContactInput(values, source.map, source.captured);
  const keys = companyKeysFromInput(company, source.id);
  return {
    keys: keys.all,
    bucket: keys.bucket,
    partitionKey: keys.partitionKey,
    strong: keys.strong,
    normalizedName: keys.normalizedName,
    company,
    contact,
    source: { source: source.id, row: sourceLine },
    partition,
  };
}

/* -------------------------------------------------------------------------- */
/* Schema / progress persistence                                              */
/* -------------------------------------------------------------------------- */

/**
 * Write JSON atomically AND durably.
 *
 * `progress.json` is the only thing that makes a half-written spool resumable,
 * so it is written to a temporary file, fsynced, and renamed. A power loss then
 * leaves either the previous complete progress or the new complete one.
 */
export function writeJsonDurable(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  const fd = openSync(temporary, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

export function writeSchema(workDir: string, schema: SpoolSchema): void {
  mkdirSync(join(workDir, "spool"), { recursive: true });
  writeJsonDurable(schemaPathFor(workDir), schema);
}

export async function readSchema(workDir: string): Promise<SpoolSchema | null> {
  const path = schemaPathFor(workDir);
  if (!existsSync(path)) return null;
  return assertSchema(JSON.parse(await readFile(path, "utf8")) as unknown, path);
}

export function assertSchema(value: unknown, where: string): SpoolSchema {
  const schema = value as Partial<SpoolSchema> | null;
  if (!schema || schema.format !== SPOOL_FORMAT_VERSION || !Array.isArray(schema.sources) || !schema.sources.length) {
    throw new Error(`${where} is not a v${SPOOL_FORMAT_VERSION} spool schema.`);
  }
  for (const source of schema.sources) {
    if (typeof source.id !== "string" || !Number.isInteger(source.columns) || source.columns < 0) {
      throw new Error(`${where} has a malformed source entry.`);
    }
    if (!Array.isArray(source.captured) || !source.map || typeof source.map !== "object") {
      throw new Error(`${where} is missing the captured columns or column map for ${source.id}.`);
    }
  }
  return schema as SpoolSchema;
}

export async function readProgress(workDir: string): Promise<SpoolProgress | null> {
  const path = progressPathFor(workDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} exists but could not be read (${error instanceof Error ? error.message : String(error)}). ` +
        "It records how much of Pass 1 was committed, so the spool cannot be resumed without it. " +
        "Nothing was deleted: inspect the spool read-only (index:spool-doctor) before deciding.",
    );
  }
  const progress = parsed as Partial<SpoolProgress> | null;
  if (!progress || progress.format !== SPOOL_FORMAT_VERSION) {
    throw new Error(`${path} is not a v${SPOOL_FORMAT_VERSION} progress record.`);
  }
  assertSchema(progress.schema, path);
  return progress as SpoolProgress;
}

export function writeProgress(workDir: string, progress: SpoolProgress): void {
  progress.updatedAt = new Date().toISOString();
  writeJsonDurable(progressPathFor(workDir), progress);
}

/* -------------------------------------------------------------------------- */
/* Writer                                                                     */
/* -------------------------------------------------------------------------- */

export class SpoolDiskFullError extends Error {
  constructor(cause: unknown, file: string, committedBytes: number) {
    super(
      `The spool could not be written: no space left on the device (${file}).\n` +
        `  ${committedBytes.toLocaleString()} bytes had been committed to that partition at the last frame boundary.\n` +
        "  Nothing was deleted. The progress ledger still records the last durable checkpoint, so re-running the same\n" +
        "  command resumes from that source row and truncates only the uncommitted tail. Free space before restarting;\n" +
        "  `--spool-max-gb` can cap the spool below what the volume holds.",
      { cause },
    );
    this.name = "SpoolDiskFullError";
  }
}

interface PartitionWriter {
  partition: number;
  file: string;
  fd: number;
  sidecarFd: number;
  buffer: string[];
  bufferBytes: number;
  bufferRows: number;
  /** Committed bytes (complete frames only). */
  bytes: number;
  rows: number;
  frames: number;
  /** Bytes written to the sidecar ledger (so rollback can truncate it). */
  sidecarLength: number;
  hash: ReturnType<typeof createHash>;
}

export interface SpoolWriterOptions {
  frameBytes?: number;
  /** Called for every sealed frame (used by tests to simulate a crash). */
  onFrame?: (partition: number, frames: number) => void;
  /**
   * TEST-ONLY fault injection: the next frame that would push committed bytes
   * past this number is half-written and then fails with a simulated ENOSPC.
   *
   * A real full disk is the failure that destroyed the first full run, and it is
   * the one path that cannot be exercised by allocating bytes (the machine would
   * have to actually fill up). Injecting it here keeps the rollback code under
   * test instead of trusting it by inspection. It is never set by the CLI.
   */
  faultAfterCommittedBytes?: number;
}

/**
 * Appends compact rows to framed-gzip partitions.
 *
 * Writes are synchronous on purpose: a frame is a single `writeSync`, so the
 * boundary between "committed" and "not committed" is a real byte offset that
 * `progress.json` can record, and an interruption can never leave a half-encoded
 * record that a reader would accept.
 */
export class SpoolV2Writer {
  readonly schema: SpoolSchema;
  private readonly dir: string;
  private readonly frameBytes: number;
  private readonly partitions = new Map<number, PartitionWriter>();
  private readonly options: SpoolWriterOptions;
  private closed = false;

  constructor(dir: string, schema: SpoolSchema, options: SpoolWriterOptions = {}) {
    this.dir = dir;
    this.schema = schema;
    this.frameBytes = options.frameBytes ?? DEFAULT_FRAME_BYTES;
    this.options = options;
  }

  /**
   * Open a partition for appending, and rebuild the running file hash from the
   * bytes already committed in a previous attempt.
   *
   * The hash is what the final manifest records, so a resumed run has to feed the
   * existing prefix into the new hash exactly once — otherwise the manifest would
   * describe only the rows written after the restart.
   */
  private open(partition: number): PartitionWriter {
    const existing = this.partitions.get(partition);
    if (existing) return existing;
    const file = spoolV2FileName(partition);
    const path = join(this.dir, file);
    const committed = existsSync(path) ? statSync(path).size : 0;
    const fd = openSync(path, "a+");
    const sidecarPath = join(this.dir, spoolV2SidecarName(partition));
    const sidecarFd = openSync(sidecarPath, "a+");
    const sidecarInfo = existsSync(sidecarPath) ? statSync(sidecarPath) : null;
    const hash = createHash("sha256");
    if (committed > 0) {
      // Stream the existing prefix through the hash in bounded chunks.
      const buffer = Buffer.allocUnsafe(4 << 20);
      let position = 0;
      while (position < committed) {
        const read = readSync(fd, buffer, 0, Math.min(buffer.length, committed - position), position);
        if (read <= 0) break;
        hash.update(buffer.subarray(0, read));
        position += read;
      }
    }
    const writer: PartitionWriter = {
      partition,
      file,
      fd,
      sidecarFd,
      buffer: [],
      bufferBytes: 0,
      bufferRows: 0,
      bytes: committed,
      rows: 0,
      frames: 0,
      sidecarLength: sidecarInfo?.size ?? 0,
      hash,
    };
    this.partitions.set(partition, writer);
    return writer;
  }

  /**
   * Adopt the partitions a previous attempt committed, before appending new rows.
   *
   * Without this, a resumed run would start with an empty writer and write a
   * manifest describing ONLY the rows added after the restart — silently dropping
   * everything already on disk. The ledger's byte and row counts are verified
   * against the files as they are opened; a disagreement is a hard error.
   */
  adopt(entries: SpoolPartitionProgress[]): void {
    for (const entry of entries) {
      const writer = this.open(entry.partition);
      if (writer.bytes !== entry.bytes) {
        throw new Error(
          `Cannot adopt ${entry.file}: the ledger records ${entry.bytes.toLocaleString()} committed bytes but the file holds ${writer.bytes.toLocaleString()}.\n` +
            "  Nothing was merged; resume truncates only the uncommitted tail, so this is evidence of a damaged spool.",
        );
      }
      writer.rows = entry.rows;
      writer.frames = entry.frames;
    }
  }

  /** Buffer one row (encoded already, without a newline). */
  add(partition: number, line: string): void {
    if (this.closed) throw new Error("cannot add a row to a closed spool writer");
    const writer = this.open(partition);
    writer.buffer.push(line);
    writer.bufferBytes += Buffer.byteLength(line, "utf8") + 1;
    writer.bufferRows += 1;
    if (writer.bufferBytes >= this.frameBytes) this.seal(writer);
  }

  /** Compress and append the current buffer as one frame. */
  private seal(writer: PartitionWriter): void {
    if (!writer.bufferRows) return;
    const text = `${writer.buffer.join("\n")}\n`;
    const compressed = gzipSync(Buffer.from(text, "utf8"), { level: 6 });
    const digest = createHash("sha256").update(compressed).digest("hex");
    const entry: SpoolFrameEntry = { offset: writer.bytes, bytes: compressed.length, rows: writer.bufferRows, sha256: digest };
    let written = 0;
    try {
      const faultAt = this.options.faultAfterCommittedBytes;
      if (faultAt !== undefined && writer.bytes + compressed.length > faultAt) {
        // Write part of the frame, exactly as a volume that fills up mid-write
        // would, then fail the way the OS does.
        const half = Math.floor(compressed.length / 2);
        if (half > 0) writeSync(writer.fd, compressed, 0, half);
        throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
      }
      while (written < compressed.length) {
        written += writeSync(writer.fd, compressed, written, compressed.length - written);
      }
      const ledgerLine = `${JSON.stringify(entry)}\n`;
      writeSync(writer.sidecarFd, ledgerLine);
      writer.sidecarLength += Buffer.byteLength(ledgerLine, "utf8");
    } catch (error) {
      // Roll back the partly written frame so the file ends at a frame boundary.
      // The rows in it are uncommitted and will be re-read after the checkpoint.
      try {
        truncateSync(join(this.dir, writer.file), writer.bytes);
        truncateSync(join(this.dir, spoolV2SidecarName(writer.partition)), writer.sidecarLength);
      } catch {
        // The original error is the useful one; the resume path truncates to the
        // ledger anyway.
      }
      if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") {
        throw new SpoolDiskFullError(error, writer.file, writer.bytes);
      }
      throw error;
    }
    writer.bytes += compressed.length;
    writer.rows += entry.rows;
    writer.hash.update(compressed);
    // The sidecar is the frame ledger, so its length must be tracked too.
    writer.frames += 1;
    writer.buffer = [];
    writer.bufferBytes = 0;
    writer.bufferRows = 0;
    this.options.onFrame?.(writer.partition, writer.frames);
  }

  /** Seal every buffer. Call before writing a checkpoint. */
  flush(): Promise<void> {
    for (const writer of this.partitions.values()) this.seal(writer);
    return Promise.resolve();
  }

  /** Flush and fsync every partition, then close the handles. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    for (const writer of this.partitions.values()) {
      try {
        fsyncSync(writer.fd);
        fsyncSync(writer.sidecarFd);
      } finally {
        closeSync(writer.fd);
        closeSync(writer.sidecarFd);
      }
    }
    this.closed = true;
  }

  /** Flush, fsync and keep the handles open (the checkpoint path). */
  async checkpoint(): Promise<void> {
    await this.flush();
    for (const writer of this.partitions.values()) {
      fsyncSync(writer.fd);
      fsyncSync(writer.sidecarFd);
    }
  }

  /** Bytes committed to complete frames in every partition. */
  committedBytes(): number {
    let total = 0;
    for (const writer of this.partitions.values()) total += writer.bytes;
    return total;
  }

  /** Bytes buffered but not yet sealed into a frame. */
  bufferedBytes(): number {
    let total = 0;
    for (const writer of this.partitions.values()) total += writer.bufferBytes;
    return total;
  }

  /** Snapshot of committed progress, sorted by partition. */
  progress(): SpoolPartitionProgress[] {
    return [...this.partitions.values()]
      .filter((writer) => writer.rows > 0)
      .sort((a, b) => a.partition - b.partition)
      .map((writer) => ({ partition: writer.partition, file: writer.file, bytes: writer.bytes, rows: writer.rows, frames: writer.frames }));
  }

  /** Final per-partition records, with the whole-file checksum the merge verifies. */
  finalize(): { partition: number; file: string; bytes: number; rows: number; frames: number; sha256: string }[] {
    return [...this.partitions.values()]
      .filter((writer) => writer.rows > 0)
      .sort((a, b) => a.partition - b.partition)
      .map((writer) => ({
        partition: writer.partition,
        file: writer.file,
        bytes: writer.bytes,
        rows: writer.rows,
        frames: writer.frames,
        sha256: writer.hash.digest("hex"),
      }));
  }
}

/* -------------------------------------------------------------------------- */
/* Resume                                                                     */
/* -------------------------------------------------------------------------- */

export interface ResumePlan {
  /** Rows to skip per source id (already spooled and committed). */
  skipRows: Record<string, number>;
  /** Sources that were fully consumed; they are not read again. */
  completeSources: string[];
  /** Rows restored into the run counters. */
  rowsRead: number;
  rowsRejected: number;
}

/**
 * Verify a v2 spool against its ledger and return where Pass 1 should continue.
 *
 * This function never writes. `prepareResume` (below) truncates the uncommitted
 * tail — and only that tail: a partition shorter than its ledger, a changed
 * sidecar, or a missing partition is a hard error, because those are evidence
 * that committed data was lost, not that a restart is needed.
 */
export async function planResume(workDir: string, progress: SpoolProgress): Promise<ResumePlan> {
  const spoolDir = join(workDir, "spool");
  const skipRows: Record<string, number> = {};
  const completeSources: string[] = [];
  let rowsRead = 0;
  let rowsRejected = 0;

  for (const source of progress.schema.sources) {
    const state = progress.sources[source.id];
    if (!state) throw new Error(`progress.json has no state for source ${source.id}. Nothing was changed; inspect the spool read-only.`);
    skipRows[source.id] = state.complete ? 0 : state.rowsRead;
    if (state.complete) completeSources.push(source.id);
    rowsRead += state.rowsRead;
    rowsRejected += state.rowsRejected;
  }

  for (const entry of Object.values(progress.partitions)) {
    const path = join(spoolDir, entry.file);
    const info = await stat(path).catch(() => null);
    if (!info) {
      throw new Error(
        `Partition ${entry.file} is recorded in progress.json but is missing from ${spoolDir}.\n` +
          "  The spool is damaged, and re-running Pass 1 would silently rebuild only part of it. Nothing was changed;\n" +
          "  inspect it read-only (index:spool-doctor) before deciding.",
      );
    }
    if (info.size < entry.bytes) {
      throw new Error(
        `Partition ${entry.file} is ${info.size.toLocaleString()} B on disk but ${entry.bytes.toLocaleString()} B were committed.\n` +
          "  Committed rows are missing, so the spool cannot be resumed from the ledger. Nothing was changed.",
      );
    }
    const sidecar = join(spoolDir, spoolV2SidecarName(entry.partition));
    const sidecarInfo = await stat(sidecar).catch(() => null);
    if (!sidecarInfo) {
      throw new Error(`Partition ${entry.file} has no frame ledger (${spoolV2SidecarName(entry.partition)}), so its frames cannot be verified. Nothing was changed.`);
    }
    const frames = await readFrameLedger(sidecar);
    const committedSidecarBytes = frames.reduce((total, frame) => total + frame.bytes, 0);
    if (committedSidecarBytes !== entry.bytes) {
      throw new Error(
        `Partition ${entry.file} records ${entry.bytes.toLocaleString()} committed bytes but its frame ledger describes ` +
          `${committedSidecarBytes.toLocaleString()} B. Nothing was changed; inspect the spool read-only.`,
      );
    }
    if (frames.reduce((total, frame) => total + frame.rows, 0) !== entry.rows) {
      throw new Error(`Partition ${entry.file} records ${entry.rows.toLocaleString()} rows but its frame ledger describes a different count. Nothing was changed.`);
    }
  }

  return { skipRows, completeSources, rowsRead, rowsRejected };
}

/**
 * Truncate each partition and its sidecar back to the last COMMITTED frame.
 *
 * Only bytes written after the last successful checkpoint are removed. Those
 * rows were never recorded in progress.json, so the resumed run re-reads and
 * rewrites them exactly once. Committed bytes are never touched.
 */
export async function prepareResume(workDir: string, progress: SpoolProgress): Promise<ResumePlan> {
  const plan = await planResume(workDir, progress);
  const spoolDir = join(workDir, "spool");
  for (const entry of Object.values(progress.partitions)) {
    const path = join(spoolDir, entry.file);
    const sidecar = join(spoolDir, spoolV2SidecarName(entry.partition));
    const frames = await readFrameLedger(sidecar);
    let sidecarLength = 0;
    for (const frame of frames) sidecarLength += Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8");
    const size = statSync(path).size;
    if (size > entry.bytes) truncateSync(path, entry.bytes);
    const sidecarSize = statSync(sidecar).size;
    if (sidecarSize > sidecarLength) truncateSync(sidecar, sidecarLength);
  }
  return plan;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export async function readFrameLedger(path: string): Promise<SpoolFrameEntry[]> {
  const text = await readFile(path, "utf8");
  const frames: SpoolFrameEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: SpoolFrameEntry;
    try {
      entry = JSON.parse(line) as SpoolFrameEntry;
    } catch {
      // A partial trailing line is an uncommitted frame; `prepareResume` drops it.
      // A partial line in the middle is corruption, but the caller's row/byte
      // checks catch that (the ledger then disagrees with the recorded totals).
      break;
    }
    frames.push(entry);
  }
  return frames;
}

export interface SpoolReadOptions {
  /** Verify each frame's SHA-256 while reading (default true). */
  verify?: boolean;
  /** Called with every compressed byte read, for the partition checksum. */
  onChunk?: (chunk: Buffer) => void;
}

/**
 * Stream one v2 partition, frame by frame.
 *
 * Each frame is gunzipped independently and split on `\n` only (the JSONL
 * contract). A frame whose hash or row count disagrees with the ledger stops the
 * read with its position — a truncated or changed spool is never merged as a
 * shorter one.
 */
export async function* readSpoolV2Partition(
  path: string,
  sidecarPath: string,
  schema: SpoolSchema,
  partition: number,
  options: SpoolReadOptions = {},
): AsyncGenerator<DecodedSpoolRow> {
  const frames = await readFrameLedger(sidecarPath);
  const verify = options.verify !== false;
  const fd = openSync(path, "r");
  try {
    for (const frame of frames) {
      const buffer = Buffer.allocUnsafe(frame.bytes);
      let read = 0;
      while (read < frame.bytes) {
        const got = readSync(fd, buffer, read, frame.bytes - read, frame.offset + read);
        if (got <= 0) break;
        read += got;
      }
      if (read !== frame.bytes) {
        throw new Error(`spool frame at byte ${frame.offset.toLocaleString()} of ${path} is short (${read} of ${frame.bytes} B). Nothing was merged.`);
      }
      if (verify) {
        const digest = createHash("sha256").update(buffer).digest("hex");
        if (digest !== frame.sha256) {
          throw new Error(`spool frame at byte ${frame.offset.toLocaleString()} of ${path} does not match its recorded SHA-256. Nothing was merged.`);
        }
      }
      options.onChunk?.(buffer);
      let text: string;
      try {
        text = gunzipSync(buffer).toString("utf8");
      } catch (error) {
        throw new Error(`spool frame at byte ${frame.offset.toLocaleString()} of ${path} is not valid gzip (${error instanceof Error ? error.message : String(error)}). Nothing was merged.`);
      }
      const lines = text.split("\n");
      // The writer terminates every record, so the final split element is "".
      let rows = 0;
      for (const line of lines) {
        if (!line) continue;
        rows += 1;
        try {
          yield decodeSpoolV2Row(line, schema, partition);
        } catch (error) {
          throw new Error(`spool record ${rows} of the frame at byte ${frame.offset.toLocaleString()} in ${path} could not be decoded: ${error instanceof Error ? error.message : String(error)}. Nothing was merged.`);
        }
      }
      if (rows !== frame.rows) {
        throw new Error(`spool frame at byte ${frame.offset.toLocaleString()} of ${path} holds ${rows} record(s) but its ledger records ${frame.rows}. Nothing was merged.`);
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** Read a v2 spool's schema if it has one (used by the read-only inspector). */
export async function spoolSchemaFor(workDir: string): Promise<SpoolSchema | null> {
  const progress = await readProgress(workDir).catch(() => null);
  if (progress) return progress.schema;
  return readSchema(workDir).catch(() => null);
}

/** True when a directory holds any v2 partition file. */
export async function hasV2Partitions(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.some((name) => SPOOL_V2_FILE_RE.test(name));
}

/** Byte length of a frame ledger on disk (used by tests and resume). */
export function frameLedgerBytes(frames: SpoolFrameEntry[]): number {
  return frames.reduce((total, frame) => total + Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8"), 0);
}

