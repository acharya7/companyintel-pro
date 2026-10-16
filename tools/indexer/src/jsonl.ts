/**
 * JSONL that survives real data.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The 1,000,000-record benchmark failed in pass 2 with
 *
 *     JSON Parse error: Unterminated string
 *
 * A partially written record and a truncated file were both suspected, but the
 * actual cause is much nastier because it is *invisible on most rows*:
 *
 *   1. pass 1 serialized a spool row with `JSON.stringify(row)`, which does NOT
 *      escape U+2028 (LINE SEPARATOR) or U+2029 (PARAGRAPH SEPARATOR) — they are
 *      legal inside a JSON string, so they are written to the file as literal
 *      bytes;
 *   2. pass 2 read the file back with `node:readline`, which treats U+2028 and
 *      U+2029 as line terminators;
 *   3. so one spool record became two "lines", the first of which ended in the
 *      middle of a JSON string → `JSON.parse` threw "Unterminated string".
 *
 * Real scraped company/contact data contains those separators (they are what
 * social and HR exports use as an in-cell line break), which is why the failure
 * appeared on real rows within the first partitions and never in tests whose
 * fixtures only contained ASCII.
 *
 * The fix has two independent halves, so neither can reintroduce the bug alone:
 *
 *   WRITE  `encodeLine` escapes U+2028/U+2029, so a record can never contain a
 *          byte that any line-oriented reader could mistake for a terminator;
 *   READ   `readJsonlFile` splits on `\n` ONLY (the JSONL contract), so even a
 *          legacy file written by an older build still reads back intact.
 *
 * The reader also refuses to pretend a damaged file is a short one:
 *
 *   - a file that does not end with `\n` is reported as truncated (the writer
 *     always terminates every record);
 *   - a record that cannot be parsed fails with its file, line number, byte
 *     offset, record length and the file size — never skipping the record and
 *     never treating an intermediate-file problem as a source-data rejection;
 *   - problems carry POSITION, not CONTENT: an error message must be safe to
 *     paste into a chat or an issue (see `JsonlError`).
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * The two characters `JSON.stringify` leaves literal but line-oriented readers
 * treat as terminators. Escaping them is what makes a line self-delimiting.
 */
const LINE_TERMINATOR_RE = /[\u2028\u2029]/g;

function escapeLineTerminators(text: string): string {
  return text.replace(LINE_TERMINATOR_RE, (character) => (character === "\u2028" ? "\\u2028" : "\\u2029"));
}

/**
 * Serialize one JSONL record — WITHOUT its newline.
 *
 * `JSON.stringify` first (so control characters such as `\n`, `\t`, `\u0000`
 * are escaped properly), then the two separators it refuses to escape.
 */
export function encodeJsonlRecord(value: unknown): string {
  return escapeLineTerminators(JSON.stringify(value));
}

/** One record plus its terminator, ready to hand to a `WriteStream.write`. */
export function encodeJsonlLine(value: unknown): string {
  return `${encodeJsonlRecord(value)}\n`;
}

