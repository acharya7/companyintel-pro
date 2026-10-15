/**
 * Schema reports (`src/shared/r2/schema.ts`) — the part of the probe that reads a
 * bounded sample of a real CSV.
 *
 * These are pure, offline tests: synthetic bytes in, report out. They pin the
 * rules that matter before anything touches a 50 GB object:
 *
 *   - encoding is detected from the BOM and from UTF-8 validity, and an uncertain
 *     single-byte file is reported as uncertain instead of silently mis-decoded;
 *   - the delimiter comes from parsing records, not from counting commas in a
 *     header that may contain a quoted company name;
 *   - a byte bound that lands inside a quoted multiline record is trimmed back to
 *     the last complete record, while a fully read sample keeps its final row;
 *   - mapping suggestions carry a confidence plus the evidence, ambiguity is
 *     flagged, and no cell value ever appears in the report.
 */

import { describe, expect, test } from "bun:test";

import { buildSchemaReport, recommendedColumnOverride, suggestMappings } from "../src/shared/r2/schema";
import { detectDelimiter, detectEncoding } from "../src/shared/csv-parse";

const EMAIL = "ada@acme.example";
const PHONE = "+1 555 0100";
const PERSON = "Ada Lovelace";

const SAMPLE = [
  "Company Name;Website;Contact Name;Email;Contact Email;Phone;Notes",
  `"Acme, Inc.";acme.example;${PERSON};${EMAIL};info@acme.example;${PHONE};"line one`,
  'line two"',
  "Beta Ltd;beta.example;Alan Turing;alan@beta.example;hello@beta.example;+1 555 0200;plain",
].join("\n");

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("encoding detection", () => {
  test("detects UTF-8 and UTF-16 BOMs, ASCII and plain UTF-8", () => {
    expect(detectEncoding(utf8Bytes("\uFEFFa,b\n1,2\n")).encoding).toBe("utf-8");
    expect(detectEncoding(utf8Bytes("\uFEFFa,b\n1,2\n")).label).toContain("BOM");
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00]))).toMatchObject({ encoding: "utf-16le", confidence: "high" });
    expect(detectEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x61]))).toMatchObject({ encoding: "utf-16be", confidence: "high" });
    expect(detectEncoding(utf8Bytes("a,b\n1,2\n")).label).toBe("ASCII");
    expect(detectEncoding(utf8Bytes("name,café\n")).label).toContain("UTF-8");
  });

  test("an invalid UTF-8 sample is reported as uncertain, not silently decoded", () => {
    // 0xE9 alone is the classic latin1/windows-1252 "é": invalid UTF-8.
    const bytes = new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x2c, 0xe9, 0x0a]);
    const detection = detectEncoding(bytes);
    expect(detection.encoding).toBe("windows-1252");
    expect(detection.confidence).toBe("low");
    expect(detection.notes.join(" ")).toContain("not valid UTF-8");
  });
});

describe("delimiter detection", () => {
  test("ignores delimiters inside quoted fields", () => {
    const detection = detectDelimiter(SAMPLE);
    expect(detection.delimiter).toBe(";");
    expect(detection.confidence).toBe("high");
    expect(detection.evidence).toContain("columns in");
  });

  test("supports tab separated files", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3\n").delimiter).toBe("\t");
  });

  test("a single-column file is reported as a low-confidence comma", () => {
    const detection = detectDelimiter("name\nAcme\nBeta\n");
    expect(detection.confidence).toBe("low");
    expect(detection.evidence).toContain("assuming a comma");
  });
});

