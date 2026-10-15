/**
 * End-to-end test of `scripts/profile-raw.mjs` (the Phase A schema profiler).
 *
 * Runs the real script as a child process over the stub S3 transport and checks the
 * properties that matter for a 60 GB dataset: exactly one bounded LIST, a ranged GET
 * bounded by `--bytes` (never the whole object), CSV objects only, and a `--json`
 * report that is pure JSON containing no sampled cell values.
 *
 * The stub's body is filler bytes, so the profiler legitimately reports zero
 * sampled records here — nothing about the real schemas is claimed.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const preload = join(root, "tests/helpers/fake-s3-transport.mjs");
const script = join(root, "scripts/profile-raw.mjs");
const FAKE = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "stub-access-key-id-do-not-use",
  R2_SECRET_ACCESS_KEY: "stub-secret-access-key-do-not-use",
};

interface RequestRecord {
  method: string;
  path: string;
  query: Record<string, string>;
  range: string | null;
}

function run(args: string[], scenario = "small") {
  const logPath = join(root, `.fake-s3-profile-${scenario}.json`);
  // Sampled bytes go to a temp directory: the workspace must never collect files
  // that look like real contact records, even from a stub run.
  const outDir = join(tmpdir(), `companyintel-raw-samples-${process.pid}-${scenario}`);
  rmSync(logPath, { force: true });
  rmSync(outDir, { recursive: true, force: true });
  const result = spawnSync(process.execPath, ["--preload", preload, script, "--out", outDir, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...FAKE, FAKE_S3_SCENARIO: scenario, FAKE_S3_LOG: logPath },
  });
  let requests: RequestRecord[] = [];
  try {
    requests = JSON.parse(readFileSync(logPath, "utf8"));
  } catch {
    requests = [];
  }
  rmSync(logPath, { force: true });
  rmSync(outDir, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", requests };
}

describe("profile-raw.mjs against a stubbed raw/ prefix", () => {
  test("--json prints parseable JSON only, profiling the CSVs and no other object", () => {
    const { status, stdout, stderr, requests } = run(["--json"]);
    expect(stderr).toBe("");
    expect(status).toBe(0);

    const report = JSON.parse(stdout);
    expect(report.bucket).toBe("company-intel-data");
    expect(report.reports.map((entry: { key: string }) => entry.key)).toEqual([
      "raw/companies_part2.csv",
      "raw/companies_part1.csv",
    ]);
    // The 512-byte notes.txt is listed but never profiled as a source.
    expect(report.objects.map((object: { key: string }) => object.key)).toContain("raw/notes.txt");

    // Read budget: one 6 MB range per source, not the 50 GB / 10 GB objects.
    const ranged = requests.filter((request) => request.range);
    expect(ranged).toHaveLength(2);
    for (const request of ranged) expect(request.range).toBe("bytes=0-5999999");
    expect(Math.max(...requests.map((request: RequestRecord) => request.range ? 6_000_000 : 0))).toBe(6_000_000);

    // One bounded LIST for the listing, and no writes of any kind.
    expect(requests.filter((request) => request.query["list-type"] === "2")).toHaveLength(1);
    expect(requests.every((request) => request.method === "GET" || request.method === "HEAD")).toBe(true);

    // Share-safe: the report carries headers/fill counts, never sampled cell values.
    expect(JSON.stringify(report)).not.toContain("AAAA");
    for (const value of Object.values(FAKE)) expect(stdout).not.toContain(value);
  });

  test("--list prints an inventory and stops before sampling anything", () => {
    const { status, stdout, requests } = run(["--list"]);
    expect(status).toBe(0);
    expect(stdout).toContain("raw/companies_part2.csv");
    expect(stdout).toContain("50.00 GB");
    expect(stdout).toContain("raw/notes.txt");
    expect(requests.every((request) => request.range === null)).toBe(true);
  });

  test("--keys profiles only the named objects", () => {
    const { status, stdout } = run(["--keys", "raw/companies_part1.csv", "--json"]);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.reports).toHaveLength(1);
    expect(report.reports[0].key).toBe("raw/companies_part1.csv");
    // A single named source cannot produce a two-source suggested config.
    expect(report.suggestedSources).toBeNull();
  });
});