/** Escape separators in an already-serialized fragment (spool `term` fields). */
export function escapeTerminators(text: string): string {
  return escapeLineTerminators(text);
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type JsonlErrorCode =
  /** The record boundary was found, but the bytes between them are not JSON. */
  | "malformed_record"
  /** The file ended mid-record (or without the required final newline). */
  | "truncated_final_line"
  /** A single record exceeded `maxLineBytes` — a corrupt file, not a big row. */
  | "line_too_long";

export interface JsonlErrorDetails {
  code: JsonlErrorCode;
  file: string;
  /** 1-based line (record) number. */
  line: number;
  /** 0-based byte offset of the record in the file. */
  byteOffset: number;
  /** Length of the record in bytes (`null` when it could not be delimited). */
  recordBytes: number | null;
  /** Size of the file on disk when the problem was found. */
  fileSize: number | null;
  /** The underlying parser message, when there is one. */
  reason?: string;
}

/**
 * A recoverable, actionable intermediate-file diagnostic.
 *
 * Deliberately carries no record content: a spool row and a rejected row both
 * contain real company/contact data, and this message is designed to be pasted
 * into a report. `bun run index:spool-doctor` prints the same information for a
 * whole spool.
 */
export class JsonlError extends Error {
  readonly details: JsonlErrorDetails;

  constructor(details: JsonlErrorDetails) {
    super(formatJsonlError(details));
    this.name = "JsonlError";
    this.details = details;
  }
}

export function isJsonlError(error: unknown): error is JsonlError {
  return error instanceof JsonlError;
}

export function formatJsonlError(details: JsonlErrorDetails): string {
  const { code, file, line, byteOffset, recordBytes, fileSize, reason } = details;
  const size = fileSize === null ? "unknown" : `${fileSize.toLocaleString()} B`;
  const record = recordBytes === null ? "unknown" : `${recordBytes.toLocaleString()} B`;
  const where = `${file}:${line} (byte offset ${byteOffset.toLocaleString()}, record ${record}, file ${size})`;
  if (code === "truncated_final_line") {
    return (
      `Truncated final record in the intermediate file ${where}: the file does not end with a complete ` +
      "record (the writer terminates every record with a newline, so this file was written incompletely).\n" +
      "  Nothing was skipped and nothing was deleted. Re-run to rebuild the spool, or use " +
      "`bun run index:spool-doctor` to inspect every partition before deciding."
    );
  }
  if (code === "line_too_long") {
    return (
      `Record too long in the intermediate file ${where}: a single record exceeded the reader limit. ` +
      "That is a damaged file (a lost newline joins records together), not a legitimate large value.\n" +
      "  Nothing was skipped and nothing was deleted."
    );
  }
  return (
    `Unparseable record in the intermediate file ${where}${reason ? `: ${reason}` : ""}.\n` +
    "  This is a problem with the intermediate file, NOT a rejected source row. Nothing was skipped."
  );
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** Default ceiling for one record. Real source rows are ~2 KB; 64 MiB is a guard. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface JsonlReadOptions {
  /**
   * Fail if a single record exceeds this many bytes. This is a corruption guard
   * (a missing newline joins records into one giant "line"), not a data limit.
   */
  maxLineBytes?: number;
  /** Read the file's size up front for error messages. Default true. */
  statFile?: boolean;
  /**
   * Called with every raw chunk as it is read, in order.
   *
   * Lets a caller hash the file while it is being parsed (so integrity can be
   * verified without a second read of a multi-gigabyte spool), and covers EVERY
   * byte including terminators and any `\r`.
   */
  onChunk?: (chunk: Buffer) => void;
}

export interface JsonlLine {
  /** 1-based record number. */
  line: number;
  /** 0-based byte offset of the record's first byte. */
  byteOffset: number;
  /** Record length in bytes, excluding the terminator. */
  byteLength: number;
  /** The record's text, with a single trailing `\r` (Windows CRLF) removed. */
  text: string;
  /** True when this was the last record AND the file did not end with `\n`. */
  missingTerminator: boolean;
}

/**
 * Split a file into JSONL records by BYTE, on `\n` alone.
 *
 * Byte-level splitting (rather than `readline`) buys three things:
 *   - only `\n` is a terminator, so U+2028/U+2029 — and any other Unicode line
 *     separator a future reader may decide to honour — cannot split a record;
 *   - byte offsets in diagnostics are exact, including for a file whose lines
 *     contain multi-byte characters split across two read chunks;
 *   - a UTF-8 character that straddles a chunk boundary is decoded as part of the
 *     record, never as two replacement characters.
 *
 * Memory is bounded per record (one record plus the current chunk), never by the
 * file size, so a multi-gigabyte partition is read in constant space.
 */
export async function* readJsonlLines(path: string, options: JsonlReadOptions = {}): AsyncGenerator<JsonlLine> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const fileSize = options.statFile === false ? null : (await stat(path).catch(() => null))?.size ?? null;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });

  /** Bytes of the record currently being assembled (not yet terminated). */
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  /** Byte offset of the first byte of `pending`. */
  let pendingOffset = 0;
  let consumed = 0;
  let line = 0;
  let sawTerminator = false;

  const take = (bytes: Buffer[]): string => decoder.decode(Buffer.concat(bytes));

  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    options.onChunk?.(buffer);
    let start = 0;
    let newline = buffer.indexOf(0x0a, start);
    while (newline !== -1) {
      line += 1;
      const piece = buffer.subarray(start, newline);
      // The guard applies to terminated records too, not only to the unterminated
      // tail: a single multi-gigabyte "line" is a corrupt file either way, and
      // reporting it beats trying to parse it.
      if (pendingBytes + piece.length > maxLineBytes) {
        throw new JsonlError({
          code: "line_too_long",
          file: path,
          line,
          byteOffset: pendingOffset,
          recordBytes: pendingBytes + piece.length,
          fileSize,
        });
      }
      let text: string;
      if (pendingBytes === 0) {
        text = take([piece]);
      } else {
        pending.push(piece);
        text = take(pending);
        pending = [];
        pendingBytes = 0;
      }
      // A `\r\n` terminator leaves a `\r` on the record: strip exactly one, so a
      // spool file written on Windows reads back byte-identical to one written on
      // Linux (and a legitimate `\r` inside a JSON string is still escaped by the
      // writer, never literal).
      if (text.endsWith("\r")) text = text.slice(0, -1);
      yield { line, byteOffset: pendingOffset, byteLength: Buffer.byteLength(text, "utf8"), text, missingTerminator: false };
      sawTerminator = true;
      start = newline + 1;
      pendingOffset = consumed + start;
      newline = buffer.indexOf(0x0a, start);
    }
    if (start < buffer.length) {
      pending.push(buffer.subarray(start));
      pendingBytes += buffer.length - start;
      if (pendingBytes > maxLineBytes) {
        throw new JsonlError({
          code: "line_too_long",
          file: path,
          line: line + 1,
          byteOffset: pendingOffset,
          recordBytes: pendingBytes,
          fileSize,
        });
      }
    }
    consumed += buffer.length;
  }

  // Whatever is left at EOF is a record the writer never finished.
  if (pendingBytes > 0) {
    line += 1;
    let text = take(pending);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    yield { line, byteOffset: pendingOffset, byteLength: Buffer.byteLength(text, "utf8"), text, missingTerminator: true };
  } else if (!sawTerminator && consumed === 0) {
    // An empty file: no records at all, and nothing to report as truncated.
    return;
  }
}