describe("schema report", () => {
  test("describes headers, fill rates and types without any cell value", () => {
    const report = buildSchemaReport({ key: "raw/companies_part2.csv", bytes: utf8Bytes(SAMPLE), objectBytes: SAMPLE.length, truncatedByBound: false });

    expect(report.key).toBe("raw/companies_part2.csv");
    expect(report.delimiter.delimiter).toBe(";");
    expect(report.headers).toEqual(["Company Name", "Website", "Contact Name", "Email", "Contact Email", "Phone", "Notes"]);
    // Two data rows: the quoted multiline record counts once, not twice.
    expect(report.sample.rowsInspected).toBe(2);
    expect(report.sample.completeRecords).toBe(true);
    expect(report.sample.truncated).toBe(false);
    expect(report.headerLine).toBe(1);

    const email = report.columns.find((column) => column.header === "Email")!;
    expect(email.looksLike).toBe("email");
    expect(email.fillRate).toBe(1);
    const phone = report.columns.find((column) => column.header === "Phone")!;
    expect(phone.looksLike).toBe("phone");
    const notes = report.columns.find((column) => column.header === "Notes")!;
    expect(notes.looksLike).toBe("text");
    expect(notes.maxLength).toBeGreaterThan(0);

    const text = JSON.stringify(report);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(PERSON);
    expect(text).not.toContain("Acme, Inc.");
    expect(report.redaction).toContain("No cell values");
    expect(report.problems).toEqual([]);
  });

  test("suggests canonical fields with confidence and evidence", () => {
    const report = buildSchemaReport({ key: "raw/companies_part2.csv", bytes: utf8Bytes(SAMPLE) });
    const byColumn = new Map(report.mapping.map((entry) => [entry.column, entry]));

    expect(byColumn.get("Company Name")).toMatchObject({ proposedField: "companyname", confidence: "high" });
    expect(byColumn.get("Website")?.proposedField).toBe("companydomain");
    expect(byColumn.get("Contact Name")?.proposedField).toBe("contactname");
    expect(byColumn.get("Phone")?.proposedField).toBe("phone");
    expect(byColumn.get("Notes")?.proposedField).toBeNull();
    expect(byColumn.get("Notes")?.evidence).toContain("no header alias");

    // Two columns both look like the contact email: ambiguity, so confidence drops
    // and both are told about each other rather than one being silently chosen.
    const email = byColumn.get("Email")!;
    const contactEmail = byColumn.get("Contact Email")!;
    expect(email.proposedField).toBe("email");
    expect(contactEmail.proposedField).toBe("email");
    expect(email.ambiguous).toBe(true);
    expect(email.confidence).toBe("low");
    expect(email.alternatives).toContain("Contact Email");

    expect(report.unmappedColumns).toContain("Notes");
    expect(report.canonicalFieldsAbsent).toContain("companylinkedin");
    expect(report.canonicalFieldsAbsent).not.toContain("email");
  });

  test("value shapes are only a fallback, and a URL column is flagged as ambiguous", () => {
    const text = "Record,Value 1,Link\n1,ada@acme.example,acme.example\n2,alan@beta.example,beta.example\n";
    const report = buildSchemaReport({ key: "raw/odd.csv", bytes: utf8Bytes(text) });
    const byColumn = new Map(report.mapping.map((entry) => [entry.column, entry]));

    expect(byColumn.get("Record")).toMatchObject({ proposedField: null });
    expect(byColumn.get("Value 1")).toMatchObject({ proposedField: "email", confidence: "medium" });
    expect(byColumn.get("Value 1")?.evidence).toContain("looks like an email address");
    expect(byColumn.get("Link")?.ambiguous).toBe(true);
    expect(byColumn.get("Link")?.alternatives).toContain("companydomain");
  });

  test("the recommended override omits anything ambiguous or unmapped", () => {
    const report = buildSchemaReport({ key: "raw/companies_part2.csv", bytes: utf8Bytes(SAMPLE) });
    const override = recommendedColumnOverride(report);
    expect(override.companyname).toBe("Company Name");
    expect(override.phone).toBe("Phone");
    // Both email columns were ambiguous: a human decides, not this function.
    expect(override.email).toBeUndefined();
    expect(Object.values(override)).not.toContain("Notes");
  });

  test("a sample cut inside a record keeps only complete rows", () => {
    const bytes = utf8Bytes(SAMPLE);

    // Cut inside the second data row: the header and the first (multiline) record
    // are complete, so they are the only rows profiled.
    const cutAfterFirstRow = bytes.slice(0, SAMPLE.indexOf("alan@beta.example") + 3);
    const report = buildSchemaReport({
      key: "raw/part.csv",
      bytes: cutAfterFirstRow,
      objectBytes: bytes.length,
      truncatedByBound: true,
    });
    expect(report.sample.truncated).toBe(true);
    expect(report.sample.rowsInspected).toBe(1);
    expect(report.headers).toHaveLength(7);
    expect(report.columns.find((column) => column.header === "Email")?.fillRate).toBe(1);
    // The half-row is not mistaken for a column or a value.
    expect(JSON.stringify(report)).not.toContain("alan@beta");

    // Cut inside the quoted, multiline record itself: it is incomplete, so only the
    // header is complete and no row is profiled at all (rather than half a row).
    const cutInsideQuoted = bytes.slice(0, SAMPLE.indexOf("line one") + 4);
    const partial = buildSchemaReport({ key: "raw/part.csv", bytes: cutInsideQuoted, objectBytes: bytes.length, truncatedByBound: true });
    expect(partial.sample.rowsInspected).toBe(0);
    expect(partial.headers[0]).toBe("Company Name");
    expect(JSON.stringify(partial)).not.toContain("line on");
  });

  test("a fully read sample keeps its final row even without a trailing newline", () => {
    const text = "organization,Email\nAcme,ada@acme.example\nBeta,alan@beta.example";
    const report = buildSchemaReport({ key: "raw/part.csv", bytes: utf8Bytes(text), objectBytes: text.length, truncatedByBound: false });
    expect(report.sample.rowsInspected).toBe(2);
    expect(report.sample.truncated).toBe(false);
  });

  test("a sample with no complete record is a problem, not an empty report", () => {
    const report = buildSchemaReport({ key: "raw/part.csv", bytes: utf8Bytes("organization,Email"), objectBytes: 100, truncatedByBound: true });
    // The header line has no newline, so nothing complete could be read.
    expect(report.problems.join(" ")).toContain("no complete record");
  });
});

describe("mapping suggestions are pure and deterministic", () => {
  test("suggestMappings is stable for the same input", () => {
    const columns = [
      { index: 0, header: "Company", normalized: "company", nonEmptyCount: 10, emptyCount: 0, fillRate: 1, approximateUnique: 10, maxLength: 20, looksLike: "text" },
      { index: 1, header: "", normalized: "", nonEmptyCount: 0, emptyCount: 10, fillRate: 0, approximateUnique: 0, maxLength: 0, looksLike: "empty" },
    ];
    const first = suggestMappings(columns);
    const second = suggestMappings(columns);
    expect(first).toEqual(second);
    expect(first[0].proposedField).toBe("companyname");
    expect(first[1].proposedField).toBeNull();
    expect(first[1].evidence).toContain("no values in the sample");
  });
});
