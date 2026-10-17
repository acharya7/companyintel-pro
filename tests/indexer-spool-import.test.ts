/**
 * Experimental Pass 2 rebuild from an existing, verified Pass 1 spool.
 *
 * The failure this file exists for: the documented benchmark rebuilt the
 * association index with `run --version v1-bench-1m-assoc`, but the run identity
 * includes the dataset version, so resume refused it — and the documented
 * alternative (`--no-resume`) would have deleted the original spool and re-read
 * 64 GB from R2. `pass2-from-spool` is the explicit, isolated third option, and
 * every guarantee it makes is asserted here against the real indexer:
 *
 *   1. an ordinary resume still rejects a different dataset version;
 *   2. the explicit rebuild accepts a verified compatible source spool;
 *   3. a source configuration/sample-limit mismatch is rejected;
 *   4. a corrupted spool (truncated, or same-size byte change) is rejected;
 *   5. the source checkpoint, manifest and partitions stay byte-identical;
 *   6. the original generated index stays byte-identical;
 *   7. the experimental index has its own version and output files;
 *   8. an interrupted rebuild restarts without duplicate postings or stale objects;
 *   9. the two-stage association logic works on the imported spool.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";

import { identityFor, runIndex, type IndexerConfig, type RunResult } from "../tools/indexer/src/build";
import { checkpointPathFor, spoolDirFor, spoolManifestPathFor } from "../tools/indexer/src/spool";
import { prepareSpoolImport, runExperimentalPass2, type SpoolImportRequest } from "../tools/indexer/src/spool-import";
import type { Contact, UnassignedContact } from "../src/shared/models";
import type { CompanyPartitionPayload, ContactPartitionPayload, IndexDirectory, UnassignedPartitionPayload } from "../src/shared/search/index-format";
import { INDEX_FORMAT_VERSION, indexDirectoryKey } from "../src/shared/search/index-format";

const projectRoot = join(import.meta.dir, "..");
const VERSION = "src-v1";
const OUTPUT_VERSION = "src-v1-assoc";
const PARTITIONS = 4;
const SHARDS = { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 };

/* ------------------------------- the corpus -------------------------------- */

const CSV1_HEADERS = ["Company Name", "Company Domain", "Industry", "Country", "City", "Contact Name", "Job Title", "Email", "Phone"];
const CSV2_HEADERS = ["organization", "domain", "employee_range", "full_name", "designation", "seniority", "department", "work_email", "location_country"];

/**
 * Two files with different schemas for the same companies, plus one name family
 * with THREE records (two with their own domain, one name-only) so Stage B has a
 * genuine choice to make:
 *
 *   - Priya's row carries A's domain  → high confidence, A;
 *   - Erin's row carries B's domain   → high confidence, B;
 *   - Omar's row carries only a name but his email names B → identified at B;
 *   - Nina claims the name-only record with a personal address and no country
 *     evidence → several credible candidates → preserved, never attached.
 */
