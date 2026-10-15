/**
 * `bun run verify:r2:remote` — transport, exit status and formatting.
 *
 * A real probe needs an authenticated Wrangler session and a real bucket, so
 * these tests run the *runner* against a stub HTTP server on 127.0.0.1 serving
 * the exact JSON shape the probe returns. What that proves:
 *
 *   - the runner's request, its `--json` contract and its exit codes (0 verified,
 *     1 problems reported, 2 probe unavailable);
 *   - the human report renders sizes, sources, dataset state and schema tables;
 *   - nothing here claims anything about the real bucket — it stays unverified
 *     until the command is run on your own machine with your own login.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { exitCodeFor, renderProbeReport } from "../scripts/lib/probe-report.mjs";

const root = join(import.meta.dir, "..");
const bunBin = process.versions.bun ? process.execPath : "bun";

/** Canned probe payload; `problem` removes one source object. */
export function probePayload(problem = false): Record<string, unknown> {
  return {
    service: "companyintel-r2-probe",
    generatedAt: "2026-10-15T10:00:00.000Z",
    readOnly: true,
    bounds: { prefix: "raw/", maxObjects: 25, maxPages: 2, readBytes: 1024, sampleBytes: 6291456, maxRows: 500, keys: [] },
    verification: {
      bucket: "company-intel-data",
      checkedAt: "2026-10-15T10:00:00.000Z",
      access: "ok",
      readOnly: true,
      listing: {
        prefix: "raw/",
        pagesRead: 1,
        pageLimit: 25,
        objectsRead: 3,
        truncated: false,
        reportingTruncated: false,
        listed: [
          { key: "raw/companies_part2.csv", size: 50_000_000_000, lastModified: "2026-09-12T10:00:00.000Z", etag: '"e1"' },
          { key: "raw/companies_part1.csv", size: 10_000_000_000, lastModified: "2026-09-12T09:00:00.000Z", etag: '"e2"' },
          { key: "raw/notes.txt", size: 512, lastModified: "2026-09-10T08:00:00.000Z", etag: '"e3"' },
        ],
        csvObjects: ["raw/companies_part2.csv", "raw/companies_part1.csv"],
        otherObjects: ["raw/notes.txt"],
      },
      selection: {
        mode: "two-largest-csv",
        ambiguous: false,
        csvCandidates: ["raw/companies_part2.csv", "raw/companies_part1.csv"],
        chosen: ["raw/companies_part2.csv", "raw/companies_part1.csv"],
      },
      sources: [
        {
          key: "raw/companies_part2.csv",
          present: true,
          sizeBytes: 50_000_000_000,
          etag: '"e1"',
          lastModified: "2026-09-12T10:00:00.000Z",
          contentType: "text/csv",
          readBytes: 1024,
          readable: true,
          error: null,
        },
        {
          key: "raw/companies_part1.csv",
          present: !problem,
          sizeBytes: problem ? null : 10_000_000_000,
          etag: problem ? null : '"e2"',
          lastModified: problem ? null : "2026-09-12T09:00:00.000Z",
          contentType: problem ? null : "text/csv",
          readBytes: problem ? null : 1024,
          readable: !problem,
          error: null,
        },
      ],
      dataset: {
        activeVersion: null,
        previousVersion: null,
        publishedAt: null,
        manifestPresent: false,
        validationPassed: false,
        counters: { uniqueCompanies: null, uniqueContacts: null, rowsRejected: null, perSource: null },
        indexShards: null,
        indexBytes: null,
        note: "No dataset version is published yet.",
      },
      problems: problem ? ["expected object is not present in the raw/ listing: raw/companies_part1.csv"] : [],
      notices: [],
    },
    schemas: [
      {
        key: "raw/companies_part2.csv",
        report: {
          key: "raw/companies_part2.csv",
          objectBytes: 50_000_000_000,
          sample: { requestedBytes: 6_291_456, bytesRead: 6_291_456, truncated: true, completeRecords: true, rowsInspected: 500 },
          encoding: { encoding: "utf-8", label: "UTF-8 (no BOM)", confidence: "high", notes: [] },
          delimiter: { delimiter: ",", confidence: "high", evidence: '"," gives 12 columns in 20/20 sampled records' },
          headerLine: 1,
          headers: ["organization", "domain", "Email"],
          columns: [
            { index: 0, header: "organization", normalized: "organization", nonEmptyCount: 500, emptyCount: 0, fillRate: 1, approximateUnique: 480, maxLength: 42, looksLike: "text" },
            { index: 2, header: "Email", normalized: "email", nonEmptyCount: 380, emptyCount: 120, fillRate: 0.76, approximateUnique: 380, maxLength: 38, looksLike: "email" },
          ],
          mapping: [
            { column: "organization", index: 0, proposedField: "companyname", confidence: "high", evidence: 'header "organization" matches an alias of companyname', alternatives: [], ambiguous: false },
            { column: "Email", index: 2, proposedField: "email", confidence: "high", evidence: 'header "Email" matches an alias of email', alternatives: [], ambiguous: false },
          ],
          unmappedColumns: [],
          canonicalFieldsAbsent: ["companylinkedin"],
          redaction: "No cell values, contact names, email addresses or phone numbers are included in this report.",
          notes: [],
          problems: [],
        },
        columnsOverride: { companyname: "organization", email: "Email" },
      },
    ],
  };
}

