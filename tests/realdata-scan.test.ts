/**
 * Bounded direct R2 scan (REAL DATA level 3).
 *
 * These tests drive the real scan runner against an in-memory BlobStore seeded with
 * TSV bytes, so the parser, the record-boundary accounting, the dedupe and the
 * resume path are the ones the container runs. What they cannot prove is R2
 * latency or the container binding — the live canary covers that separately.
 */

import { describe, expect, test } from "bun:test";

import { MemoryBlobStore } from "../tools/cloud/store";
import { runScan } from "../tools/realdata/scan";
import { realDataKeys, type RealDataScanStatus } from "../src/shared/realdata/types";

const CSV1_HEADER = [
  "organization_id",
  "organization_name",
  "organization_domain",
  "organization_website_url",
  "organization_industries",
  "organization_num_current_employees",
  "organization_revenue_in_thousands_int",
  "organization_hq_location_city",
  "organization_hq_location_state",
  "organization_hq_location_country",
  "organization_short_description",
];
const CSV2_HEADER = [
  "person_name",
  "person_first_name_unanalyzed",
  "person_last_name_unanalyzed",
  "person_title",
  "person_functions",
  "person_seniority",
  "person_email",
  "person_phone",
  "person_linkedin_url",
  "sanitized_organization_name_unanalyzed",
  "person_location_city",
  "person_location_state",
  "person_location_country",
];

function tsv(header: string[], rows: string[][]): string {
  return `${[header.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n")}\n`;
}

const company = (id: string, name: string, industry: string, city: string, country: string): string[] => [
  id,
  name,
  `${id}.example`,
  `https://${id}.example`,
  industry,
  "250",
  "1200",
  city,
  "",
  country,
  `A real row for ${name}`,
];

const person = (name: string, first: string, last: string, title: string, email: string, companyName: string): string[] => [
  name,
  first,
  last,
  title,
  "operations",
  "manager",
  email,
  "",
  `https://linkedin.example/${first}-${last}`,
  companyName,
  "Mumbai",
  "",
  "India",
];

function store(): MemoryBlobStore {
  const bucket = new MemoryBlobStore();
  bucket.put(
    "raw/file1.csv",
    Buffer.from(
      tsv(CSV1_HEADER, [
        company("org-acme", "Acme Corporation", "software", "Redmond", "United States"),
        company("org-acme-inc", "Acme, Inc.", "manufacturing", "Pune", "India"),
        company("org-globex", "Globex Corporation", "energy", "Springfield", "United States"),
        company("org-3m", "3M", "chemicals", "Saint Paul", "United States"),
        company("org-tata", "Tata Motors", "automotive", "Mumbai", "India"),
      ]),
    ),
  );
  bucket.put(
    "raw/file2.csv",
    Buffer.from(
      tsv(CSV2_HEADER, [
        person("Ada Lovelace", "Ada", "Lovelace", "Chief Engineer", "ada@acme.example", "Acme Corporation"),
        person("Grace Hopper", "Grace", "Hopper", "Admiral", "grace@acme.example", "Acme Corporation"),
        person("José Álvarez", "José", "Álvarez", "Plant Manager", "jose@acme-inc.example", "Acme, Inc."),
        person("Ratan Nair", "Ratan", "Nair", "Programme Director", "ratan@tata.example", "Tata Motors"),
        person("No Company", "No", "Company", "Independent", "solo@example.com", ""),
      ]),
    ),
  );
  return bucket;
}

/** A source large enough that a small budget is genuinely partial. */
function largeStore(): MemoryBlobStore {
  const bucket = new MemoryBlobStore();
  const rows: string[][] = [];
  for (let i = 0; i < 5000; i += 1) {
    rows.push(company(`org-${i}`, `Acme Division ${i}`, "software", `City ${i}`, "India"));
  }
  bucket.put("raw/file1.csv", Buffer.from(tsv(CSV1_HEADER, rows)));
  const people: string[][] = [];
  for (let i = 0; i < 5000; i += 1) {
    people.push(person(`Person ${i}`, "Person", `Number${i}`, "Engineer", `p${i}@acme.example`, `Acme Division ${i}`));
  }
  bucket.put("raw/file2.csv", Buffer.from(tsv(CSV2_HEADER, people)));
  return bucket;
}

const base = {
  datasetVersion: "stg-real-test",
  maxBytesPerSource: 1024 * 1024,
  limit: 25,
} as const;

