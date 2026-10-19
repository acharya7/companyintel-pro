/**
 * Boundary-safe chunking of a source object.
 *
 * A cloud Pass 1 cuts a 54 GB object into independent chunks, so a chunk may
 * only end where a *record* ends. Two things make the naive approach wrong:
 *
 *   1. a quoted field may contain a newline, so "the next \\n" is not a record
 *      boundary; and
 *   2. a UTF-8 character may span a byte range, so a fixed byte cut can split a
 *      character as well as a row.
 *
 * The chunker therefore feeds decoded text through the same `CsvParser` the
 * local indexer uses and stops after the first record that ends at or beyond the
 * target size. `CsvParser` counts UTF-8 bytes and exposes `atRecordBoundary`, so
 * the cut is exact in both byte and quotation terms. The next chunk starts at
 * that record's end, which means every source byte is read by exactly one chunk
 * and no row is duplicated or lost at a boundary.
 */

import { CsvParser, type CsvRecord } from "../../src/shared/csv-parse";

import type { BlobStore } from "./store";

export interface ChunkRecord {
  fields: string[];
  /** Absolute 1-based physical source line. */
  line: number;
  /** Absolute byte offset of the record's terminating newline. */
  endByte: number;
}

export interface ChunkResult {
  startOffset: number;
  /** Absolute offset just past the last record in this chunk. */
  endOffset: number;
  baseLine: number;
  records: ChunkRecord[];
  /** Physical lines consumed (including newlines inside quoted fields). */
  lines: number;
  eof: boolean;
}

export interface ReadChunkOptions {
  store: BlobStore;
  key: string;
  size: number;
  startOffset: number;
  baseLine: number;
  /** Target chunk size in source bytes. */
  chunkBytes: number;
  /** Bytes fetched per request (bounded memory). */
  sliceBytes?: number;
  delimiter?: string;
  quote?: string;
}

const DEFAULT_SLICE_BYTES = 4 << 20;

export async function readChunk(options: ReadChunkOptions): Promise<ChunkResult> {
  // Never fetch much more than the chunk itself: with a 4 MiB slice and a 1 MiB
  // chunk the first record would immediately end the chunk.
  const sliceBytes = Math.min(options.sliceBytes ?? DEFAULT_SLICE_BYTES, Math.max(64 << 10, options.chunkBytes));
  const parser = new CsvParser({ delimiter: options.delimiter, quote: options.quote });
  const decoder = new TextDecoder("utf-8");
  const records: ChunkRecord[] = [];
  let offset = options.startOffset;
  let eof = false;

  while (offset < options.size) {
    const length = Math.min(sliceBytes, options.size - offset);
    const buffer = await options.store.getRange(options.key, offset, length);
    if (!buffer.length) {
      eof = true;
      break;
    }
    offset += buffer.length;
    const text = decoder.decode(buffer, { stream: true });

    let cut = false;
    for (const record of parser.push(text)) {
      const chunkRecord = toChunkRecord(record, options.startOffset, options.baseLine);
      records.push(chunkRecord);
      if (chunkRecord.endByte - options.startOffset >= options.chunkBytes) {
        // The parser has just consumed this record's newline, so its state is a
        // record boundary. Any bytes fetched beyond `endByte` are dropped and
        // re-read by the next chunk: the checkpoint names this exact offset.
        cut = true;
        break;
      }
    }
    if (cut) break;
    if (buffer.length < length) {
      eof = true;
      break;
    }
  }

  if (offset >= options.size) eof = true;

  if (eof) {
    for (const record of parser.end()) {
      records.push(toChunkRecord(record, options.startOffset, options.baseLine));
    }
  }

  const endOffset = records.length ? records[records.length - 1]!.endByte : offset;
  return {
    startOffset: options.startOffset,
    endOffset,
    baseLine: options.baseLine,
    records,
    lines: parser.linesConsumed,
    eof,
  };
}

function toChunkRecord(record: CsvRecord, chunkStart: number, baseLine: number): ChunkRecord {
  // `endByte` is set by the parser for both a newline-terminated record and one
  // flushed by `end()` (a file without a trailing newline).
  return { fields: record.fields, line: baseLine + record.line - 1, endByte: chunkStart + (record.endByte ?? 0) };
}

/**
 * Read the header record of a source without reading the whole object.
 *
 * A quoted header is legal (and a header is never longer than a few KB in these
 * files), so this uses the parser rather than splitting on the first tab.
 */
export async function readHeader(options: {
  store: BlobStore;
  key: string;
  size: number;
  delimiter?: string;
  quote?: string;
}): Promise<{ fields: string[]; bytes: number }> {
  const maxHeaderBytes = 256 * 1024;
  const buffer = await options.store.getRange(options.key, 0, Math.min(options.size, maxHeaderBytes));
  const parser = new CsvParser({ delimiter: options.delimiter, quote: options.quote });
  for (const record of parser.push(new TextDecoder("utf-8").decode(buffer))) {
    return { fields: record.fields, bytes: record.endByte ?? buffer.length };
  }
  for (const record of parser.end()) return { fields: record.fields, bytes: buffer.length };
  throw new Error(`Source ${options.key} has no header record.`);
}
