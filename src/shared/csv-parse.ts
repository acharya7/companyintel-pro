/**
 * Runtime-neutral CSV *parsing* and value classification.
 *
 * The local indexer, the read-only R2 probe Worker and the sample profiler all
 * need the same rules, so the parser lives here instead of in the indexer (which
 * additionally streams from a file or the network). Nothing in this module reads
 * the filesystem, the network or the environment.
 *
 * This is the *reader*. `./csv.ts` is the writer (app CSV exports); the two are
 * deliberately separate because only the writer must defend against spreadsheet
 * formula injection.
 *
 * Guarantees kept from the original indexer implementation:
 *  - RFC 4180 quoting: `"` quoting, `""` escaped quotes, embedded newlines and
 *    delimiters inside quotes;
 *  - a state machine over decoded chunks, so a 50 GB file never has to be
 *    buffered and a bounded sample never needs the whole object;
 *  - every record reports the physical line number where it started, which is
 *    stored as source traceability (`SourceRef.row`).
 */

export interface CsvRecord {
  fields: string[];
  /** 1-based physical line where the record started. */
  line: number;
}

export interface CsvParseOptions {
  delimiter?: string;
  quote?: string;
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

  constructor(options: CsvParseOptions = {}) {
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

/**
 * Parse a bounded text sample into records, stopping after `maxRecords`.
 *
 * Used where the input is already in memory (an R2 ranged read, a test fixture):
 * the caller is responsible for keeping the sample small.
 */
export function parseRecords(text: string, options: CsvParseOptions & { maxRecords?: number } = {}): CsvRecord[] {
  const parser = new CsvParser(options);
  const records: CsvRecord[] = [];
  const limit = options.maxRecords ?? Number.POSITIVE_INFINITY;
  for (const record of parser.push(text)) {
    if (records.length >= limit) return records;
    records.push(record);
  }
  for (const record of parser.end()) {
    if (records.length >= limit) return records;
    records.push(record);
  }
  return records;
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

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// Accepts both fully qualified URLs and bare hostnames, because domain columns
// in real exports frequently omit the scheme.
export const URL_RE = /^(https?:\/\/|www\.)|^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+\/?[^\s]*$/i;
export const PHONE_RE = /^[+()\d][\d\s().-]{5,}$/;
export const NUMBER_RE = /^-?\d+(\.\d+)?$/;
/** ISO-ish dates, so a date column is reported as a date and not as a phone number. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/;

export type ValueKind = "email" | "url" | "phone" | "number" | "date" | "text" | "empty";

/**
 * Classify one cell value. Email first, then URL, then an ISO date (checked
 * before the phone pattern, which would otherwise swallow `2026-01-01`), then
 * phone — a bare number is never a phone — then number; anything else is text.
 */
export function classifyValue(value: string): ValueKind {
  const text = value.trim();
  if (!text) return "empty";
  if (EMAIL_RE.test(text)) return "email";
  if (URL_RE.test(text)) return "url";
  if (DATE_RE.test(text)) return "date";
  if (PHONE_RE.test(text) && !NUMBER_RE.test(text)) return "phone";
  if (NUMBER_RE.test(text)) return "number";
  return "text";
}

/** Number of `"` characters. Escaped quotes are doubled, so parity is preserved. */
export function quoteCount(text: string): number {
  let count = 0;
  for (const character of String(text ?? "")) {
    if (character === '"') count += 1;
  }
  return count;
}

/**
 * Trim a byte-range sample back to the last complete CSV record.
 *
 * Slicing at the final newline is not enough: if the range ends inside a quoted
 * field that spans lines, the last "line" is half a record and the quote in it is
 * unbalanced. So the sample is scanned with the same quoting rules as the parser
 * and cut at the last newline that ends a record *outside* quotes.
 *
 * A quote-counting heuristic cannot replace this. Real exports contain a single `"`
 * inside a field (an inch mark, a `5"` diameter, a stray escaped quote), and one
 * unbalanced quote makes the parity of the whole prefix odd — a "drop lines until
 * the count is even" loop then throws away EVERY complete record and returns an
 * empty sample. That is exactly what happened to the first real source file here:
 * 6 MB with 2,768 lines was reported as "no complete record", which is how a file
 * with a perfectly good header looks when the boundary heuristic is wrong.
 *
 * Returns `""` only when the sample genuinely contains no complete record (for
 * example a single record with no newline at all, which is what a truncated first
 * chunk looks like).
 */
export function truncateAtRecordBoundary(text: string, options: CsvParseOptions = {}): string {
  const source = String(text ?? "");
  if (!source) return "";
  const delimiter = options.delimiter ?? ",";
  const quote = options.quote ?? '"';

  let inQuotes = false;
  let atFieldStart = true;
  /** Index just past the last newline that completed a record. */
  let end = -1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inQuotes) {
      if (character === quote) {
        // `""` is an escaped quote and stays inside the field.
        if (source[index + 1] === quote) {
          index += 1;
          continue;
        }
        inQuotes = false;
      }
      continue;
    }
    if (character === quote && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      continue;
    }
    if (character === delimiter) {
      atFieldStart = true;
      continue;
    }
    if (character === "\n") {
      end = index + 1;
      atFieldStart = true;
      continue;
    }
    if (character === "\r") continue; // part of a CRLF pair
    atFieldStart = false;
  }

  return end > 0 ? source.slice(0, end) : "";
}

export interface EncodingDetection {
  /** Encoding name accepted by `TextDecoder` and the indexer config. */
  encoding: string;
  label: string;
  bomBytes: number;
  confidence: "high" | "medium" | "low";
  notes: string[];
}

/**
 * Detect the encoding of a byte sample from its BOM, falling back to a UTF-8
 * validity check. A file that is neither BOM-marked nor valid UTF-8 is reported
 * as an uncertain single-byte encoding rather than silently decoded as UTF-8.
 */
export function detectEncoding(bytes: Uint8Array): EncodingDetection {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf-8", label: "UTF-8 (BOM)", bomBytes: 3, confidence: "high", notes: [] };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf-16le", label: "UTF-16 LE (BOM)", bomBytes: 2, confidence: "high", notes: [] };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: "utf-16be", label: "UTF-16 BE (BOM)", bomBytes: 2, confidence: "high", notes: [] };
  }

  let ascii = true;
  for (const byte of bytes) {
    if (byte > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) return { encoding: "utf-8", label: "ASCII", bomBytes: 0, confidence: "high", notes: [] };

  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { encoding: "utf-8", label: "UTF-8 (no BOM)", bomBytes: 0, confidence: "high", notes: [] };
  } catch {
    return {
      encoding: "windows-1252",
      label: "not valid UTF-8 — assumed Windows-1252",
      bomBytes: 0,
      confidence: "low",
      notes: [
        "The sample is not valid UTF-8. It is assumed to be a single-byte encoding (Windows-1252);",
        "confirm the `encoding` value in the indexer config before a full run.",
      ],
    };
  }
}