function writeCorpus(dir: string): { csv1: string; csv2: string } {
  mkdirSync(dir, { recursive: true });
  const csv1 = join(dir, "organizations.csv");
  const csv2 = join(dir, "people.csv");

  const first = [CSV1_HEADERS.join(",")];
  for (let i = 0; i < 12; i += 1) {
    first.push(
      [
        `"Ordinary ${i} Ltd"`,
        `ordinary${i}.example`,
        "Software",
        "United States",
        `City ${i % 5}`,
        `Alpha ${i}`,
        "Chief Technology Officer",
        `alpha.${i}@ordinary${i}.example`,
        "",
      ].join(","),
    );
  }
  first.push(
    [
      `"Vertex Analytics Private Limited"`,
      "vertexanalytics.example",
      "Analytics",
      "India",
      "Pune",
      `"Priya Menon"`,
      "Head of Data",
      "priya.menon@vertexanalytics.example",
      "",
    ].join(","),
  );
  first.push(
    [`"Vertex Analytics Private Limited"`, "vertexanalytics.example", "Analytics", "India", "Pune", `"Sam Reed"`, "Analyst", "sam.reed@gmail.com", ""].join(","),
  );
  writeFileSync(csv1, `${first.join("\n")}\n`, "utf8");

  const second = [CSV2_HEADERS.join(",")];
  for (let i = 0; i < 12; i += 1) {
    second.push(
      [`Ordinary ${i} Ltd`, `ordinary${i}.example`, "201-500", `Beta ${i}`, "Head of Data", "Director", "Data", `beta.${i}@ordinary${i}.example`, "United States"].join(","),
    );
  }
  second.push(
    ["Vertex Analytics Pvt Ltd", "vertexmetrics.example", "51-200", "Erin Shaw", "Director", "Director", "Analytics", "erin.shaw@vertexmetrics.example", "India"].join(","),
  );
  // Name-only employer: no domain, no LinkedIn, no source id.
  second.push(["Vertex Analytics", "", "51-200", "Nina Park", "Engineer", "Mid", "Data", "nina.park@gmail.com", ""].join(","));
  second.push(["Vertex Analytics", "", "51-200", "Omar Farouk", "Sales Manager", "Mid", "Sales", "omar.farouk@vertexmetrics.example", ""].join(","));
  writeFileSync(csv2, `${second.join("\n")}\n`, "utf8");
  return { csv1, csv2 };
}

/** One small source for the sample-limit carry-through test. */
function writeSampleCorpus(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "sample.csv");
  const rows = [CSV1_HEADERS.join(",")];
  for (let i = 0; i < 8; i += 1) {
    rows.push([`"Sample ${i} Ltd"`, `sample${i}.example`, "Software", "India", "Pune", `"Person ${i}"`, "Engineer", `person.${i}@sample${i}.example`, ""].join(","));
  }
  writeFileSync(path, `${rows.join("\n")}\n`, "utf8");
  return path;
}

/* ------------------------------- filesystem -------------------------------- */

function digestTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(dir, path).split("\\").join("/"), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileTree(dir: string): string[] {
  return [...digestTree(dir).keys()].sort();
}

/** Generated files that carry a timestamp, so only their presence is compared. */
const TIMESTAMPED = /\/(manifest|validation|stats)\.json$|\/directory\.json$/;

function byteStable(tree: Map<string, string>): Map<string, string> {
  return new Map([...tree].filter(([key]) => key !== "objects.jsonl" && !TIMESTAMPED.test(`/${key}`)));
}

function readJson(path: string): unknown {
  const raw = readFileSync(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
}

function readDirectory(outputDir: string, version: string): IndexDirectory {
  return readJson(join(outputDir, indexDirectoryKey(version))) as IndexDirectory;
}

function readContacts(outputDir: string, version: string): Contact[] {
  const dir = join(outputDir, "contacts", version);
  if (!existsSync(dir)) return [];
  const contacts: Contact[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json.gz")).sort()) {
    const payload = readJson(join(dir, name)) as ContactPartitionPayload;
    for (const list of Object.values(payload.byCompany ?? {})) contacts.push(...list);
  }
  return contacts;
}

function readPreserved(outputDir: string, version: string): UnassignedContact[] {
  const dir = join(outputDir, "unassigned", version);
  if (!existsSync(dir)) return [];
  const preserved: UnassignedContact[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json.gz")).sort()) {
    const payload = readJson(join(dir, name)) as UnassignedPartitionPayload;
    preserved.push(...(payload.contacts ?? []));
  }
  return preserved;
}

/** Every posting's `refs` list, so a duplicate posting is caught directly. */
function postings(outputDir: string, version: string): { term: string; kind: string; refs: number[] }[] {
  const root = join(outputDir, "indexes", version);
  const out: { term: string; kind: string; refs: number[] }[] = [];
  for (const kind of ["exact", "prefix", "token", "trigram", "ids"]) {
    const dir = join(root, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".json.gz")).sort()) {
      const payload = readJson(join(dir, name)) as { terms: Record<string, { refs: number[] }> };
      for (const [term, value] of Object.entries(payload.terms ?? {})) out.push({ term, kind, refs: value.refs });
    }
  }
  return out;
}

/* -------------------------------- fixtures --------------------------------- */

