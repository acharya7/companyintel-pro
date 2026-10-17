/**
 * Captured source columns — the "every source field is accessible" guarantee.
 *
 * The canonical mapping is deliberately small: it holds the fields the application
 * searches, filters and ranks on. Every column a row carries is ALSO captured
 * verbatim onto the record, which is what lets a detail view show all 51 company or
 * 39 contact columns instead of the dozen that happen to be canonical.
 *
 * These tests pin the properties the user asked for directly:
 *
 *   - every column is captured, mapped ones included (the canonical field is
 *     normalised, so the raw value would otherwise be lost),
 *   - the original header text is the key, so the mapping is reversible,
 *   - a value is stored in full: there is no character cap and no ellipsis,
 *   - there is no column cap (a 120-column file keeps all 120),
 *   - two columns with the same header cannot overwrite each other,
 *   - a later row for the same company adds its columns instead of losing them,
 *   - empty cells are omitted rather than stored as empty strings.
 */

import { describe, expect, test } from "bun:test";

import {
  buildColumnMap,
  buildCompany,
  buildContact,
  captureAttributes,
  capturedColumns,
  extractCompanyInput,
  extractContactInput,
  mergeAttributes,
} from "../tools/indexer/src/mapping";

/**
 * Realistic headers: the first three are mapped by the shared alias table, the rest
 * are not (a real source file carries dozens of those). `organization_name` is
 * listed twice on purpose — duplicate headers exist in exported data.
 */
const HEADERS = [
  "organization",
  "domain",
  "industry",
  "organization_industries",
  "revenue",
  "organization_founded_year",
  "organization_short_description",
  "full name",
];

describe("captured columns", () => {
  const map = buildColumnMap(HEADERS);

  test("every column is captured, mapped or not, under the file's own header", () => {
    const captured = capturedColumns(HEADERS, map);
    const labels = captured.map((column) => column.label);
    // Mapped columns are captured too: `organization` normalises to a legal-suffix
    // stripped name, so the raw value has to survive somewhere.
    expect(labels).toContain("organization");
    expect(labels).toContain("domain");
    // Unmapped ones keep their exact header text (reversible mapping).
    expect(labels).toContain("organization_founded_year");
    expect(labels).toContain("organization_short_description");
    // No position is captured twice, and every captured position is a real column.
    expect(new Set(captured.map((column) => column.index)).size).toBe(captured.length);
    expect(captured.map((column) => column.index)).toEqual(HEADERS.map((_, index) => index));
  });

  test("a duplicated header cannot overwrite the first value", () => {
    const headers = ["organization", "organization", "revenue"];
    const captured = capturedColumns(headers, buildColumnMap(headers));
    expect(captured.map((column) => column.label)).toEqual(["organization", "organization#2", "revenue"]);
    const attributes = captureAttributes(["Acme Ltd", "Acme Holdings", "1200"], captured);
    expect(attributes).toEqual({ organization: "Acme Ltd", "organization#2": "Acme Holdings", revenue: "1200" });
  });

  test("there is no column cap: a 120-column file keeps all 120", () => {
    const headers = Array.from({ length: 120 }, (_, index) => `extra_column_${index}`);
    const captured = capturedColumns(headers, {});
    expect(captured.length).toBe(120);
    const values = headers.map((_, index) => `v${index}`);
    expect(Object.keys(captureAttributes(values, captured)!).length).toBe(120);
  });

  test("a long value is preserved in full, with no ellipsis and no truncation", () => {
    const description = `${"x".repeat(4000)}— end of the real value ✅`;
    const captured = capturedColumns(HEADERS, map);
    const attributes = captureAttributes(
      ["Example Ltd", "example.com", "Software", "['software']", "125000", "", description],
      captured,
    );
    expect(attributes).toBeDefined();
    // Empty "founded year" is not stored at all…
    expect(Object.keys(attributes!).some((key) => key.includes("founded"))).toBe(false);
    // …and the oversized one is byte-for-byte what the source carried.
    expect(attributes!["organization_short_description"]).toBe(description);
    expect(attributes!["organization_short_description"].endsWith("…")).toBe(false);
  });

  test("mergeAttributes unions both rows and suffixes only real collisions", () => {
    const first = { organization: "Acme Ltd", revenue: "1200" };
    const second = { organization: "Acme Holdings", founded: "1998" };
    expect(mergeAttributes(first, second, "csv2")).toEqual({
      organization: "Acme Ltd",
      revenue: "1200",
      founded: "1998",
      "organization (source csv2)": "Acme Holdings",
    });
    // Identical values are not duplicated.
    expect(mergeAttributes(first, { organization: "Acme Ltd" }, "csv2")).toEqual(first);
    // Either side may be missing.
    expect(mergeAttributes(undefined, second, "csv2")).toEqual(second);
    expect(mergeAttributes(first, undefined, "csv2")).toEqual(first);
  });

  test("every captured value appears on the built record, and on the contact too", () => {
    // Only surrounding whitespace is trimmed; the value itself is untouched.
    const long = "A description of the company. ".repeat(80).trim();
    const record = [
      "Example Ltd",
      "example.com",
      "Software",
      "['software']",
      "125000",
      "1998",
      long,
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
    expect(company.attributes?.["organization_founded_year"]).toBe("1998");
    expect(company.attributes?.["organization_short_description"]).toBe(long);
    expect(company.attributes?.organization).toBe("Example Ltd");

    const contactInput = extractContactInput(record, map, captured);
    expect(contactInput).not.toBeNull();
    const contact = buildContact({
      input: contactInput!,
      company,
      source: { source: "csv1", row: 2 },
      rowFingerprint: "csv1:2",
    });
    expect(contact.attributes?.["organization_short_description"]).toBe(long);
  });

  test("a row with no values carries no attributes at all", () => {
    const headers = ["organization", "domain"];
    const map2 = buildColumnMap(headers);
    const input = extractCompanyInput(["Example Ltd", ""], map2, capturedColumns(headers, map2));
    expect(input).not.toBeNull();
    expect(input!.attributes).toEqual({ organization: "Example Ltd" });
    const empty = extractCompanyInput(["", ""], map2, capturedColumns(headers, map2));
    expect(empty).toBeNull();
  });
});
