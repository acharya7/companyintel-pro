/**
 * Tests for the read-only R2 verification helpers (`scripts/lib/raw-report.mjs`).
 *
 * These are the pure functions the Phase A scripts use to shape a real `raw/`
 * listing and to trim a sampled byte range back to a complete CSV record. They are
 * tested here against synthetic input — no bucket, no credentials, and no claim
 * that anything in R2 was read.
 */

import { describe, expect, test } from "bun:test";

import {
  compareExpected,
  formatBytes,
  isCsvKey,
  planRawListing,
  quoteCount,
  sortBySizeDesc,
  truncateAtRecordBoundary,
} from "../scripts/lib/raw-report.mjs";

const TEN_GB = 10_000_000_000;
const FIFTY_GB = 50_000_000_000;

describe("raw/ listing bounds", () => {
  test("only .csv objects are treated as source candidates", () => {
    expect(isCsvKey("raw/companies_part1.csv")).toBe(true);
    expect(isCsvKey("RAW/Companies_Part2.CSV")).toBe(true);
    expect(isCsvKey("raw/notes.json")).toBe(false);
    expect(isCsvKey("raw/companies_part1.csv.gz")).toBe(false);
    expect(isCsvKey(null)).toBe(false);
  });

  test("unknown sizes sort last and are never treated as zero", () => {
    const sorted = sortBySizeDesc([
      { key: "raw/small.csv", size: 10 },
      { key: "raw/unknown.csv", size: null },
      { key: "raw/big.csv", size: 1000 },
    ]);
    expect(sorted.map((object) => object.key)).toEqual(["raw/big.csv", "raw/small.csv", "raw/unknown.csv"]);
    expect(formatBytes(null)).toBe("unknown");
    expect(formatBytes(0)).toBe("0 B");
  });

  test("the 25-object bound still contains both source files", () => {
    const listing = [
      { key: "raw/companies_part2.csv", size: FIFTY_GB },
      { key: "raw/companies_part1.csv", size: TEN_GB },
      ...Array.from({ length: 40 }, (_, index) => ({ key: `raw/incremental_${index}.csv`, size: 1000 + index })),
    ];
    const plan = planRawListing(listing, 25);
    expect(plan.listed).toHaveLength(25);
    // What the one bounded call returned — not a bucket total.
    expect(plan.objectsRead).toBe(42);
    expect(plan.truncated).toBe(true);
    expect(plan.csvs[0].key).toBe("raw/companies_part2.csv");
    expect(plan.csvs[1].key).toBe("raw/companies_part1.csv");
  });

  test("non-CSV objects are listed separately, not silently dropped", () => {
    const plan = planRawListing(
      [
        { key: "raw/companies_part1.csv", size: 10 },
        { key: "raw/README.txt", size: 5 },
      ],
      25,
    );
    expect(plan.csvs.map((object) => object.key)).toEqual(["raw/companies_part1.csv"]);
    expect(plan.others.map((object) => object.key)).toEqual(["raw/README.txt"]);
    expect(plan.truncated).toBe(false);
  });

  test("a missing expected key is reported missing, never invented", () => {
    const comparison = compareExpected(
      ["raw/companies_part1.csv", "raw/companies_part2.csv"],
      [{ key: "raw/companies_part1.csv", size: 10 }],
    );
    expect(comparison[0]).toMatchObject({ key: "raw/companies_part1.csv", present: true });
    expect(comparison[1].present).toBe(false);
    expect(comparison[1].object).toBeNull();
  });
});

describe("truncating a sampled byte range", () => {
  test("drops a partial trailing line", () => {
    const trimmed = truncateAtRecordBoundary('a,b\n1,2\n3,4\n5,part');
    expect(trimmed).toBe("a,b\n1,2\n3,4\n");
  });

  test("keeps a clean sample that ends exactly on a record boundary", () => {
    const text = "a,b\n1,2\n3,4\n";
    expect(truncateAtRecordBoundary(text)).toBe(text);
  });

  test("drops a record that ends inside a multiline quoted field", () => {
    // The range ends in the middle of a quoted title that spans two lines, so the
    // quotes in the last record are unbalanced and it must not be parsed.
    const text = 'company,name\nAcme,"Head of\nData"\nGlobex,"Head of Data"\nInitech,"He';
    const trimmed = truncateAtRecordBoundary(text);
    expect(trimmed).toBe('company,name\nAcme,"Head of\nData"\nGlobex,"Head of Data"\n');
    expect(quoteCount(trimmed) % 2).toBe(0);
    // The incomplete Initech record is gone entirely.
    expect(trimmed).not.toContain("Initech");
  });

  test("keeps records containing escaped quotes", () => {
    const text = 'name,title\nAcme,"Head of ""Data"", EMEA"\nGlobex,"VP"\nInitech,"Par';
    expect(truncateAtRecordBoundary(text)).toBe('name,title\nAcme,"Head of ""Data"", EMEA"\nGlobex,"VP"\n');
  });

  test("returns nothing when the sample holds no complete record", () => {
    expect(truncateAtRecordBoundary("a,b,1,2,3")).toBe("");
    expect(truncateAtRecordBoundary("")).toBe("");
  });

  test("CRLF samples are trimmed the same way", () => {
    const trimmed = truncateAtRecordBoundary("a,b\r\n1,2\r\n3,par");
    expect(trimmed).toBe("a,b\r\n1,2\r\n");
  });
});