interface Fixtures {
  root: string;
  config: IndexerConfig;
  sampleConfig: IndexerConfig;
  sourceResult: RunResult;
  sampleResult: RunResult;
  sourceWorkBefore: Map<string, string>;
  sourceOutBefore: Map<string, string>;
  activeBefore: string;
}

let fixtures: Fixtures;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "companyintel-spool-import-"));
  const files = writeCorpus(join(root, "raw"));
  const config: IndexerConfig = {
    datasetVersion: VERSION,
    sources: [
      { id: "csv1", path: files.csv1, encoding: "utf8", delimiter: "," },
      { id: "csv2", path: files.csv2, encoding: "utf8", delimiter: "," },
    ],
    workDir: join(root, "src-work"),
    outputDir: join(root, "src-out"),
    partitions: PARTITIONS,
    shards: SHARDS,
  };
  const sourceResult = await runIndex(config, {});

  // A published pointer, as it exists on the benchmark machine: this file must
  // never be written by an experimental rebuild.
  mkdirSync(join(config.outputDir, "manifests"), { recursive: true });
  writeFileSync(join(config.outputDir, "manifests", "active.json"), JSON.stringify({ version: VERSION, previousVersion: null }, null, 2), "utf8");

  const sampleConfig: IndexerConfig = {
    datasetVersion: "sample-v1",
    sources: [{ id: "csv1", path: writeSampleCorpus(join(root, "sample-raw")), encoding: "utf8", delimiter: "," }],
    workDir: join(root, "sample-work"),
    outputDir: join(root, "sample-out"),
    partitions: PARTITIONS,
    shards: SHARDS,
  };
  const sampleResult = await runIndex(sampleConfig, { sampleLimit: 3 });

  fixtures = {
    root,
    config,
    sampleConfig,
    sourceResult,
    sampleResult,
    sourceWorkBefore: digestTree(config.workDir),
    sourceOutBefore: digestTree(config.outputDir),
    activeBefore: digestFile(join(config.outputDir, "manifests", "active.json")),
  };
});

afterAll(() => {
  if (fixtures?.root) rmSync(fixtures.root, { recursive: true, force: true });
});

function importRequest(label: string, version = OUTPUT_VERSION): SpoolImportRequest {
  return {
    sourceWorkDir: fixtures.config.workDir,
    workDir: join(fixtures.root, `${label}-work`),
    outputDir: join(fixtures.root, `${label}-out`),
    sourceOutputDir: fixtures.config.outputDir,
    outputVersion: version,
    expectation: { partitions: fixtures.config.partitions, sources: identityFor(fixtures.config, undefined).sources },
  };
}

async function rebuild(label: string, version = OUTPUT_VERSION, sampleLimit?: number | null) {
  const request = {
    sourceWorkDir: fixtures.config.workDir,
    workDir: join(fixtures.root, `${label}-work`),
    outputDir: join(fixtures.root, `${label}-out`),
    outputVersion: version,
    ...(sampleLimit === undefined ? {} : { expectSampleLimit: sampleLimit }),
  };
  const outcome = await runExperimentalPass2(fixtures.config, request);
  return { ...outcome, workDir: request.workDir, outputDir: request.outputDir };
}

/* --------------------------------- tests ----------------------------------- */

describe("ordinary resume still owns its run identity", () => {
  test("rejects a different dataset version, and changes nothing", () => {
    const before = digestTree(fixtures.config.workDir);
    expect(() => runIndex({ ...fixtures.config, datasetVersion: OUTPUT_VERSION }, {})).toThrow(/checkpoint for a different run/);
    expect(() => runIndex({ ...fixtures.config, datasetVersion: OUTPUT_VERSION }, {})).toThrow(new RegExp(`version ${VERSION} → ${OUTPUT_VERSION}`));
    expect(digestTree(fixtures.config.workDir)).toEqual(before);
  });

  test("rejects a different sample limit", () => {
    expect(() => runIndex(fixtures.config, { sampleLimit: 7 })).toThrow(/checkpoint for a different run/);
    expect(() => runIndex(fixtures.config, { sampleLimit: 7 })).toThrow(/sample none → 7/);
  });

  test("rejects a different partition count", () => {
    expect(() => runIndex({ ...fixtures.config, partitions: PARTITIONS + 1 }, {})).toThrow(/partitions 4 → 5/);
  });
});