export interface JsonlRecord<T> extends JsonlLine {
  value: T;
}

/**
 * Strict JSONL reader: yields parsed records and THROWS `JsonlError` on anything
 * that means the file may not be complete.
 *
 * Blank records are counted (they still advance the line number) but not yielded,
 * which matches how the writer emits one record per line.
 */
export async function* readJsonlFile<T = unknown>(path: string, options: JsonlReadOptions = {}): AsyncGenerator<JsonlRecord<T>> {
  const fileSize = options.statFile === false ? null : (await stat(path).catch(() => null))?.size ?? null;
  for await (const entry of readJsonlLines(path, options)) {
    if (!entry.text.trim()) continue;
    if (entry.missingTerminator) {
      // Deliberately fatal even when the text happens to parse: the writer always
      // terminates a record, so this file was written incompletely, and a record
      // that merely *looks* intact is not evidence that the rest is.
      throw new JsonlError({
        code: "truncated_final_line",
        file: path,
        line: entry.line,
        byteOffset: entry.byteOffset,
        recordBytes: entry.byteLength,
        fileSize,
      });
    }
    try {
      yield { ...entry, value: JSON.parse(entry.text) as T };
    } catch (error) {
      throw new JsonlError({
        code: "malformed_record",
        file: path,
        line: entry.line,
        byteOffset: entry.byteOffset,
        recordBytes: entry.byteLength,
        fileSize,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** One problem found by `scanJsonlFile`, with position only — never content. */
export interface JsonlProblem extends JsonlErrorDetails {
  /** A coarse classification, safe to include in a report. */
  kind: "unparseable" | "truncated" | "oversized";
}

export interface JsonlScan {
  file: string;
  fileSize: number | null;
  bytes: number;
  records: number;
  /** Records that parsed as JSON. */
  parsed: number;
  terminated: boolean;
  problems: JsonlProblem[];
  /** True when scanning stopped early because a record could not be delimited. */
  stoppedEarly: boolean;
}

export interface JsonlScanOptions extends JsonlReadOptions {
  /** Stop after this many problems (default 20) — a report, not a dump. */
  maxProblems?: number;
}

/**
 * Tolerant scan used by the diagnostics: never throws, always reports where and
 * what, and never returns record content.
 *
 * `records` counts bytes up to and including the last record it could delimit, so
 * a truncated file is reported with the exact prefix that is trustworthy.
 */
export async function scanJsonlFile(path: string, options: JsonlScanOptions = {}): Promise<JsonlScan> {
  const maxProblems = options.maxProblems ?? 20;
  const scan: JsonlScan = {
    file: path,
    fileSize: (await stat(path).catch(() => null))?.size ?? null,
    bytes: 0,
    records: 0,
    parsed: 0,
    terminated: true,
    problems: [],
    stoppedEarly: false,
  };

  try {
    for await (const entry of readJsonlLines(path, options)) {
      scan.records += 1;
      if (entry.missingTerminator) {
        scan.terminated = false;
        scan.problems.push({
          kind: "truncated",
          code: "truncated_final_line",
          file: path,
          line: entry.line,
          byteOffset: entry.byteOffset,
          recordBytes: entry.byteLength,
          fileSize: scan.fileSize,
        });
        break;
      }
      scan.bytes = entry.byteOffset + entry.byteLength + 1;
      try {
        JSON.parse(entry.text);
        scan.parsed += 1;
      } catch (error) {
        if (scan.problems.length < maxProblems) {
          scan.problems.push({
            kind: "unparseable",
            code: "malformed_record",
            file: path,
            line: entry.line,
            byteOffset: entry.byteOffset,
            recordBytes: entry.byteLength,
            fileSize: scan.fileSize,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  } catch (error) {
    if (isJsonlError(error)) {
      scan.stoppedEarly = true;
      scan.terminated = false;
      scan.problems.push({
        kind: error.details.code === "line_too_long" ? "oversized" : "unparseable",
        ...error.details,
      });
    } else {
      throw error;
    }
  }

  return scan;
}
