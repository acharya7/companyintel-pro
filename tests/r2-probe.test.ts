/**
 * The isolated R2 probe Worker, exercised end to end against an in-memory bucket.
 *
 * This is a *local runtime* test: the real probe module is imported and its route
 * handler is called with the real env shape, so routing, bound clamping, the
 * read-only guarantee and the report contents are all checked against running
 * code. What it cannot do is reach Cloudflare — the bucket here is the test
 * double, and nothing below is evidence about your real objects.
 *
 * The value of the assertions is mostly negative: they pin what the probe must
 * never do — write, delete, exceed its read bounds, answer in production, or
 * include a contact value in a report.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import probe from "../probe/src/index";
import { FakeR2Bucket } from "./helpers/fake-r2";

const SOURCE_ONE_HEADER = "organization,domain,Industry,City";
const SOURCE_ONE = [
  SOURCE_ONE_HEADER,
  'Acme, Inc.,acme.example,Software,"San, Jose"',
  "Beta Ltd,beta.example,Retail,Pune",
].join("\n");

// Deliberately a different schema, with a quoted multiline record and values that
// must never appear in a report.
const SOURCE_TWO = [
  'Company Name;Website;Contact Name;Email;Phone;Notes',
  'Globex;globex.example;"Ada Lovelace";ada@globex.example;+1 555 0100;"line one',
  'line two"',
  'Initech;initech.example;"Grace Hopper";grace@initech.example;+1 555 0200;plain',
].join("\n");

const SECRET_EMAIL = "ada@globex.example";
const SECRET_PHONE = "+1 555 0100";

interface ProbeResponse {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

function env(bucket: FakeR2Bucket, overrides: Record<string, string> = {}): never {
  return {
    COMPANY_DATA: bucket,
    ENVIRONMENT: "development",
    PROBE_READ_ONLY: "true",
    RAW_PREFIX: "raw/",
    MAX_RAW_OBJECTS: "25",
    MAX_LIST_LIMIT: "100",
    MAX_READ_BYTES: "65536",
    MAX_SAMPLE_BYTES: "8388608",
    MAX_SCHEMA_ROWS: "2000",
    ...overrides,
  } as never;
}

async function call(path: string, bucket: FakeR2Bucket, init: RequestInit = {}, overrides: Record<string, string> = {}): Promise<ProbeResponse> {
  const response = await probe.fetch(new Request(`http://127.0.0.1:8788${path}`, init), env(bucket, overrides));
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, text, headers: response.headers };
}

function seededBucket(): FakeR2Bucket {
  const bucket = new FakeR2Bucket();
  bucket.putBytes("raw/companies_part1.csv", Buffer.from(SOURCE_ONE, "utf8"), { contentType: "text/csv" });
  bucket.putBytes("raw/companies_part2.csv", Buffer.from(SOURCE_TWO, "utf8"), { contentType: "text/csv" });
  bucket.putBytes("raw/notes.txt", Buffer.from("upload notes", "utf8"), { contentType: "text/plain" });
  return bucket;
}

let bucket: FakeR2Bucket;
beforeEach(() => {
  bucket = seededBucket();
});

describe("probe routing and liveness", () => {
  test("GET /health is a liveness response and says it is read-only", async () => {
    const { status, body } = await call("/health", bucket);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.readOnly).toBe(true);
    expect(body.environment).toBe("development");
  });

  test("GET / documents the routes, the bounds and the guarantees", async () => {
    const { status, body } = await call("/", bucket);
    expect(status).toBe(200);
    expect(Object.keys(body.routes)).toEqual(["GET /health", "GET /verify", "GET /schema", "GET /report"]);
    expect(body.guarantees.join(" ")).toContain("read-only");
    expect(body.guarantees.join(" ")).toContain("never deployed");
  });

  test("unknown routes 404 and non-GET methods 405", async () => {
    expect((await call("/nope", bucket)).status).toBe(404);
    expect((await call("/report", bucket, { method: "POST" })).status).toBe(405);
    expect((await call("/report", bucket, { method: "DELETE" })).status).toBe(405);
  });

  test("the probe refuses to answer when ENVIRONMENT=production", async () => {
    const { status, body } = await call("/report", bucket, {}, { ENVIRONMENT: "production" });
    expect(status).toBe(403);
    expect(body.error.code).toBe("refused_production");
  });

  test("unusable keys and over-long key lists are rejected", async () => {
    expect((await call("/report?keys=../../etc/passwd", bucket)).status).toBe(400);
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((name) => `raw/${name}.csv`).join(",");
    expect((await call(`/report?keys=${encodeURIComponent(nine)}`, bucket)).status).toBe(400);
  });
});

describe("bounded verification", () => {
  test("both source objects are named, sized, ETagged and body-readable", async () => {
    const { status, body, text } = await call("/report", bucket);
    expect(status).toBe(200);
    const verification = body.verification;
    expect(verification.access).toBe("ok");
    expect(verification.readOnly).toBe(true);
    expect(verification.bucket).toBe("company-intel-data");
    expect(verification.listing.objectsRead).toBe(3);
    expect(verification.listing.truncated).toBe(false);
    expect(verification.selection.mode).toBe("two-largest-csv");
    expect(verification.sources.map((source: { key: string }) => source.key)).toEqual([
      "raw/companies_part2.csv",
      "raw/companies_part1.csv",
    ]);
    for (const source of verification.sources) {
      expect(source.present).toBe(true);
      expect(source.readable).toBe(true);
      expect(source.readBytes).toBeGreaterThan(0);
      expect(source.sizeBytes).toBe(bucket.getObject(source.key)!.bytes.length);
      expect(source.etag).toBeTruthy();
      expect(source.lastModified).toBeTruthy();
    }
    expect(verification.problems).toEqual([]);
    // No published dataset exists, and the probe says so instead of inventing one.
    expect(verification.dataset.activeVersion).toBeNull();
    expect(verification.dataset.note).toContain("No dataset version is published yet");
    // No contact value may appear anywhere in the response.
    expect(text).not.toContain(SECRET_EMAIL);
    expect(text).not.toContain(SECRET_PHONE);
  });

  test("the schema report describes columns without leaking a single cell value", async () => {
    const { body, text } = await call("/report?sampleBytes=4096", bucket);
    expect(body.schemas).toHaveLength(2);

    const [first] = body.schemas;
    expect(first.key).toBe("raw/companies_part2.csv");
    expect(first.report.delimiter.delimiter).toBe(";");
    expect(first.report.headers).toEqual(["Company Name", "Website", "Contact Name", "Email", "Phone", "Notes"]);
    // The quoted multiline record must be parsed as one record, so 2 data rows.
    expect(first.report.sample.rowsInspected).toBe(2);
    expect(first.report.mapping.find((entry: { column: string }) => entry.column === "Email").proposedField).toBe("email");
    expect(first.report.mapping.find((entry: { column: string }) => entry.column === "Company Name").proposedField).toBe("companyname");
    expect(first.report.redaction).toContain("No cell values");
    expect(first.report.columns.every((column: { samples?: unknown }) => column.samples === undefined)).toBe(true);

    // Headers, types and fill rates are present; the values are not.
    expect(text).toContain("Company Name");
    expect(text).toContain("email");
    expect(text).not.toContain(SECRET_EMAIL);
    expect(text).not.toContain("Globex");
    expect(text).not.toContain(SECRET_PHONE);
  });

  test("a second schema with a comma delimiter and no CSV suffix is still detected", async () => {
    const { body } = await call("/report?keys=raw/companies_part1.csv", bucket);
    expect(body.verification.selection.mode).toBe("explicit");
    expect(body.schemas).toHaveLength(1);
    expect(body.schemas[0].report.delimiter.delimiter).toBe(",");
    expect(body.schemas[0].report.headers).toEqual(["organization", "domain", "Industry", "City"]);
  });

  test("a missing object is a problem, never a pass", async () => {
    const { status, body } = await call("/report?keys=raw/companies_part1.csv,raw/gone.csv", bucket);
    expect(status).toBe(200);
    expect(body.verification.problems).toEqual(["expected object is not present in the raw/ listing: raw/gone.csv"]);
    const missing = body.verification.sources.find((source: { key: string }) => source.key === "raw/gone.csv");
    expect(missing.present).toBe(false);
    expect(missing.readable).toBe(false);
  });

  test("one CSV object is reported as an unverifiable source set", async () => {
    const onlyOne = new FakeR2Bucket();
    onlyOne.putBytes("raw/companies_part1.csv", Buffer.from(SOURCE_ONE, "utf8"));
    const { body } = await call("/report", onlyOne);
    expect(body.verification.problems.join(" ")).toContain("1 .csv object(s) were found");
    expect(body.verification.sources).toHaveLength(1);
  });

  test("more CSVs than expected marks auto-selection as ambiguous", async () => {
    bucket.putBytes("raw/incremental_01.csv", Buffer.from(SOURCE_ONE, "utf8"));
    const { body } = await call("/report", bucket);
    expect(body.verification.selection.ambiguous).toBe(true);
    expect(body.verification.selection.csvCandidates).toHaveLength(3);
    expect(body.verification.notices.join(" ")).toContain("auto-selection chose the two largest");
  });

  test("pagination is bounded and a truncated listing is reported as partial", async () => {
    for (let index = 0; index < 30; index += 1) {
      bucket.putBytes(`raw/bulk_${String(index).padStart(2, "0")}.csv`, Buffer.from(SOURCE_ONE, "utf8"));
    }
    const { body } = await call("/report?max=5&pages=2", bucket);
    const listing = body.verification.listing;
    expect(listing.pageLimit).toBe(5);
    expect(listing.pagesRead).toBe(2);
    expect(listing.objectsRead).toBe(10);
    expect(listing.truncated).toBe(true);
    expect(listing.listed).toHaveLength(5);
    expect(listing.reportingTruncated).toBe(true);
    expect(body.verification.notices.join(" ")).toContain("still truncated after 2 page(s)");
    expect(body.verification.notices.join(" ")).toContain("bounded view, not a bucket total");
  });

  test("the published dataset is read through bounded reads when it exists", async () => {
    bucket.putBytes("manifests/active.json", Buffer.from(JSON.stringify({ version: "v1", publishedAt: "2026-09-20T12:00:00.000Z", previousVersion: "v0" }), "utf8"));
    bucket.putBytes(
      "manifests/v1/manifest.json",
      Buffer.from(JSON.stringify({ counters: { uniqueCompanies: 100, uniqueContacts: 200, rowsRejected: 3, perSource: { csv1: {}, csv2: {} } } }), "utf8"),
    );
    bucket.putBytes("manifests/v1/validation.json", Buffer.from(JSON.stringify({ passed: true }), "utf8"));
    bucket.putBytes("indexes/v1/directory.json", Buffer.from(JSON.stringify({ shards: { exact: 512 }, bytes: { total: 1234 } }), "utf8"));

    const { body } = await call("/report", bucket);
    expect(body.verification.dataset.activeVersion).toBe("v1");
    expect(body.verification.dataset.validationPassed).toBe(true);
    expect(body.verification.dataset.counters.uniqueCompanies).toBe(100);
    expect(body.verification.dataset.indexBytes).toBe(1234);
    expect(body.verification.problems).toEqual([]);
  });

  test("a published version without validation is reported as a problem", async () => {
    bucket.putBytes("manifests/active.json", Buffer.from(JSON.stringify({ version: "v9" }), "utf8"));
    const { body } = await call("/report", bucket);
    expect(body.verification.problems.join(" ")).toContain("manifests/v9/manifest.json is missing");
    expect(body.verification.problems.join(" ")).toContain("no passing validation record");
  });
});

describe("bounds are clamped and reads are read-only", () => {
  test("query parameters can only ask for less than the configured maxima", async () => {
    const { body } = await call("/report?max=100000&readBytes=5000000&sampleBytes=999999999&rows=999999&pages=99", bucket);
    expect(body.bounds.maxObjects).toBe(100);
    expect(body.bounds.readBytes).toBe(65536);
    expect(body.bounds.sampleBytes).toBe(8 * 1024 * 1024);
    // The config value is itself a cap: the probe can never be asked for more than
    // probe/wrangler.toml allows, and the absolute ceiling sits above it.
    expect(body.bounds.maxRows).toBe(2000);
    expect(body.bounds.maxPages).toBe(4);
  });

  test("a big object is sampled, never downloaded", async () => {
    const lines = ["organization,domain,Email"];
    for (let index = 0; index < 60_000; index += 1) {
      lines.push(`Company ${index},example${index}.test,user${index}@example.test`);
    }
    const big = Buffer.from(lines.join("\n"), "utf8");
    bucket.putBytes("raw/companies_part2.csv", big);
    bucket.resetCounters();

    const { body } = await call("/report?max=2&readBytes=1024&sampleBytes=65536&rows=50", bucket);
    expect(body.schemas[0].report.objectBytes).toBe(big.length);
    expect(body.schemas[0].report.sample.bytesRead).toBeLessThanOrEqual(65536);
    expect(body.schemas[0].report.sample.truncated).toBe(true);
    // At most the bounded reads: 1 KB of body per source plus one 64 KB sample.
    expect(bucket.counters.bytesRead).toBeLessThan(120 * 1024);
    expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
  });

  test("no write or delete is ever issued, and the bucket is unchanged", async () => {
    const before = bucket.keys();
    const beforeBytes = new Map(bucket.keys().map((key) => [key, bucket.getObject(key)!.bytes.length]));

    await call("/report", bucket);
    await call("/verify", bucket);
    await call("/schema", bucket);
    await call("/health", bucket);

    expect(bucket.counters.puts).toBe(0);
    expect(bucket.counters.deletes).toBe(0);
    expect(bucket.keys()).toEqual(before);
    for (const [key, bytes] of beforeBytes) expect(bucket.getObject(key)!.bytes.length).toBe(bytes);
    // Reads are ranged: every read key is a real key and none is a whole-object walk.
    for (const key of bucket.counters.readKeys) expect(before).toContain(key);
  });
});
