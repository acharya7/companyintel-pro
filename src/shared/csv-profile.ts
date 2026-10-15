/**
 * Column profiling: headers, fill rates, approximate cardinality and a guess at
 * what each column contains.
 *
 * Runtime-neutral on purpose — the same statistics back the indexer's `profile`
 * command (which streams a whole file) and the read-only R2 probe's schema
 * report (which may only inspect a bounded sample of one object). Keeping one
 * implementation means the sample report and the indexing run can never
 * disagree about a column.
 *
 * Samples are collected here but the probe report deliberately drops them: cell
 * values are private contact data and never leave the machine in a report.
 */

import { classifyValue, type CsvRecord } from "./csv-parse";
import { normalizeHeader } from "./headers";

export interface ColumnProfile {
  index: number;
  header: string;
  /** Normalized header used for mapping suggestions. */
  normalized: string;
  samples: string[];
  emptyCount: number;
  nonEmptyCount: number;
  approximateUnique: number;
  maxLength: number;
  looksLike: "email" | "url" | "phone" | "number" | "date" | "text" | "empty";
}

export interface FileProfile {
  path: string;
  bytes: number;
  delimiter: string;
  encoding: string;
  sampledRows: number;
  headerLine: number;
  headers: string[];
  columns: ColumnProfile[];
  /** Headers that do not match any known canonical field. */
  unmappedHeaders: string[];
  /** Canonical fields with no matching column in this file. */
  missingCanonicalFields: string[];
}

export interface ProfileOptions {
  /** Label used in the report (a path, or an `r2://bucket/key` url). */
  path?: string;
  encoding?: string;
  delimiter?: string;
  /** Rows to inspect after the header. */
  sampleRows?: number;
  /** Canonical fields to match against (see `ALL_CANONICAL_FIELDS`). */
  knownFields?: readonly string[];
  /** Keep up to this many example values per column (0 = never keep any). */
  maxSamplesPerColumn?: number;
}

interface ColumnStats {
  samples: string[];
  empty: number;
  nonEmpty: number;
  unique: Set<string>;
  maxLength: number;
  email: number;
  url: number;
  phone: number;
  number: number;
  date: number;
}

export interface ProfileAccumulator {
  headers: string[];
  headerLine: number;
  rows: number;
  stats: ColumnStats[];
  readonly sampleRows: number;
  readonly maxSamples: number;
}

export function createProfileAccumulator(options: ProfileOptions = {}): ProfileAccumulator {
  return {
    headers: [],
    headerLine: 1,
    rows: 0,
    stats: [],
    sampleRows: options.sampleRows ?? 500,
    maxSamples: options.maxSamplesPerColumn ?? 3,
  };
}

/** True when the accumulator has seen everything it was asked to sample. */
export function profileComplete(accumulator: ProfileAccumulator): boolean {
  return accumulator.headers.length > 0 && accumulator.rows >= accumulator.sampleRows;
}

/** Feed one record; the first record is always treated as the header row. */
export function consumeProfileRecord(accumulator: ProfileAccumulator, record: CsvRecord): void {
  if (!accumulator.headers.length) {
    accumulator.headers = record.fields.map((field) => field.trim());
    accumulator.headerLine = record.line;
    for (let index = 0; index < accumulator.headers.length; index += 1) {
      accumulator.stats.push({
        samples: [],
        empty: 0,
        nonEmpty: 0,
        unique: new Set(),
        maxLength: 0,
        email: 0,
        url: 0,
        phone: 0,
        number: 0,
        date: 0,
      });
    }
    return;
  }

  accumulator.rows += 1;
  record.fields.forEach((raw, index) => {
    const column = accumulator.stats[index];
    if (!column) return;
    const value = raw.trim();
    if (!value) {
      column.empty += 1;
      return;
    }
    column.nonEmpty += 1;
    column.maxLength = Math.max(column.maxLength, value.length);
    if (column.samples.length < accumulator.maxSamples) column.samples.push(value.slice(0, 120));
    if (column.unique.size < 1000) column.unique.add(value);
    const kind = classifyValue(value);
    if (kind === "email") column.email += 1;
    else if (kind === "url") column.url += 1;
    else if (kind === "phone") column.phone += 1;
    else if (kind === "number") column.number += 1;
    else if (kind === "date") column.date += 1;
  });
}

/** Turn accumulated statistics into the report shape. */
export function finishProfile(accumulator: ProfileAccumulator, options: ProfileOptions & { bytes?: number } = {}): FileProfile {
  const known = new Set(options.knownFields ?? []);
  const empty: ColumnStats = {
    samples: [],
    empty: 0,
    nonEmpty: 0,
    unique: new Set(),
    maxLength: 0,
    email: 0,
    url: 0,
    phone: 0,
    number: 0,
    date: 0,
  };

  const columns: ColumnProfile[] = accumulator.headers.map((header, index) => {
    const column = accumulator.stats[index] ?? empty;
    // Type detection ignores empty cells: a sparsely filled column is still an
    // email column, its fill rate is reported separately.
    const total = Math.max(1, column.nonEmpty);
    const dominant = Math.max(column.email, column.url, column.phone, column.number, column.date);
    const looksLike: ColumnProfile["looksLike"] =
      column.nonEmpty === 0
        ? "empty"
        : dominant / total > 0.6
          ? column.email >= dominant && column.email > 0
            ? "email"
            : column.url >= dominant && column.url > 0
              ? "url"
              : column.date >= dominant && column.date > 0
                ? "date"
                : column.phone >= dominant && column.phone > 0
                  ? "phone"
                  : "number"
          : "text";
    return {
      index,
      header,
      normalized: normalizeHeader(header),
      samples: column.samples,
      emptyCount: column.empty,
      nonEmptyCount: column.nonEmpty,
      approximateUnique: column.unique.size,
      maxLength: column.maxLength,
      looksLike,
    };
  });

  return {
    path: options.path ?? "(sample)",
    bytes: options.bytes ?? 0,
    delimiter: options.delimiter ?? ",",
    encoding: options.encoding ?? "utf8",
    sampledRows: accumulator.rows,
    headerLine: accumulator.headerLine,
    headers: accumulator.headers,
    columns,
    unmappedHeaders: columns.filter((column) => !known.has(column.normalized)).map((column) => column.header),
    missingCanonicalFields: [...known].filter((field) => !columns.some((column) => column.normalized === field)),
  };
}

/** Profile an in-memory list of records (already parsed, sample-sized). */
export function profileRecords(records: CsvRecord[], options: ProfileOptions & { bytes?: number } = {}): FileProfile {
  const accumulator = createProfileAccumulator(options);
  for (const record of records) {
    if (profileComplete(accumulator)) break;
    consumeProfileRecord(accumulator, record);
  }
  return finishProfile(accumulator, options);
}