describe("explicit experimental Pass 2 rebuild", () => {
  test("accepts a verified compatible source spool and skips every source read", async () => {
    const { plan, result } = await rebuild("accept");

    expect(plan.sourceVersion).toBe(VERSION);
    expect(plan.outputVersion).toBe(OUTPUT_VERSION);
    expect(plan.restarted).toBe(false);
    expect(plan.sampleLimit).toBeNull();

    // Pass 1, profiling and the sources are all skipped.
    expect(result.resumed).toBe(true);
    expect(result.stages.pass1Ms).toBe(0);
    expect(result.stages.profilingMs).toBe(0);
    expect(result.sourceStats.requests).toBe(0);
    expect(result.sourceStats.objectsOpened).toBe(0);
    expect(result.manifest.validationPassed).toBe(true);

    // The same spool must produce the same decisions as the source run.
    expect(result.counters.rowsRead).toBe(fixtures.sourceResult.counters.rowsRead);
    expect(result.counters.rowsRejected).toBe(fixtures.sourceResult.counters.rowsRejected);
    expect(result.counters.uniqueCompanies).toBe(fixtures.sourceResult.counters.uniqueCompanies);
    expect(result.counters.uniqueContacts).toBe(fixtures.sourceResult.counters.uniqueContacts);
    expect(result.counters.contactsHighConfidence).toBe(fixtures.sourceResult.counters.contactsHighConfidence);
    expect(result.counters.contactsUnresolved).toBe(fixtures.sourceResult.counters.contactsUnresolved);
  });

  test("carries the source run's sample limit into the new version", async () => {
    const request = {
      sourceWorkDir: fixtures.sampleConfig.workDir,
      workDir: join(fixtures.root, "sample-import-work"),
      outputDir: join(fixtures.root, "sample-import-out"),
      outputVersion: "sample-v1-assoc",
      expectSampleLimit: 3,
    };
    const { plan, result } = await runExperimentalPass2(fixtures.sampleConfig, request);
    expect(plan.sampleLimit).toBe(3);
    const checkpoint = readJson(checkpointPathFor(request.workDir)) as { identity: { version: string; sampleLimit: number | null } };
    expect(checkpoint.identity.version).toBe("sample-v1-assoc");
    expect(checkpoint.identity.sampleLimit).toBe(3);
    expect(result.manifest.validationPassed).toBe(true);
    expect(result.counters.rowsRead).toBe(fixtures.sampleResult.counters.rowsRead);
  });
});