/** Decode a byte sample with the detected (or configured) encoding. */
export function decodeBytes(bytes: Uint8Array, encoding: string): string {
  return new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(bytes);
}

export interface DelimiterDetection {
  delimiter: string;
  confidence: "high" | "medium" | "low";
  evidence: string;
  candidates: { delimiter: string; fieldsInHeader: number; consistentRecords: number; checkedRecords: number }[];
}

/**
 * Choose the delimiter by parsing a few records with each candidate and keeping
 * the one that yields the most consistent, widest rows. Counting raw characters
 * in the header alone would pick `,` inside a quoted company name.
 */
export function detectDelimiter(text: string, options: { maxRecords?: number } = {}): DelimiterDetection {
  const maxRecords = options.maxRecords ?? 20;
  const candidates: DelimiterDetection["candidates"] = [];

  for (const delimiter of [",", ";", "\t", "|"]) {
    const records = parseRecords(text, { delimiter, maxRecords });
    if (!records.length) {
      candidates.push({ delimiter, fieldsInHeader: 0, consistentRecords: 0, checkedRecords: 0 });
      continue;
    }
    const width = records[0].fields.length;
    const consistent = records.filter((record) => record.fields.length === width).length;
    candidates.push({ delimiter, fieldsInHeader: width, consistentRecords: consistent, checkedRecords: records.length });
  }

  const scored = candidates
    .map((candidate) => ({
      candidate,
      // Width only counts when the rows agree: a stray delimiter makes rows ragged.
      score: candidate.fieldsInHeader > 1 ? candidate.fieldsInHeader * (candidate.consistentRecords / Math.max(1, candidate.checkedRecords)) : 0,
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score === 0) {
    return {
      delimiter: ",",
      confidence: "low",
      evidence: "no candidate produced more than one consistent column — assuming a comma",
      candidates,
    };
  }

  const consistentRatio = best.candidate.consistentRecords / Math.max(1, best.candidate.checkedRecords);
  const clearWinner = !runnerUp || runnerUp.score === 0 || best.score >= runnerUp.score * 1.5;
  const confidence: DelimiterDetection["confidence"] = clearWinner && consistentRatio === 1 ? "high" : clearWinner ? "medium" : "low";
  return {
    delimiter: best.candidate.delimiter,
    confidence,
    evidence:
      `${JSON.stringify(best.candidate.delimiter)} gives ${best.candidate.fieldsInHeader} columns in ` +
      `${best.candidate.consistentRecords}/${best.candidate.checkedRecords} sampled records` +
      (runnerUp && runnerUp.score > 0 ? ` (next best ${JSON.stringify(runnerUp.candidate.delimiter)}: ${runnerUp.candidate.fieldsInHeader})` : ""),
    candidates,
  };
}