let healthy: Server;
let failing: Server;
let healthyUrl = "";
let failingUrl = "";

beforeAll(async () => {
  const make = async (problem: boolean): Promise<{ server: Server; url: string }> => {
    const payload = probePayload(problem);
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/health")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return { server, url: `http://127.0.0.1:${port}` };
  };

  // Two independent probes: one with both sources, one missing a source object.
  const a = await make(false);
  const b = await make(true);
  healthy = a.server;
  failing = b.server;
  healthyUrl = a.url;
  failingUrl = b.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => healthy.close(() => resolve()));
  await new Promise<void>((resolve) => failing.close(() => resolve()));
});

/**
 * Run the runner as a real child process.
 *
 * Asynchronous on purpose: the stub probe lives in this process, so blocking the
 * event loop with a synchronous spawn would deadlock the very requests the child
 * is making.
 */
function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(bunBin, ["scripts/verify-r2-remote.mjs", ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolveRun({ status: code, stdout, stderr }));
  });
}

describe("verify:r2:remote exit status", () => {
  test("a clean report exits 0 and is valid JSON in --json mode", async () => {
    const result = await run(["--url", healthyUrl, "--json"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.readOnly).toBe(true);
    expect(payload.verification.bucket).toBe("company-intel-data");
    expect(payload.verification.sources.map((source: { key: string }) => source.key)).toEqual([
      "raw/companies_part2.csv",
      "raw/companies_part1.csv",
    ]);
  });

  test("a missing source object exits 1 rather than reporting success", async () => {
    const result = await run(["--url", failingUrl]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("MISSING");
    expect(result.stdout).toContain("problem(s)");
    // Problems are never reported as a pass.
    expect(result.stdout).not.toContain("VERIFIED:");
  });

  test("an unavailable probe exits 2 with guidance and no partial success", async () => {
    const result = await run(["--url", "http://127.0.0.1:1", "--timeout", "2"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("did not become ready");
  });
});

describe("human report", () => {
  test("renders sizes, sources, dataset state and the schema table", async () => {
    const result = await run(["--url", healthyUrl]);
    expect(result.status).toBe(0);
    for (const expected of [
      "CompanyIntel R2 probe",
      "raw/companies_part2.csv",
      "50.00 GB",
      "10.00 GB",
      "native COMPANY_DATA binding",
      "Published dataset",
      "No dataset version is published yet",
      "Schema — raw/companies_part2.csv",
      "mapping suggestions:",
      "companyname",
      "VERIFIED",
      "No contact records, email addresses, phone numbers or cell values are included",
    ]) {
      expect(result.stdout).toContain(expected);
    }
  });

  test("the renderer never invents values: it prints only report fields", () => {
    const payload = probePayload(false);
    const text = renderProbeReport(payload as never);
    expect(text).toContain("distinct~380");
    expect(text).not.toContain("@");
    expect(exitCodeFor(payload)).toBe(0);
    expect(exitCodeFor({ verification: { ...payload.verification, access: "denied" } })).toBe(1);
    expect(exitCodeFor({})).toBe(1);
  });
});

describe("the runner is local and read-only", () => {
  const source = require("node:fs").readFileSync(join(root, "scripts/verify-r2-remote.mjs"), "utf8") as string;

  test("it never deploys and never disables remote bindings", () => {
    // No `wrangler deploy` (or any "deploy" argument) exists in the runner, and
    // `--local` is never passed, because that flag would swap the real bucket for
    // a local simulation and "verify" an empty fake.
    expect(source).not.toMatch(/["']deploy["']/);
    expect(source).not.toContain('"--local"');
  });

  test("it starts wrangler on loopback with the probe config only", () => {
    expect(source).toContain("127.0.0.1");
    expect(source).toContain("probe/wrangler.toml");
  });
});