describe("source validation", () => {
  test("rejects a different source path, delimiter or partition count", () => {
    const request = importRequest("mismatch");
    const [first, second] = fixtures.config.sources;

    expect(() =>
      prepareSpoolImport({
        ...request,
        expectation: { partitions: PARTITIONS, sources: identityFor({ ...fixtures.config, sources: [{ ...first, path: join(fixtures.root, "other.csv") }, second] }, undefined).sources },
      }),
    ).toThrow(/does not describe the run that wrote this spool/);

    expect(() =>
      prepareSpoolImport({
        ...request,
        expectation: { partitions: PARTITIONS, sources: identityFor({ ...fixtures.config, sources: [{ ...first, delimiter: ";" }, second] }, undefined).sources },
      }),
    ).toThrow(/csv1 delimiter changed/);

    expect(() => prepareSpoolImport({ ...request, expectation: { partitions: PARTITIONS + 1, sources: identityFor(fixtures.config, undefined).sources } })).toThrow(
      /partitions 4 → 5/,
    );
  });

  test("rejects a sample limit assertion that the source run does not record", () => {
    expect(() =>
      prepareSpoolImport({
        sourceWorkDir: fixtures.sampleConfig.workDir,
        workDir: join(fixtures.root, "wrong-sample-work"),
        outputDir: join(fixtures.root, "wrong-sample-out"),
        sourceOutputDir: fixtures.sampleConfig.outputDir,
        outputVersion: "sample-v1-assoc",
        expectation: { partitions: PARTITIONS, sources: identityFor(fixtures.sampleConfig, undefined).sources, sampleLimit: 7 },
      }),
    ).toThrow(/sample 3 → 7/);
  });

  test("refuses to reuse the source run's own version as the output version", () => {
    expect(() => prepareSpoolImport({ ...importRequest("same-version"), outputVersion: VERSION })).toThrow(/is the source run's own version/);
  });

  test("refuses an output or work directory that is not isolated", () => {
    expect(() => prepareSpoolImport({ ...importRequest("same-work"), workDir: fixtures.config.workDir })).toThrow(/source Pass 1 work directory/);
    expect(() =>
      prepareSpoolImport({ ...importRequest("same-out"), outputDir: fixtures.config.outputDir }),
    ).toThrow(/is the ordinary output directory/);
    expect(() =>
      prepareSpoolImport({ ...importRequest("nested-out"), outputDir: join(fixtures.config.outputDir, "assoc") }),
    ).toThrow(/contain one another/);
  });

  test("rejects a truncated partition", () => {
    const copy = join(fixtures.root, "truncated-work");
    cpSync(fixtures.config.workDir, copy, { recursive: true });
    const spoolDir = spoolDirFor(copy);
    const file = readdirSync(spoolDir).filter((name) => name.endsWith(".jsonl")).sort()[0];
    const path = join(spoolDir, file);
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, Math.max(0, bytes.length - 10)));

    expect(() =>
      prepareSpoolImport({
        ...importRequest("truncated"),
        sourceWorkDir: copy,
      }),
    ).toThrow(/truncated|on disk but/);
  });

  test("rejects a same-size byte change (checksum)", () => {
    const copy = join(fixtures.root, "flipped-work");
    cpSync(fixtures.config.workDir, copy, { recursive: true });
    const spoolDir = spoolDirFor(copy);
    const file = readdirSync(spoolDir).filter((name) => name.endsWith(".jsonl")).sort()[0];
    const path = join(spoolDir, file);
    const bytes = Buffer.from(readFileSync(path));
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(path, bytes);

    expect(() => prepareSpoolImport({ ...importRequest("flipped-import"), sourceWorkDir: copy })).toThrow(/does not match the SHA-256/);
  });

  test("the engine never clears an imported spool when its own checkpoint is missing", () => {
    const before = digestTree(spoolDirFor(fixtures.config.workDir));
    expect(() =>
      runIndex(
        { ...fixtures.config, datasetVersion: "guard-assoc", workDir: join(fixtures.root, "guard-work"), outputDir: join(fixtures.root, "guard-out") },
        {
          resume: true,
          spoolImport: {
            spoolDir: spoolDirFor(fixtures.config.workDir),
            rows: 1,
            sourceWorkDir: fixtures.config.workDir,
            sourceOutputDir: fixtures.config.outputDir,
          },
        },
      ),
    ).toThrow(/no pass2-merge checkpoint/);
    expect(digestTree(spoolDirFor(fixtures.config.workDir))).toEqual(before);
    expect(existsSync(join(fixtures.root, "guard-work", "spool"))).toBe(false);
  });

  test("rejects a spool whose manifest is not complete", () => {
    const copy = join(fixtures.root, "incomplete-work");
    cpSync(fixtures.config.workDir, copy, { recursive: true });
    const manifestPath = spoolManifestPathFor(copy);
    const manifest = readJson(manifestPath) as { complete: boolean };
    manifest.complete = false;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    expect(() => prepareSpoolImport({ ...importRequest("incomplete-import"), sourceWorkDir: copy })).toThrow(/not a complete spool manifest/);
  });
});

