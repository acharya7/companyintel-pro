/**
 * Local-file CSV reading for the indexer.
 *
 * The parser, the value classification and the column statistics now live in
 * `src/shared` (`csv.ts`, `csv-profile.ts`) because the read-only R2 probe
 * inspects the same files with the same rules. This module keeps only what is
 * specific to a machine with a filesystem: streaming a file from disk, and the
 * re-exports every existing `from "./csv"` import relies on.
 *
 * Guarantees for the file reader:
 *  - constant memory: a state machine over decoded chunks, so a 50 GB file never
 *    has to be buffered;
 *  - streaming `TextDecoder`, so multi-byte characters split across chunk
 *    boundaries decode correctly;
 *  - `maxRecords` for bounded sampling, with bytes consumed reported through
 *    `onBytes` so callers can show progress.
 */

import { createReadStream } from "node:fs";

import { CsvParser, type CsvParseOptions, type CsvRecord } from "../../../src/shared/csv-parse";
import {
  createProfileAccumulator,
  consumeProfileRecord,
  finishProfile,
  profileComplete,
  type FileProfile,
} from "../../../src/shared/csv-profile";

export { CsvParser, guessDelimiter, parseRecords, classifyValue, quoteCount, truncateAtRecordBoundary } from "../../../src/shared/csv-parse";
export type { CsvParseOptions, CsvRecord, ValueKind } from "../../../src/shared/csv-parse";
export { normalizeHeader } from "../../../src/shared/headers";
export type { ColumnProfile, FileProfile, ProfileOptions } from "../../../src/shared/csv-profile";

export interface CsvReadOptions extends CsvParseOptions {
  encoding?: string;
  /** Stop after this many records (used for sampling and profiling). */
  maxRecords?: number;
  /** Called with bytes consumed, so callers can show progress. */
  onBytes?: (bytes: number) => void;
}

/** Read a CSV file as an async stream of records. */
export async function* readCsvFile(path: string, options: CsvReadOptions = {}): AsyncGenerator<CsvRecord> {
  const parser = new CsvParser(options);
  const decoder = new TextDecoder(options.encoding ?? "utf8", { fatal: false, ignoreBOM: true });
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  let seen = 0;
  let bytes = 0;

  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    options.onBytes?.(bytes);
    for (const record of parser.push(decoder.decode(buffer, { stream: true }))) {
      if (options.maxRecords !== undefined && seen >= options.maxRecords) return;
      seen += 1;
      yield record;
    }
  }
  for (const record of parser.push(decoder.decode())) {
    if (options.maxRecords !== undefined && seen >= options.maxRecords) return;
    seen += 1;
    yield record;
  }
  for (const record of parser.end()) {
    if (options.maxRecords !== undefined && seen >= options.maxRecords) return;
    seen += 1;
    yield record;
  }
}

/**
 * Profile a CSV file: headers, sample values, fill rates and a guess at what
 * each column contains. Run this before mapping anything — the specification
 * requires the real headers to be inspected rather than assumed.
 */
export async function profileCsvFile(
  path: string,
  options: CsvReadOptions & { sampleRows?: number; knownFields?: readonly string[] } = {},
): Promise<FileProfile> {
  const accumulator = createProfileAccumulator(options);
  let bytes = 0;

  for await (const record of readCsvFile(path, {
    ...options,
    onBytes: (value) => {
      bytes = value;
      options.onBytes?.(value);
    },
  })) {
    if (profileComplete(accumulator)) break;
    consumeProfileRecord(accumulator, record);
  }

  return finishProfile(accumulator, {
    path,
    delimiter: options.delimiter ?? ",",
    encoding: options.encoding ?? "utf8",
    knownFields: options.knownFields,
    bytes,
  });
}
