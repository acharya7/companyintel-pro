/**
 * Captured source columns — the "every source field is accessible" guarantee.
 *
 * The canonical mapping is deliberately small: it holds the fields the application
 * searches, filters and ranks on. Everything else a row carries is captured
 * verbatim onto the record, which is what lets a detail view show 51 company or 39
 * contact columns instead of the dozen that happen to be canonical. These tests pin
 * the behaviour that makes that safe:
 *
 *   - only UNMAPPED columns are captured (a mapped column is not duplicated),
 *   - empty cells are omitted rather than stored as empty strings,
 *   - a value's length is bounded, and a truncated value says so,
 *   - the number of captured columns is bounded,
 *   - the values survive extraction, identity resolution and record building.
 */

import { describe, expect, test } from "bun:test";

import {
  MAX_CAPTURED_FIELDS,
  MAX_CAPTURED_VALUE_LENGTH,
  buildColumnMap,
  buildCompany,
  buildContact,
  captureAttributes,
  capturedColumns,
  extractCompanyInput,
  extractContactInput,
} from "../tools/indexer/src/mapping";

/**
 * Realistic headers: the first three are mapped by the shared alias table, the rest
 * are not (a real source file carries dozens of those).
 */
const HEADERS = [
  "organization",
  "domain",
  "industry",
  "organization_industries",
  "revenue",
  "organization_founded_year",
  "organization_description",
  "full name",
];

describe("captured columns", () => {
  const map = buildColumnMap(HEADERS);

  test("only columns the canonical model did not consume are captured", () => {
    const captured = capturedColumns(HEADERS, map);
    const labels = captured.map((column) => column.label);
    // The mapped ones are absent…
    expect(labels).not.toContain("organization");
    expect(labels).not.toContain("domain");
    expect(labels).not.toContain("industry");
    // …and the rest are present, under the file's own header text (tidied for
    // display: underscores become spaces, nothing is renamed).
    expect(labels).toContain("organization founded year");
    expect(labels).toContain("organization description");
    // No position is captured twice, and every captured position is a real column.
    expect(new Set(captured.map((column) => column.index)).size).toBe(captured.length);
    expect(captured.every((column) => column.index >= 0 && column.index < HEADERS.length)).toBe(true);
  });

  test("empty cells are omitted, and a long value is bounded with a visible marker", () => {
    const captured = capturedColumns(HEADERS, map);
    const attributes = captureAttributes(
      [
        "Example Ltd",
        "example.com",
        "Software",
        "['software']",
        "125000",
        "",
        "x".repeat(MAX_CAPTURED_VALUE_LENGTH + 250),
      ],
      captured,
    );
    expect(attributes).toBeDefined();
    // The empty "founded year" cell is not stored at all…
    expect(Object.keys(attributes!).some((key) => key.includes("founded"))).toBe(false);
    // …and the oversized one is cut, with the ellipsis showing it was cut.
    const description = Object.entries(attributes!).find(([key]) => key.includes("description"))?.[1] ?? "";
    expect(description.length).toBe(MAX_CAPTURED_VALUE_LENGTH + 1);
    expect(description.endsWith("…")).toBe(true);
  });

  test("the number of captured columns is bounded", () => {
    const headers = Array.from({ length: MAX_CAPTURED_FIELDS + 40 }, (_, index) => `extra_column_${index}`);
    const captured = capturedColumns(headers, {});
    expect(captured.length).toBe(MAX_CAPTURED_FIELDS);
  });

  test("every captured value appears on the built record, and on the contact too", () => {
    const record = [
      "Example Ltd",
      "example.com",
      "Software",
      "['software']",
      "125000",
      "1998",
      "A description of the company.",
      "Jane Doe",
    ];
    const captured = capturedColumns(HEADERS, map);
    const companyInput = extractCompanyInput(record, map, captured);
    expect(companyInput).not.toBeNull();
    const company = buildCompany({
      ref: 0,
      input: companyInput!,
      key: { key: "d:example.com", strong: true, normalizedName: "example" },
      sources: [{ source: "csv1", row: 2 }],
      ambiguous: false,
    });
    expect(company.attributes?.["organization founded year"]).toBe("1998");
    expect(company.attributes?.["organization description"]).toBe("A description of the company.");

    const contactInput = extractContactInput(record, map, captured);
    expect(contactInput).not.toBeNull();
    const contact = buildContact({
      input: contactInput!,
      company,
      source: { source: "csv1", row: 2 },
      rowFingerprint: "csv1:2",
    });
    expect(contact.attributes?.["organization description"]).toBe("A description of the company.");
  });

  test("a row with no unmapped columns carries no attributes at all", () => {
    const headers = ["organization", "domain"];
    const map2 = buildColumnMap(headers);
    const input = extractCompanyInput(["Example Ltd", "example.com"], map2, capturedColumns(headers, map2));
    expect(input).not.toBeNull();
    expect(input!.attributes).toBeUndefined();
  });
});