describe("the original artifacts are untouched", () => {
  test("checkpoint, manifest and every partition stay byte-identical", async () => {
    await rebuild("bytes-work");
    expect(digestTree(fixtures.config.workDir)).toEqual(fixtures.sourceWorkBefore);
    // Spelled out, because these are the files the safety claim is about.
    expect(existsSync(checkpointPathFor(fixtures.config.workDir))).toBe(true);
    expect(existsSync(spoolManifestPathFor(fixtures.config.workDir))).toBe(true);
  });

  test("the original generated index and manifests/active.json stay byte-identical", async () => {
    await rebuild("bytes-out");
    expect(digestTree(fixtures.config.outputDir)).toEqual(fixtures.sourceOutBefore);
    expect(digestFile(join(fixtures.config.outputDir, "manifests", "active.json"))).toBe(fixtures.activeBefore);
  });
});

describe("the experimental index is its own artifact", () => {
  test("has its own version, its own output files and no active pointer", async () => {
    const { outputDir } = await rebuild("own");

    const directory = readDirectory(outputDir, OUTPUT_VERSION);
    expect(directory.version).toBe(OUTPUT_VERSION);
    expect(directory.formatVersion).toBe(INDEX_FORMAT_VERSION);
    expect(directory.shards.spoolPartitions).toBe(PARTITIONS);

    expect(existsSync(join(outputDir, "manifests", OUTPUT_VERSION, "manifest.json"))).toBe(true);
    expect(existsSync(join(outputDir, "companies", OUTPUT_VERSION))).toBe(true);
    expect(existsSync(join(outputDir, "manifests", "active.json"))).toBe(false);
    // The source output directory never gains the experimental version.
    expect(existsSync(join(fixtures.config.outputDir, "manifests", OUTPUT_VERSION))).toBe(false);
    expect(existsSync(join(fixtures.config.outputDir, "companies", OUTPUT_VERSION))).toBe(false);

    const checkpoint = readJson(checkpointPathFor(join(fixtures.root, "own-work"))) as { stage: string; identity: { version: string } };
    expect(checkpoint.stage).toBe("pass2-merge");
    expect(checkpoint.identity.version).toBe(OUTPUT_VERSION);
  });
});

