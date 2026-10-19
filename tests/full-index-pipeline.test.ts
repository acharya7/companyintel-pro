/**
 * The one-command full-index pipeline, exercised end to end.
 *
 * `scripts/full-index.mjs` is the step an operator actually runs on the machine that
 * holds the corpus, so its stage order, its coverage labelling and its refusal to
 * activate a partial index are behaviour that has to be tested, not described. The
 * tests below run the REAL script (a child process, like the operator's shell) over
 * two local CSVs, so nothing about R2 is needed and nothing in the bucket is touched.
 *
 * What they pin:
 *   - a complete run exits 0, reports COMPLETE coverage and writes its JSON summary;
 *   - a `--sample` run is labelled PARTIAL and the summary says so;
 *   - `--sample` together with `--activate` is refused before anything is built —
 *     a smoke test must never be able to replace the full dataset;
 *   - stage numbering and the dependency/source-version checks appear in the output.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const sandbox = mkdtempSync(join(tmpdir(), "companyintel-full-index-"));

const CSV1 = `"Company Name","Website","Industry","Country","City","Company Size","Contact Name","Job Title","Email","Phone","Company Description"
"Example Corporation","https://www.example.com","Software","United States","Austin","201-500","Dana Reed","Chief Executive Officer","dana.reed@example.com","+1 512 555 0100","A description long enough to matter, with a comma and “quotes”."
"Second Company Ltd","https://second.example","Retail","United Kingdom","Leeds","51-200","Alex Brook","Head of Buying","alex.brook@second.example","",""
"","https://nocompany.example","Consulting","India","Pune","","Someone Anon","Analyst","anon@nocompany.example","",""
`;

const CSV2 = `organization,domain,full_name,designation,seniority,department,work_email,person_location_country,person_bio
Example Corporation,https://www.example.com,Dana Reed,Chief Executive Officer,Executive,Leadership,dana.reed@example.com,United States,"Bio with, a comma."
Second Company Ltd,https://second.example,Priya Menon,Director of Data,Director,Data,priya.menon@second.example,India,
`;

function writeConfig(name: string, version: string): string {
  const dir = join(sandbox, name);
  mkdirSync(join(dir, "raw"), { recursive: true });
  const csv1 = join(dir, "raw", "company.csv");
  const csv2 = join(dir, "raw", "people.csv");
  writeFileSync(csv1, CSV1, "utf8");
  writeFileSync(csv2, CSV2, "utf8");
  const configPath = join(dir, "indexer.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        datasetVersion: version,
        sources: [
          { id: "csv1", path: csv1, encoding: "utf8", delimiter: "," },
          { id: "csv2", path: csv2, encoding: "utf8", delimiter: "," },
        ],
        workDir: join(dir, "work"),
        outputDir: join(dir, "out"),
        partitions: 4,
        shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
        upload: { enabled: false, bucket: "company-intel-data" },
      },
      null,
      2,
    ),
    "utf8",
  );
  return configPath;
}

function runPipeline(args: string[]) {
  const result = spawnSync("bun", ["scripts/full-index.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("full-index pipeline (operator path, local sources)", () => {
  const version = "t-full";
  const configPath = writeConfig("complete", version);
  const reportDir = join(sandbox, "complete", "reports");

  test("a complete run builds, validates, labels coverage COMPLETE and writes a summary", () => {
    const { status, output } = runPipeline([
      "--config",
      configPath,
      "--version",
      version,
      "--yes",
      "--no-upload",
      // The suite may run on a volume with less than the default 512 MB margin; the
      // floor is passed explicitly so the test asserts pipeline behaviour, not the
      // free space of whoever runs it.
      "--disk-floor",
      "50",
      "--report-dir",
      reportDir,
    ]);
    expect(output).toContain("1/20 dependencies");
    expect(output).toContain("2/20 source version");
    expect(output).toContain("Coverage: COMPLETE");
    expect(output).toContain("--no-upload");
    expect(status).toBe(0);

    const summaryPath = join(reportDir, `full-index-${version}.json`);
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    expect(summary.coverage).toBe("complete");
    expect(summary.activated).toBe(false);
    expect(summary.counters.uniqueCompanies).toBeGreaterThan(0);
    // Nothing in this run may report a sample limit as if it were the full dataset.
    expect(summary.resume.sampleLimit ?? null).toBeNull();
    expect(existsSync(join(sandbox, "complete", "out", "manifests", version, "validation.json"))).toBe(true);
  });

  test("--work-dir builds in the override directory and leaves the config's workDir absent", () => {
    const overrideConfig = writeConfig("override", "t-override");
    const configWork = join(sandbox, "override", "work");
    const overrideWork = join(sandbox, "override", "work-v2");
    const { status, output } = runPipeline([
      "--config",
      overrideConfig,
      "--version",
      "t-override",
      "--work-dir",
      overrideWork,
      "--yes",
      "--no-upload",
      "--disk-floor",
      "50",
      "--report-dir",
      join(sandbox, "override", "reports"),
    ]);
    // The override has to be visible BEFORE Pass 1: this is the flag that points a
    // recovered run at its converted ledger instead of the legacy spool.
    expect(output).toContain("--work-dir override");
    expect(status).toBe(0);
    expect(existsSync(join(overrideWork, "spool-manifest.json"))).toBe(true);
    expect(existsSync(join(configWork, "spool-manifest.json"))).toBe(false);
  });

  test("a --sample run is labelled PARTIAL, and its summary cannot claim completeness", () => {
    const sampleConfig = writeConfig("sample", "t-sample");
    const { status, output } = runPipeline([
      "--config",
      sampleConfig,
      "--version",
      "t-sample",
      "--sample",
      "2",
      "--yes",
      "--no-upload",
      "--disk-floor",
      "50",
      "--report-dir",
      join(sandbox, "sample", "reports"),
    ]);
    expect(output).toContain("SMOKE TEST");
    expect(output).toContain("Coverage: PARTIAL");
    expect(status).toBe(0);
    const summary = JSON.parse(readFileSync(join(sandbox, "sample", "reports", "full-index-t-sample.json"), "utf8"));
    expect(summary.coverage).toContain("sample (2 per source)");
    expect(summary.activated).toBe(false);
  });

  test("--sample with --activate is refused before anything is built", () => {
    const guarded = writeConfig("guarded", "t-guarded");
    const { status, output } = runPipeline([
      "--config",
      guarded,
      "--version",
      "t-guarded",
      "--sample",
      "2",
      "--activate",
      "--yes",
    ]);
    expect(status).toBe(1);
    expect(output).toContain("refusing to activate a partial index");
    expect(existsSync(join(sandbox, "guarded", "out"))).toBe(false);
  });

  test("a version id is required, and the failure is explicit", () => {
    const configForHelp = writeConfig("noversion", "t-noversion");
    const { status, output } = runPipeline(["--config", configForHelp]);
    expect(status).toBe(2);
    expect(output).toContain("A version id is required");
  });
});
