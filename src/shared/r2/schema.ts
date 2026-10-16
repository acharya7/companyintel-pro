/**
 * Schema report for one source object.
 *
 * The probe may inspect a bounded sample of a real 10 GB / 50 GB CSV, and what
 * comes back is a *shape* report: encoding, delimiter, header names, fill rates,
 * column types and mapping suggestions with a confidence and the evidence behind
 * it.
 *
 * Hard rules encoded here:
 *   - **No cell values.** Column statistics are built without samples and the
 *     report says so explicitly (`redaction`), so a schema report can be pasted
 *     into a chat or a commit without leaking a single contact record.
 *   - **No invented fields.** A column that matches no alias and no value shape
 *     is reported as unmapped; nothing is guessed to fill the gap.
 *   - **Ambiguity is surfaced.** If two columns claim one canonical field, both
 *     are flagged and listed as each other's alternative.
 */

import { truncateAtRecordBoundary, detectDelimiter, detectEncoding, decodeBytes, parseRecords, type DelimiterDetection } from "../csv-parse";
import { profileRecords, type FileProfile } from "../csv-profile";
import { ALL_CANONICAL_FIELDS, aliasIndex, normalizeHeader } from "../headers";

export type Confidence = "high" | "medium" | "low";

export interface SchemaColumn {
  index: number;
  header: string;
  normalized: string;
  nonEmptyCount: number;
  emptyCount: number;
  /** Share of inspected rows where the column had a value (0–1). */
  fillRate: number;
  approximateUnique: number;
  maxLength: number;
  looksLike: string;
}

export interface FieldSuggestion {
  column: string;
  index: number;
  proposedField: string | null;
  confidence: Confidence | null;
  evidence: string;
  /** Other canonical fields this column could plausibly be. */
  alternatives: string[];
  ambiguous: boolean;
}

export interface SchemaReport {
  key: string;
  objectBytes: number | null;
  sample: {
    requestedBytes: number;
    bytesRead: number;
    /** The object is larger than the sample that was read. */
    truncated: boolean;
    /** The sample ended on a complete record boundary and could be parsed. */
    completeRecords: boolean;
    rowsInspected: number;
  };
  encoding: { encoding: string; label: string; confidence: Confidence; notes: string[] };
  delimiter: { delimiter: string; confidence: Confidence; evidence: string };
  headerLine: number;
  headers: string[];
  columns: SchemaColumn[];
  mapping: FieldSuggestion[];
  unmappedColumns: string[];
  canonicalFieldsAbsent: string[];
  redaction: string;
  notes: string[];
  problems: string[];
}

export interface SchemaReportInput {
  key: string;
  bytes: Uint8Array;
  /** Real object size when known, so the report can say how much was sampled. */
  objectBytes?: number | null;
  /** Whether the read was cut short by the sample bound (not by end of object). */
  truncatedByBound?: boolean;
  /** Rows to inspect after the header. */
  maxRows?: number;
  knownFields?: readonly string[];
}

/** Value-shape fallbacks used only when the header itself matches no alias. */
const SHAPE_FALLBACKS: Record<string, { field: string; alternatives: string[]; evidence: string }> = {
  email: { field: "email", alternatives: [], evidence: "every sampled value looks like an email address" },
  url: {
    field: "companywebsite",
    alternatives: ["companydomain"],
    evidence: "sampled values look like URLs/domains; a website and a domain are different canonical fields, so this needs confirmation",
  },
  phone: { field: "phone", alternatives: [], evidence: "sampled values look like phone numbers" },
};

