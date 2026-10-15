/**
 * End-to-end test of `scripts/verify-raw.mjs` (the read-only connection test).
 *
 * The script runs as a real child process, with real SigV4 signing and real XML
 * parsing, over a **stub S3 transport** (`tests/helpers/fake-s3-transport.mjs`)
 * that records every request. That proves the script's own behaviour: the 25-object
 * bound, the bounded body read, "missing is reported missing", the exit codes, that
 * it never writes, and that no credential value can appear in its output.
 *
 * It is NOT evidence about the real bucket: nothing here contacts Cloudflare, and
 * `docs/r2-connection.md` keeps real verification marked as pending your run.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { formatBytes } from "../scripts/lib/raw-report.mjs";

const root = join(import.meta.dir, "..");
const preload = join(root, "tests/helpers/fake-s3-transport.mjs");
const script = join(root, "scripts/verify-raw.mjs");

/** Fake credentials: never real, and asserted absent from all output. */
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
  authPresent: boolean;
}

function run(args: string[], scenario = "default") {
  const logPath = join(root, `.fake-s3-log-${scenario}.json`);
  rmSync(logPath, { force: true });
  const result = spawnSync(process.execPath, ["--preload", preload, script, ...args], {
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
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", requests };
}

describe("verify-raw.mjs against a stubbed raw/ prefix", () => {
  test("reports both source files with real sizes, bounded reads, and exit code 0", () => {
    const { status, stdout, stderr, requests } = run(["--json"]);
    expect(stderr).toBe("");
    expect(status).toBe(0);

    const report = JSON.parse(stdout);
    expect(report.bucket).toBe("company-intel-data");
    expect(report.access).toBe("ok");
    expect(report.problems).toEqual([]);

    // Bounded listing: at most 25 objects, largest first, so both sources are inside.
    expect(report.rawPrefix.listed.length).toBeLessThanOrEqual(25);
    expect(report.rawPrefix.truncated).toBe(true);
    // One bounded LIST returns limit+1 objects: enough to say "more exist", not a bucket total.
    expect(report.rawPrefix.objectsRead).toBe(26);
    expect(report.rawPrefix.listed[0]).toMatchObject({ key: "raw/companies_part2.csv", sizeBytes: 50_000_000_000 });
    expect(report.rawPrefix.listed[1]).toMatchObject({ key: "raw/companies_part1.csv", sizeBytes: 10_000_000_000 });
    // The bound is size-ordered, so the 512-byte notes.txt falls outside it — that is
    // exactly why `truncated` is reported instead of pretending the listing is complete.
    expect(report.rawPrefix.otherObjects).toEqual([]);
    expect(report.rawPrefix.listed.map((object: { key: string }) => object.key)).not.toContain("raw/notes.txt");

    // Both sources confirmed present, sized, and readable via a bounded body read.
    expect(report.sources.map((source: { key: string }) => source.key)).toEqual([
      "raw/companies_part2.csv",
      "raw/companies_part1.csv",
    ]);
    for (const source of report.sources) {
      expect(source.present).toBe(true);
      expect(source.readable).toBe(true);
      expect(source.sizeBytes).toBeGreaterThanOrEqual(10_000_000_000);
      expect(source.readBytes).toBe(1024);
    }

    // The published dataset is reported from the real manifest objects.
    expect(report.dataset.activeVersion).toBe("v1");
    expect(report.dataset.validationPassed).toBe(true);
    expect(report.dataset.counters.uniqueCompanies).toBe(1_234_567);
    expect(report.dataset.counters.uniqueContacts).toBe(2_345_678);
    expect(report.dataset.indexBytes).toBe(12_345_678_901);

    // One LIST, plus HEAD + ranged GET per source: a handful of small requests.
    expect(requests.filter((request) => request.query["list-type"] === "2")).toHaveLength(1);
    expect(requests.every((request) => request.method === "GET" || request.method === "HEAD")).toBe(true);
    expect(requests.every((request) => request.authPresent)).toBe(true);
    const ranged = requests.filter((request) => request.range);
    expect(ranged).toHaveLength(2);
    for (const request of ranged) {
      // bytes=0-1023: a kilobyte, never a 10/50 GB download.
      expect(request.range).toBe("bytes=0-1023");
    }
  });

  test("no credential value ever reaches stdout or stderr", () => {
    const { stdout, stderr } = run(["--json"]);
    for (const value of Object.values(FAKE)) {
      expect(stdout).not.toContain(value);
      expect(stderr).not.toContain(value);
    }
  });

  test("a small raw/ prefix is listed completely, non-CSV objects included", () => {
    const { status, stdout } = run(["--json"], "small");
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.rawPrefix.objectsRead).toBe(3);
    expect(report.rawPrefix.truncated).toBe(false);
    expect(report.rawPrefix.listed.map((object: { key: string }) => object.key)).toEqual([
      "raw/companies_part2.csv",
      "raw/companies_part1.csv",
      "raw/notes.txt",
    ]);
    expect(report.rawPrefix.otherObjects).toEqual(["raw/notes.txt"]);
  });

  test("auto-selection is flagged, never presented as fact", () => {
    const report = JSON.parse(run(["--json"]).stdout);
    expect(report.selection.mode).toBe("two-largest-csv");
    expect(report.selection.ambiguous).toBe(true);
    expect(report.selection.chosen).toEqual(["raw/companies_part2.csv", "raw/companies_part1.csv"]);
    expect(report.notices[0]).toContain("Auto-selection chose the two largest");
  });

  test("an explicitly named missing source is reported missing and exits 1", () => {
    const { status, stdout } = run(
      ["--keys", "raw/companies_part1.csv,raw/companies_part2.csv", "--json"],
      "missing-source",
    );
    expect(status).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.selection.mode).toBe("explicit");
    const missing = report.sources.find((source: { key: string }) => source.key === "raw/companies_part1.csv");
    expect(missing.present).toBe(false);
    expect(missing.readable).toBe(false);
    expect(report.problems.some((problem: string) => problem.includes("raw/companies_part1.csv"))).toBe(true);
    // The one present source is still read; nothing is read from the missing key.
    expect(report.sources.find((source: { key: string }) => source.key === "raw/companies_part2.csv").readable).toBe(true);
    // Only the present object is HEADed and ranged: one HEAD + one GET per source max.
    expect(report.sources).toHaveLength(2);
  });

  test("refused credentials exit 1 with a machine-readable and a human message", () => {
    const json = run(["--json"], "denied");
    expect(json.status).toBe(1);
    const report = JSON.parse(json.stdout);
    expect(report.access).toBe("denied");
    expect(report.problems[0]).toContain("403");
    expect(json.stdout).not.toContain(FAKE.R2_ACCESS_KEY_ID);

    const human = run([], "denied");
    expect(human.status).toBe(1);
    expect(human.stderr.toLowerCase()).toContain("cannot read");
  });

  test("human output names the files and their sizes", () => {
    const { status, stdout } = run([]);
    expect(status).toBe(0);
    expect(stdout).toContain("raw/companies_part2.csv");
    expect(stdout).toContain(formatBytes(50_000_000_000));
    expect(stdout).toContain("read 1.02 KB of the body");
    expect(stdout).toContain("active version    v1");
  });
});
