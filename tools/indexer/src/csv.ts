/**
 * Streaming CSV reader — written by hand so the indexing engine has no runtime
 * dependency that could behave differently on Windows, and so quoted multiline
 * fields are handled exactly the way the specification requires.
 *
 * Guarantees:
 *  - constant memory: the parser is a state machine over decoded chunks, so a
 *    50 GB file never has to be buffered;
 *  - RFC 4180 quoting: `"` quoting, `""` escaped quotes, embedded newlines and
 *    delimiters inside quotes;
 *  - configurable delimiter and encoding (`utf8`, `utf16le`, `windows-1252`,
 *    `latin1`), with streaming `TextDecoder` so multi-byte characters split
 *    across chunk boundaries decode correctly;
 *  - every record reports the physical line number where it started, which is
 *    stored as source traceability (`SourceRef.row`).
 */

import { createReadStream } from "node:fs";

export interface CsvRecord {
  fields: string[];
  /** 1-based physical line where the record started. */
  line: number;
}

export interface CsvReadOptions {
  delimiter?: string;
  quote?: string;
  encoding?: string;
  /** Stop after this many records (used for sampling and profiling). */
  maxRecords?: number;
  /** Called with bytes consumed, so callers can show progress. */
  onBytes?: (bytes: number) => void;
}

export class CsvParser {
  private readonly delimiter: string;
  private readonly quote: string;
  private field = "";
  private fields: string[] = [];
  private inQuotes = false;
  private line = 1;
  private recordStartLine = 1;
  private pendingQuote = false;
  private started = false;

  constructor(options: Pick<CsvReadOptions, "delimiter" | "quote"> = {}) {
    this.delimiter = options.delimiter ?? ",";
    this.quote = options.quote ?? '"';
  }

  /** Feed a decoded chunk; yields every complete record it can build. */
  *push(chunk: string): Generator<CsvRecord> {
    // Strip a UTF-8 BOM that survived decoding.
    if (!this.started) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }

    for (let i = 0; i < chunk.length; i += 1) {
      const char = chunk[i];

      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (char === this.quote) {
          this.field += this.quote;
          continue;
        }
        this.inQuotes = false;
        // Fall through: the current char is still part of the record.
      }

      if (this.inQuotes) {
        if (char === this.quote) this.pendingQuote = true;
        else {
          if (char === "\n") this.line += 1;
          this.field += char;
        }
        continue;
      }

      if (char === this.quote && this.field.length === 0) {
        this.inQuotes = true;
        continue;
      }
      if (char === this.delimiter) {
        this.fields.push(this.field);
        this.field = "";
        continue;
      }
      if (char === "\r") continue; // handled with the following \n
      if (char === "\n") {
        this.fields.push(this.field);
        const record: CsvRecord = { fields: this.fields, line: this.recordStartLine };
        this.fields = [];
        this.field = "";
        this.line += 1;
        this.recordStartLine = this.line;
        yield record;
        continue;
      }
      this.field += char;
    }
  }

  /** Flush a trailing record when the file does not end with a newline. */
  *end(): Generator<CsvRecord> {
    if (this.field.length || this.fields.length) {
      this.fields.push(this.field);
      const record: CsvRecord = { fields: this.fields, line: this.recordStartLine };
      this.fields = [];
      this.field = "";
      yield record;
    }
  }
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
  looksLike: "email" | "url" | "phone" | "number" | "text" | "empty";
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// Accepts both fully qualified URLs and bare hostnames, because domain columns
// in real exports frequently omit the scheme.
const URL_RE = /^(https?:\/\/|www\.)|^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+\/?[^\s]*$/i;
const PHONE_RE = /^[+()\d][\d\s().-]{5,}$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Profile a CSV file: headers, sample values, fill rates and a guess at what
 * each column contains. Run this before mapping anything — the specification
 * requires the real headers to be inspected rather than assumed.
 */
export async function profileCsvFile(
  path: string,
  options: CsvReadOptions & { sampleRows?: number; knownFields?: string[] } = {},
): Promise<FileProfile> {
  const sampleRows = options.sampleRows ?? 500;
  const delimiter = options.delimiter ?? ",";
  const encoding = options.encoding ?? "utf8";
  const known = new Set(options.knownFields ?? []);
  let headers: string[] = [];
  let headerLine = 1;
  let bytes = 0;
  let rows = 0;

  const stats: {
    samples: string[];
    empty: number;
    nonEmpty: number;
    unique: Set<string>;
    maxLength: number;
    email: number;
    url: number;
    phone: number;
    number: number;
  }[] = [];

  for await (const record of readCsvFile(path, {
    ...options,
    delimiter,
    encoding,
    maxRecords: sampleRows + 1,
    onBytes: (value) => {
      bytes = value;
    },
  })) {
    if (!headers.length) {
      headers = record.fields.map((field) => field.trim());
      headerLine = record.line;
      for (let i = 0; i < headers.length; i += 1) {
        stats.push({ samples: [], empty: 0, nonEmpty: 0, unique: new Set(), maxLength: 0, email: 0, url: 0, phone: 0, number: 0 });
      }
      continue;
    }
    rows += 1;
    record.fields.forEach((raw, index) => {
      const column = stats[index];
      if (!column) return;
      const value = raw.trim();
      if (!value) {
        column.empty += 1;
        return;
      }
      column.nonEmpty += 1;
      column.maxLength = Math.max(column.maxLength, value.length);
      if (column.samples.length < 3) column.samples.push(value.slice(0, 120));
      if (column.unique.size < 1000) column.unique.add(value);
      if (EMAIL_RE.test(value)) column.email += 1;
      else if (URL_RE.test(value)) column.url += 1;
      else if (PHONE_RE.test(value) && !NUMBER_RE.test(value)) column.phone += 1;
      else if (NUMBER_RE.test(value)) column.number += 1;
    });
  }

  const columns: ColumnProfile[] = headers.map((header, index) => {
    const column = stats[index] ?? { samples: [], empty: 0, nonEmpty: 0, unique: new Set<string>(), maxLength: 0, email: 0, url: 0, phone: 0, number: 0 };
    // Type detection ignores empty cells: a sparsely filled column is still an
    // email column, its fill rate is reported separately.
    const total = Math.max(1, column.nonEmpty);
    const dominant = Math.max(column.email, column.url, column.phone, column.number);
    const looksLike: ColumnProfile["looksLike"] =
      column.nonEmpty === 0
        ? "empty"
        : dominant / total > 0.6
          ? column.email > column.url && column.email > column.phone && column.email > column.number
            ? "email"
            : column.url >= column.phone && column.url >= column.number
              ? "url"
              : column.phone >= column.number
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

  const unmappedHeaders = columns
    .filter((column) => !known.has(column.normalized))
    .map((column) => column.header);

  return {
    path,
    bytes,
    delimiter,
    encoding,
    sampledRows: rows,
    headerLine,
    headers,
    columns,
    unmappedHeaders,
    missingCanonicalFields: [...known].filter((field) => !columns.some((column) => column.normalized === field)),
  };
}

/** Normalize a header for matching: lowercase, alphanumeric only. */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Guess the delimiter by counting candidates in the header line. */
export function guessDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = headerLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}