export function buildSchemaReport(input: SchemaReportInput): SchemaReport {
  const notes: string[] = [];
  const problems: string[] = [];
  const maxRows = input.maxRows ?? 1000;
  const knownFields = input.knownFields ?? ALL_CANONICAL_FIELDS;

  const encoding = detectEncoding(input.bytes);
  const text = decodeBytes(input.bytes, encoding.encoding);
  const delimiter = detectDelimiter(text);

  // A byte bound can land inside a quoted, multiline record, so a sample that hit
  // the bound is trimmed back to its last COMPLETE record. A sample that read the
  // whole object is used as-is: trimming it would discard a real final row (a file
  // whose last record has no trailing newline is perfectly normal).
  const truncatedByBound = Boolean(input.truncatedByBound);
  const complete = truncatedByBound ? truncateAtRecordBoundary(text) : text;
  const completeRecords = complete.trim().length > 0;
  if (!completeRecords) {
    problems.push("the sampled bytes contained no complete record — raise the sample size (--sample-bytes) before trusting this report");
  }

  const delimiterConfidence: DelimiterDetection = delimiter;
  const profile: FileProfile = profileRecords(parseRecords(complete, { delimiter: delimiter.delimiter, maxRecords: maxRows + 1 }), {
    path: input.key,
    encoding: encoding.encoding,
    delimiter: delimiter.delimiter,
    sampleRows: maxRows,
    knownFields,
    // Never keep example values: this report must stay free of contact data.
    maxSamplesPerColumn: 0,
  });

  if (encoding.confidence !== "high") notes.push(...encoding.notes);
  if (delimiterConfidence.confidence !== "high") {
    notes.push(`delimiter confidence is ${delimiterConfidence.confidence}: ${delimiterConfidence.evidence}`);
  }
  if (!profile.headers.length) problems.push("no header row could be read from the sample");
  if (truncatedByBound && input.objectBytes !== null && input.objectBytes !== undefined && input.bytes.length < input.objectBytes) {
    notes.push(
      `the object is larger than the sample: ${input.bytes.length} of ${input.objectBytes} bytes were read, so the report describes the first ` +
        `${profile.sampledRows} data rows only.`,
    );
  }

  const columns: SchemaColumn[] = profile.columns.map((column) => {
    const inspected = column.nonEmptyCount + column.emptyCount;
    return {
      index: column.index,
      header: column.header,
      normalized: column.normalized,
      nonEmptyCount: column.nonEmptyCount,
      emptyCount: column.emptyCount,
      fillRate: inspected === 0 ? 0 : column.nonEmptyCount / inspected,
      approximateUnique: column.approximateUnique,
      maxLength: column.maxLength,
      looksLike: column.looksLike,
    };
  });

  const mapping = suggestMappings(columns);
  const proposed = new Set(mapping.map((entry) => entry.proposedField).filter((field): field is string => Boolean(field)));

  return {
    key: input.key,
    objectBytes: input.objectBytes ?? null,
    sample: {
      requestedBytes: input.bytes.length,
      bytesRead: input.bytes.length,
      truncated: truncatedByBound,
      completeRecords,
      rowsInspected: profile.sampledRows,
    },
    encoding: { encoding: encoding.encoding, label: encoding.label, confidence: encoding.confidence, notes: encoding.notes },
    delimiter: { delimiter: delimiter.delimiter, confidence: delimiter.confidence, evidence: delimiter.evidence },
    headerLine: profile.headerLine,
    headers: profile.headers,
    columns,
    mapping,
    unmappedColumns: mapping.filter((entry) => entry.proposedField === null).map((entry) => entry.column),
    canonicalFieldsAbsent: knownFields.filter((field) => !proposed.has(field)),
    redaction: "No cell values, contact names, email addresses or phone numbers are included in this report.",
    notes,
    problems,
  };
}

/**
 * Suggest a canonical field for every column, with the evidence and any
 * ambiguity. Header aliases win; value shapes are only a fallback because a
 * column called "Value 3" full of emails is not necessarily the contact email.
 */
export function suggestMappings(columns: SchemaColumn[]): FieldSuggestion[] {
  const aliases = aliasIndex();
  const suggestions: FieldSuggestion[] = columns.map((column) => {
    const aliasField = aliases.get(column.normalized);
    if (aliasField) {
      return {
        column: column.header,
        index: column.index,
        proposedField: aliasField,
        confidence: "high",
        evidence: `header "${column.header}" matches an alias of ${aliasField}`,
        alternatives: [],
        ambiguous: false,
      };
    }
    const fallback = SHAPE_FALLBACKS[column.looksLike];
    if (fallback) {
      return {
        column: column.header,
        index: column.index,
        proposedField: fallback.field,
        confidence: column.looksLike === "url" ? "medium" : "medium",
        evidence: fallback.evidence,
        alternatives: fallback.alternatives,
        ambiguous: fallback.alternatives.length > 0,
      };
    }
    return {
      column: column.header,
      index: column.index,
      proposedField: null,
      confidence: null,
      evidence:
        column.looksLike === "empty"
          ? "no values in the sample"
          : column.looksLike === "number"
            ? "a bare number column is not mapped automatically"
            : "no header alias and no recognisable value shape",
      alternatives: [],
      ambiguous: false,
    };
  });

  // Two columns claiming one canonical field is ambiguity, not a mapping.
  const byField = new Map<string, FieldSuggestion[]>();
  for (const suggestion of suggestions) {
    if (!suggestion.proposedField) continue;
    const list = byField.get(suggestion.proposedField) ?? [];
    list.push(suggestion);
    byField.set(suggestion.proposedField, list);
  }
  for (const [field, list] of byField) {
    if (list.length < 2) continue;
    for (const suggestion of list) {
      suggestion.ambiguous = true;
      suggestion.confidence = "low";
      suggestion.alternatives = [...new Set([...suggestion.alternatives, ...list.filter((other) => other !== suggestion).map((other) => other.column)])];
      suggestion.evidence = `${suggestion.evidence}; ${list.length} columns match ${field}, so the mapping must be confirmed by hand`;
    }
  }

  return suggestions;
}

/**
 * A `columns` override for `tools/indexer/indexer.config.json`, containing only
 * unambiguous suggestions. Anything ambiguous or unmapped is deliberately left
 * out so a human decides — the config is the approval step, not this function.
 */
export function recommendedColumnOverride(report: SchemaReport): Record<string, string> {
  const override: Record<string, string> = {};
  for (const suggestion of report.mapping) {
    if (!suggestion.proposedField || suggestion.ambiguous) continue;
    if (override[suggestion.proposedField]) continue;
    override[suggestion.proposedField] = suggestion.column;
  }
  return override;
}

/** Normalize a header the same way the alias matcher does (exported for reports). */
export { normalizeHeader };