describe("interruption and restart", () => {
  const INTERRUPT_EXIT_CODE = 97;

  /**
   * A child process that runs the real import and hard-exits part-way through pass
   * 2 — no flush, no `finally`, exactly like the benchmark being killed.
   */
  const script = `import { runExperimentalPass2 } from ${JSON.stringify(join(projectRoot, "tools", "indexer", "src", "spool-import.ts"))};
const config = JSON.parse(process.argv[2]);
const request = JSON.parse(process.argv[3]);
const stopAfter = Number(process.argv[4] ?? 0);
const completion = /^pass 2: (\\d+)\\/(\\d+) partitions ·/;
let completed = 0;
await runExperimentalPass2(config, request, {
  onProgress: (event) => {
    if (event.stage !== "pass2-merge") return;
    const match = completion.exec(event.message);
    if (!match) return;
    completed += 1;
    if (completed >= stopAfter) {
      console.log("INTERRUPTED_AFTER " + completed + "/" + match[2]);
      process.exit(${INTERRUPT_EXIT_CODE});
    }
  },
});
console.log("COMPLETED");
`;

  test("restarting reproduces a clean run: no duplicate postings, no stale objects", async () => {
    const scriptPath = join(fixtures.root, "interrupt-import.mjs");
    writeFileSync(scriptPath, script, "utf8");

    const request = {
      sourceWorkDir: fixtures.config.workDir,
      workDir: join(fixtures.root, "interrupted-work"),
      outputDir: join(fixtures.root, "interrupted-out"),
      outputVersion: OUTPUT_VERSION,
    };

    const child = spawnSync("bun", [scriptPath, JSON.stringify(fixtures.config), JSON.stringify(request), "1"], { cwd: projectRoot, encoding: "utf8" });
    expect(child.status).toBe(INTERRUPT_EXIT_CODE);
    expect(child.stdout).toContain("INTERRUPTED_AFTER");
    // The interruption happened after the workspace was prepared.
    expect(existsSync(checkpointPathFor(request.workDir))).toBe(true);
    expect(existsSync(join(request.outputDir, "objects.jsonl"))).toBe(false);

    const restarted = await runExperimentalPass2(fixtures.config, request);
    expect(restarted.plan.restarted).toBe(true);
    expect(restarted.plan.checks.some((check) => check.includes("adopted"))).toBe(true);
    expect(restarted.result.manifest.validationPassed).toBe(true);

    const clean = await rebuild("clean");

    // Byte-for-byte identical generated objects (timestamps excluded) — this is
    // what proves the replay wrote each posting exactly once.
    expect(byteStable(digestTree(request.outputDir))).toEqual(byteStable(digestTree(clean.outputDir)));
    // Exactly the same object keys: no stale object survived the reset.
    expect(fileTree(request.outputDir).sort()).toEqual(fileTree(clean.outputDir).sort());

    const written = postings(request.outputDir, OUTPUT_VERSION);
    expect(written.length).toBeGreaterThan(0);
    for (const posting of written) {
      expect({ term: posting.term, kind: posting.kind, unique: new Set(posting.refs).size === posting.refs.length }).toEqual({
        term: posting.term,
        kind: posting.kind,
        unique: true,
      });
    }
  });

  test("recovers a workspace interrupted between the import record and the checkpoint", async () => {
    const request = {
      sourceWorkDir: fixtures.config.workDir,
      workDir: join(fixtures.root, "half-setup-work"),
      outputDir: join(fixtures.root, "half-setup-out"),
      outputVersion: OUTPUT_VERSION,
    };
    // `--check-only` is the same setup path: record, derived manifest, checkpoint.
    await prepareSpoolImport({
      ...request,
      sourceOutputDir: fixtures.config.outputDir,
      expectation: { partitions: fixtures.config.partitions, sources: identityFor(fixtures.config, undefined).sources },
    });
    // A crash after the record (written first) but before the checkpoint leaves this.
    rmSync(checkpointPathFor(request.workDir), { force: true });

    const { plan, result } = await runExperimentalPass2(fixtures.config, request);
    expect(plan.restarted).toBe(true);
    expect(result.manifest.validationPassed).toBe(true);
    expect(existsSync(checkpointPathFor(request.workDir))).toBe(true);
    expect(readDirectory(request.outputDir, OUTPUT_VERSION).version).toBe(OUTPUT_VERSION);
  });

  test("refuses to adopt a work directory whose source has changed since it started", async () => {
    const request = {
      sourceWorkDir: fixtures.config.workDir,
      workDir: join(fixtures.root, "changed-work"),
      outputDir: join(fixtures.root, "changed-out"),
      outputVersion: OUTPUT_VERSION,
    };
    await runExperimentalPass2(fixtures.config, request);

    // Re-writing the import record's checksum is what a different source spool
    // would look like; the record must win, not the source.
    const recordPath = join(request.workDir, "experimental-import.json");
    const record = readJson(recordPath) as { sourceManifestSha256: string };
    record.sourceManifestSha256 = "0".repeat(64);
    writeFileSync(recordPath, JSON.stringify(record, null, 2), "utf8");

    expect(() => runExperimentalPass2(fixtures.config, request)).toThrow(/source spool manifest has changed/);
    expect(() =>
      runExperimentalPass2(fixtures.config, { ...request, outputVersion: "src-v1-other" }),
    ).toThrow(/was created for version/);
  });
});