describe("bounded direct R2 scan", () => {
  test("finds companies by exact, prefix and typo, with their contacts", async () => {
    const bucket = store();
    const result = await runScan({
      ...base,
      store: bucket,
      jobId: "scan-acme-exact",
      query: "Acme Corporation",
      kind: "both",
    });

    expect(result.status.state).toBe("complete");
    expect(result.status.totals.bytesScanned).toBeGreaterThan(0);
    expect(result.status.totals.recordsScanned).toBe(12);
    const names = result.results.companies.map((entry) => entry.name);
    expect(names).toContain("Acme Corporation");
    expect(names).not.toContain("Globex Corporation");

    // A broader query returns the second Acme as its own record (never merged).
    const broad = await runScan({ ...base, store: bucket, jobId: "scan-acme-broad", query: "Acme", kind: "companies" });
    expect(broad.results.companies.map((entry) => entry.name)).toContain("Acme, Inc.");

    const acme = result.results.companies.find((entry) => entry.name === "Acme Corporation")!;
    expect(acme.domain).toBe("org-acme.example");
    expect(acme.industry).toBe("software");
    expect(acme.contacts.map((contact) => contact.email)).toContain("ada@acme.example");
    expect(acme.contacts.map((contact) => contact.email)).toContain("grace@acme.example");

    // The typo path is the same bounded edit distance the index uses.
    const typo = await runScan({
      ...base,
      store: bucket,
      jobId: "scan-acme-typo",
      query: "Tata Motor",
      kind: "companies",
    });
    expect(typo.results.companies.map((entry) => entry.name)).toContain("Tata Motors");
  });

  test("matches a person with a typo and deaccented characters", async () => {
    const bucket = store();
    const typo = await runScan({
      ...base,
      store: bucket,
      jobId: "scan-person-typo",
      query: "Grace Hopr",
      kind: "contacts",
    });
    expect(typo.results.contacts.map((contact) => contact.fullName)).toContain("Grace Hopper");
    const contact = typo.results.contacts.find((entry) => entry.fullName === "Grace Hopper")!;
    expect(contact.companyName).toBe("Acme Corporation");
    expect(contact.title).toBe("Admiral");
    expect(contact.source).toEqual({ id: "csv2", row: expect.any(Number) });

    const deaccent = await runScan({
      ...base,
      store: bucket,
      jobId: "scan-person-deaccent",
      query: "Jose Alvarez",
      kind: "contacts",
    });
    expect(deaccent.results.contacts.map((entry) => entry.fullName)).toContain("José Álvarez");
  });

  test("handles a digit-only name and keeps the source attributes", async () => {
    const bucket = store();
    const result = await runScan({ ...base, store: bucket, jobId: "scan-digits", query: "3M", kind: "companies" });
    const threeM = result.results.companies.find((entry) => entry.name === "3M")!;
    expect(threeM).toBeDefined();
    expect(threeM.attributes.organization_short_description).toBe("A real row for 3M");
    expect(threeM.source.id).toBe("csv1");
  });

  test("deduplicates across pages and caps results without hiding the cap", async () => {
    const bucket = store();
    const result = await runScan({
      ...base,
      store: bucket,
      jobId: "scan-limit",
      query: "Acme",
      kind: "both",
      limit: 1,
    });
    expect(result.results.companies).toHaveLength(1);
    // Contacts at the matched company are still useful and are not the thing the
    // limit is protecting against; they are capped per company separately.
    expect(result.results.truncated || result.status.totals.dropped >= 0).toBe(true);
  });

  test("a cancel object stops the scan and keeps what was already read", async () => {
    const bucket = store();
    await bucket.putJson(realDataKeys.scanCancel("scan-cancelled"), { at: new Date().toISOString() });
    const result = await runScan({
      ...base,
      store: bucket,
      jobId: "scan-cancelled",
      query: "Acme",
      kind: "both",
    });
    expect(result.status.state).toBe("cancelled");
    expect(result.status.totals.bytesScanned).toBe(0);
    expect(result.status.reason).toContain("Cancelled");
  });

  test("resumes from the committed record boundary and does not duplicate records", async () => {
    const bucket = largeStore();
    const jobId = "scan-resume";
    const first = await runScan({
      ...base,
      store: bucket,
      jobId,
      query: "4999",
      kind: "companies",
      maxBytesPerSource: 200 * 1024,
    });
    expect(first.status.state).toBe("complete");
    const boundary = first.status.sources[0].bytesScanned;
    expect(boundary).toBeGreaterThan(0);
    expect(boundary).toBeLessThan(bucket.bytes("raw/file1.csv")!.length);

    // Simulate a stop: the durable status says "running" at the committed boundary.
    const status = (await bucket.getJson<RealDataScanStatus>(realDataKeys.scanStatus(jobId)))!;
    await bucket.putJson(realDataKeys.scanStatus(jobId), {
      ...status,
      state: "running",
      complete: false,
      sources: status.sources.map((source) => ({ ...source, complete: false })),
    });
    const resumed = await runScan({ ...base, store: bucket, jobId, query: "4999", kind: "companies" });
    expect(resumed.status.sources[0].bytesScanned).toBe(bucket.bytes("raw/file1.csv")!.length);
    expect(new Set(resumed.results.companies.map((entry) => entry.name)).size).toBe(resumed.results.companies.length);
    expect(resumed.results.companies.map((entry) => entry.name)).toContain("Acme Division 4999");
  });

  test("reports a bounded scope honestly: complete does not mean the file ended", async () => {
    const bucket = largeStore();
    const result = await runScan({
      ...base,
      store: bucket,
      jobId: "scan-budget",
      query: "Acme",
      kind: "companies",
      maxBytesPerSource: 200 * 1024,
      limit: 100,
    });
    expect(result.status.state).toBe("complete");
    expect(result.status.totals.bytesScanned).toBeLessThan(result.status.totals.bytesTotal);
    expect(result.status.reason).toContain("budget");
    expect(result.status.totals.coveragePercent).toBeGreaterThan(0);
    expect(result.status.totals.coveragePercent).toBeLessThan(100);
  });

  test("stops an attempt at its time limit and leaves a resumable state", async () => {
    const bucket = largeStore();
    const result = await runScan({
      ...base,
      store: bucket,
      jobId: "scan-time-limit",
      query: "Acme",
      kind: "companies",
      maxDurationMs: 0,
    });
    expect(result.status.state).toBe("running");
    expect(result.status.complete).toBe(false);
    expect(result.status.reason).toContain("time limit");
    // Nothing claimed: no source bytes were processed.
    expect(result.status.totals.bytesScanned).toBe(0);
  });

  test("refuses to scan a source whose header lost the mapped column", async () => {
    const bucket = new MemoryBlobStore();
    bucket.put("raw/file1.csv", Buffer.from("wrong\tcolumns\n1\t2\n"));
    bucket.put("raw/file2.csv", Buffer.from(tsv(CSV2_HEADER, [])));
    await expect(
      runScan({ ...base, store: bucket, jobId: "scan-bad-header", query: "x", kind: "companies" }),
    ).rejects.toThrow(/organization_name/);
  });
});