describe("the CLI is the interface an operator actually uses", () => {
  const cli = join(projectRoot, "tools", "indexer", "src", "cli.ts");

  function runCli(extra: string[]) {
    const configPath = join(fixtures.root, "cli-config.json");
    writeFileSync(configPath, JSON.stringify(fixtures.config, null, 2), "utf8");
    return spawnSync(
      "bun",
      [cli, "pass2-from-spool", "--config", configPath, "--source-work-dir", fixtures.config.workDir, ...extra],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  test("--check-only validates and prepares, the full command then builds the isolated version", () => {
    const workDir = join(fixtures.root, "cli-work");
    const outputDir = join(fixtures.root, "cli-out");
    const flags = ["--work-dir", workDir, "--output-dir", outputDir, "--version", "cli-assoc"];

    const checked = runCli([...flags, "--check-only"]);
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain("Experimental Pass 2 import — validated read-only");
    expect(checked.stdout).toContain("Check only");
    expect(existsSync(join(outputDir, "objects.jsonl"))).toBe(false);

    const built = runCli(flags);
    expect(built.status).toBe(0);
    expect(built.stdout).toContain("Nothing was uploaded, nothing was published, and manifests/active.json was not written.");
    expect(built.stdout).toContain("rebuild");
    expect(existsSync(join(outputDir, "manifests", "cli-assoc", "validation.json"))).toBe(true);
    expect(readDirectory(outputDir, "cli-assoc").version).toBe("cli-assoc");
  });

  test("refuses a missing --version and a flag typed without its value", () => {
    const configPath = join(fixtures.root, "cli-config.json");
    writeFileSync(configPath, JSON.stringify(fixtures.config, null, 2), "utf8");
    const noVersion = spawnSync("bun", [cli, "pass2-from-spool", "--config", configPath, "--source-work-dir", fixtures.config.workDir], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(noVersion.status).toBe(1);
    expect(noVersion.stderr).toContain("needs --version");

    const noValue = spawnSync(
      "bun",
      [
        cli,
        "pass2-from-spool",
        "--config",
        configPath,
        "--source-work-dir",
        fixtures.config.workDir,
        "--work-dir",
        join(fixtures.root, "flag-work"),
        "--output-dir",
        join(fixtures.root, "flag-out"),
        "--version",
        "flag-assoc",
        "--expect-sample",
      ],
      { cwd: projectRoot, encoding: "utf8" },
    );
    expect(noValue.status).toBe(1);
    expect(noValue.stderr).toContain("--expect-sample needs a value");
    expect(existsSync(join(fixtures.root, "flag-work"))).toBe(false);
  });

  test("refuses --upload", () => {
    const refused = runCli(["--work-dir", join(fixtures.root, "upload-work"), "--output-dir", join(fixtures.root, "upload-out"), "--version", "upload-assoc", "--upload"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("never uploads");
  });
});

describe("association on the imported spool", () => {
  test("produces the same two-stage decisions as the source run", async () => {
    const { outputDir, result } = await rebuild("assoc");

    const contacts = readContacts(outputDir, OUTPUT_VERSION);
    expect(contacts.length).toBeGreaterThan(0);
    const byName = new Map(contacts.map((contact) => [contact.fullName, contact]));
    expect(byName.get("Priya Menon")?.association?.category).toBe("high_confidence");
    // Identification, not a reassignment: the row carried only a name, so the email
    // domain names the employer directly and no previous employer is invented.
    const omar = byName.get("Omar Farouk");
    expect(omar?.association?.category).toBe("high_confidence");
    expect(omar?.association?.reason).toBe("email_domain_matches_assigned_company");
    expect(omar?.association?.movedFrom).toBeUndefined();

    const preserved = readPreserved(outputDir, OUTPUT_VERSION);
    const nina = preserved.find((contact) => contact.fullName === "Nina Park");
    expect(nina).toBeTruthy();
    expect(nina?.association.category).toBe("unresolved");
    expect(nina?.companyId).toBe("");
    expect(nina?.claimedCompanyName).toBe("Vertex Analytics");

    expect(result.counters.contactsMoved ?? 0).toBe(fixtures.sourceResult.counters.contactsMoved ?? 0);
    expect(result.counters.contactsMoved ?? 0).toBe(0);
    expect(result.counters.contactsUnresolved).toBe(fixtures.sourceResult.counters.contactsUnresolved);
    expect(result.counters.unassignedObjects).toBe(fixtures.sourceResult.counters.unassignedObjects);

    // Preserved contacts are never members of the company they named.
    const companies = readdirSync(join(outputDir, "companies", OUTPUT_VERSION))
      .filter((file) => file.endsWith(".json.gz"))
      .sort()
      .flatMap((file) => (readJson(join(outputDir, "companies", OUTPUT_VERSION, file)) as CompanyPartitionPayload).companies);
    for (const company of companies) {
      expect(company.contactCount).toBe(company.associations?.total ?? 0);
    }
    expect(statSync(join(outputDir, "manifests", OUTPUT_VERSION, "validation.json")).size).toBeGreaterThan(0);
  });
});
