/**
 * Pass-2 restart safety, posting-writer bounds and progress reporting.
 *
 * The 1 M benchmark died in pass 2. When it was restarted, two things about the
 * merge made that unsafe and opaque, and both are asserted here against the real
 * indexer, not a simulation:
 *
 *   1. pass 2 APPENDS to its temporary shard posting files and only overwrites the
 *      company/contact objects it reaches again, so a restarted run used to double
 *      every posting written before the interruption and could leave generated
 *      objects from an abandoned attempt in the version's output;
 *   2. progress was emitted once every 16 partitions as `fileIndex / total`, so one
 *      completed partition out of 256 displayed "0%" — a working merge looked stuck.
 *
 * The interruption is a REAL one: a child `bun` process runs the indexer and calls
 * `process.exit()` from inside the progress callback part-way through pass 2, so
 * buffered writes are lost and no `finally` runs, exactly like the benchmark being
 * killed. The restart then has to reproduce the clean run byte for byte.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import {
  SHARD_FLUSH_BYTES,
  pass2StepNotes,
  runIndex,
  type IndexerConfig,
  type ProgressEvent,
  type RunResult,
} from "../tools/indexer/src/build";
import { spoolManifestPathFor, checkpointPathFor } from "../tools/indexer/src/spool";
import {
  SHARDING,
  contactPartitionOfRef,
  indexDirectoryKey,
  indexShardKey,
  partitionOfRef,
  type CompanyPartitionPayload,
  type ContactPartitionPayload,
  type IndexDirectory,
  type ShardPayload,
} from "../src/shared/search/index-format";
import type { Company, Contact } from "../src/shared/models";

const projectRoot = join(import.meta.dir, "..");

/**
 * Files that belong to a DIFFERENT dataset version (or to no version at all) in the
 * same output directory. Pass 2 regenerates only `companies|contacts|indexes|manifests/<version>`
 * and `objects.jsonl`, so every one of these must survive a restart untouched —
 * including `manifests/active.json`, the pointer that decides what the app serves.
 */
const FOREIGN_FILES = [
  "companies/other-v1/00000.json.gz",
  "contacts/other-v1/00000.json.gz",
  "indexes/other-v1/exact/0000.json.gz",
  "indexes/other-v1/directory.json",
  "manifests/other-v1/manifest.json",
  "manifests/active.json",
  "objects.jsonl.other-v1",
];

/* ------------------------------- the corpus -------------------------------- */

const COMPANIES = 1_600;
const PARTITIONS = 16;
const VERSION = "restart-v1";
/** The plan the real config uses for the posting kinds, scaled to a test corpus. */
const SHARDS = { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 };

const CSV1_HEADERS = ["Company Name", "Company Domain", "Industry", "Country", "City", "Contact Name", "Job Title", "Email", "Phone"];
const CSV2_HEADERS = ["organization", "domain", "employee_range", "full_name", "designation", "seniority", "department", "work_email", "location_country"];

/**
 * Two files with different schemas that describe the SAME companies, so the merge
 * has to associate them by domain and give every company one contact from each file.
 * Every name carries a legal suffix, which is what makes the normalizer emit aliases
 * — and aliases are what produced duplicate prefix postings in the old writer.
 */
function writeCorpus(dir: string): { csv1: string; csv2: string } {
  mkdirSync(dir, { recursive: true });
  const csv1 = join(dir, "organizations.csv");
  const csv2 = join(dir, "people.csv");

  const first = [CSV1_HEADERS.join(",")];
  for (let i = 0; i < COMPANIES; i += 1) {
    first.push(
      [
        `"Company ${i} Ltd"`,
        `company-${i}.example`,
        i % 3 === 0 ? "Software" : i % 3 === 1 ? "Logistics" : "Manufacturing",
        i % 2 === 0 ? "United States" : "India",
        `City ${i % 40}`,
        `"Alpha ${i}"`,
        "Chief Technology Officer",
        `alpha.${i}@company-${i}.example`,
        "",
      ].join(","),
    );
  }
  // A row with no company name: it must be REPORTED, and it must survive a restart
  // in `rejected.jsonl` rather than being counted twice (pass 1 appends to that file).
  first.push(['""', "nameless.example", "Consulting", "India", "Pune", "", "", "", ""].join(","));
  writeFileSync(csv1, `${first.join("\n")}\n`, "utf8");

  const second = [CSV2_HEADERS.join(",")];
  for (let i = 0; i < COMPANIES; i += 1) {
    second.push(
      [
        `Company ${i} Ltd`,
        `company-${i}.example`,
        "201-500",
        `Beta ${i}`,
        "Head of Data",
        "Director",
        "Data",
        `beta.${i}@company-${i}.example`,
        "India",
      ].join(","),
    );
  }
  writeFileSync(csv2, `${second.join("\n")}\n`, "utf8");
  return { csv1, csv2 };
}

/* ------------------------------- filesystem -------------------------------- */

/** sha256 of every file under `dir`, keyed by its relative path. */
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

/** size + mtime of every file under `dir`: catches a write that content hashing would miss. */
function statTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(dir, path).split("\\").join("/"), `${statSync(path).size}:${statSync(path).mtimeMs}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * Generated artefacts that carry a timestamp, so they are deliberately excluded
 * from the byte-for-byte comparison between an uninterrupted run and a resumed
 * one. Every other generated file must be identical.
 */
const TIMESTAMPED = /\/(manifest|validation|stats)\.json$|\/directory\.json$/;

/**
 * `objects.jsonl` lists the checksum of every generated object, including the four
 * timestamped ones, so its own bytes are not stable across runs even when the index
 * is identical. It is compared through the run's object list (`stableObjects`)
 * instead of byte-wise.
 */
function byteStable(tree: Map<string, string>): Map<string, string> {
  return new Map([...tree].filter(([key]) => key !== "objects.jsonl" && !TIMESTAMPED.test(`/${key}`)));
}

/** `<key> <bytes> <sha256>` for every generated object except the timestamped ones. */
function stableObjects(objects: RunResult["objects"]): string[] {
  return objects
    .filter((object) => !TIMESTAMPED.test(`/${object.key}`))
    .map((object) => `${object.key} ${object.bytes} ${object.sha256}`);
}

/* ------------------------------ interruption ------------------------------- */

/**
 * A child process that runs the indexer and hard-exits part-way through pass 2.
 *
 * `process.exit` from inside `onProgress` is the closest thing to the benchmark
 * being killed: no pending write is flushed, no `finally` runs, and the process
 * simply stops mid-merge. The parent asserts the exit code, so a child that failed
 * for another reason cannot be mistaken for a successful interruption.
 */
const INTERRUPT_SCRIPT = `
import { runIndex } from ${JSON.stringify(join(projectRoot, "tools", "indexer", "src", "build.ts"))};

const config = JSON.parse(process.argv[2]);
const stopAfter = Number(process.argv[3] ?? 0);
const completion = /^pass 2: (\\d+)\\/(\\d+) partitions ·/;
let completed = 0;

await runIndex(config, {
  onProgress: (event) => {
    if (event.stage !== "pass2-merge") return;
    const match = completion.exec(event.message);
    if (!match) return;
    completed += 1;
    if (completed >= stopAfter) {
      console.log("INTERRUPTED_AFTER " + completed + "/" + match[2]);
      process.exit(97);
    }
  },
});
console.log("COMPLETED");
`;

const INTERRUPT_EXIT_CODE = 97;

function interruptRun(scriptPath: string, config: IndexerConfig, stopAfterPartition: number) {
  const result = spawnSync("bun", [scriptPath, JSON.stringify(config), String(stopAfterPartition)], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/* --------------------------- generated index reads -------------------------- */

function readDirectory(outputDir: string, version: string): IndexDirectory {
  return JSON.parse(readFileSync(join(outputDir, indexDirectoryKey(version)), "utf8")) as IndexDirectory;
}

/**
 * Every company object, keyed by document ref.
 *
 * Deliberately enumerates the directory on disk rather than following
 * `directory.json`: this is read from an INTERRUPTED run too, and the directory is
 * written at the very end of finalize, so it does not exist yet at that point.
 */
function readCompanies(outputDir: string, version: string) {
  const byRef = new Map<number, Company>();
  const firstRefs: number[] = [];
  const folder = join(outputDir, "companies", version);
  for (const name of existsSync(folder) ? readdirSync(folder).filter((entry) => entry.endsWith(".json.gz")).sort() : []) {
    const payload = JSON.parse(gunzipSync(readFileSync(join(folder, name))).toString("utf8")) as CompanyPartitionPayload & { companies: Company[] };
    firstRefs.push(payload.firstRef);
    payload.companies.forEach((company, index) => byRef.set(payload.firstRef + index, company));
  }
  return { byRef, firstRefs };
}

/** Contacts by company ref, keyed exactly as the reader locates them. */
function readContacts(outputDir: string, version: string) {
  const byRef = new Map<number, Contact[]>();
  const firstRefs: number[] = [];
  const folder = join(outputDir, "contacts", version);
  for (const name of existsSync(folder) ? readdirSync(folder).filter((entry) => entry.endsWith(".json.gz")).sort() : []) {
    const payload = JSON.parse(gunzipSync(readFileSync(join(folder, name))).toString("utf8")) as ContactPartitionPayload & { byCompany: Record<string, Contact[]> };
    firstRefs.push(payload.firstRef);
    for (const [ref, contacts] of Object.entries(payload.byCompany)) byRef.set(Number(ref), contacts);
  }
  return { byRef, firstRefs };
}

function readShards(outputDir: string, version: string): { kind: string; shard: number; payload: ShardPayload }[] {
  const directory = readDirectory(outputDir, version);
  const out: { kind: string; shard: number; payload: ShardPayload }[] = [];
  for (const kind of ["exact", "prefix", "token", "trigram", "ids"] as const) {
    for (let shard = 0; shard < directory.shards[kind]; shard += 1) {
      const key = indexShardKey(version, kind, shard);
      if (!existsSync(join(outputDir, key))) continue;
      out.push({ kind, shard, payload: JSON.parse(gunzipSync(readFileSync(join(outputDir, key))).toString("utf8")) as ShardPayload });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */

describe("pass-2 restart safety", () => {
  let dir: string;
  let config: IndexerConfig;
  let interruptScript: string;
  let clean: RunResult;
  /** Digest of the clean output, taken before the interruption deleted it. */
  let cleanOutput: Map<string, string>;
  /** Spool + checkpoint + rejected rows as they were when pass 1 finished. */
  let spoolBefore: Map<string, string>;
  let manifestBefore: string;
  let checkpointBefore: string;
  let interrupted: RunResult;

  beforeAll(async () => {
    dir = join(tmpdir(), `ci-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const files = writeCorpus(join(dir, "raw"));
    config = {
      datasetVersion: VERSION,
      sources: [
        { id: "csv1", path: files.csv1 },
        { id: "csv2", path: files.csv2 },
      ],
      workDir: join(dir, "work"),
      outputDir: join(dir, "out"),
      partitions: PARTITIONS,
      shards: SHARDS,
    };
    interruptScript = join(dir, "interrupt.ts");
    writeFileSync(interruptScript, INTERRUPT_SCRIPT, "utf8");

    // Another dataset version already in the same output directory: pass 2 must
    // never touch it. Written with content that is impossible to reproduce, so a
    // deleted-and-rewritten file cannot pass by coincidence — and planted BEFORE the
    // reference run, so the digest comparison below proves they survived everything.
    for (const key of FOREIGN_FILES) {
      const path = join(config.outputDir, key);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `{"sentinel":"${key}"}`, "utf8");
    }

    // A complete, uninterrupted run: the reference every restart must reproduce.
    clean = await runIndex(config, {});
    cleanOutput = digestTree(config.outputDir);
    spoolBefore = statTree(join(config.workDir, "spool"));
    manifestBefore = readFileSync(spoolManifestPathFor(config.workDir), "utf8");
    checkpointBefore = readFileSync(checkpointPathFor(config.workDir), "utf8");
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The two stale-shard states an interrupted merge can leave behind.
   *
   * A batch of posting lines that was flushed before the interruption, and — the
   * exact shape of the original defect — a posting for a company that this run will
   * emit again. If the stale file survived, that ref would appear twice in the final
   * shard. The term below is one no company in this corpus can produce, so its
   * presence in the finished index would be proof that old postings were carried over.
   */
  const STALE_TERM = "staleplantedterm";
  const staleShardFiles = () => [
    join(config.workDir, "shards", "exact", "0000.lines"),
    join(config.workDir, "shards", "trigram", "0003.lines"),
  ];

  test("an interrupted merge leaves partial output on disk", () => {
    const first = interruptRun(interruptScript, config, 11);
    expect(first.status).toBe(INTERRUPT_EXIT_CODE);
    expect(first.stdout).toContain("INTERRUPTED_AFTER 11/16");

    // The interruption happened in the middle of pass 2, so part of the output is
    // there: enough companies to have flushed at least one company object.
    const partial = readCompanies(config.outputDir, VERSION);
    expect(partial.byRef.size).toBeGreaterThan(0);
    expect(partial.byRef.size).toBeLessThan(COMPANIES);

    // Interrupted a second time, from a partially written state: one restart is not
    // a guarantee that a second one is safe.
    const second = interruptRun(interruptScript, config, 5);
    expect(second.status).toBe(INTERRUPT_EXIT_CODE);
    expect(second.stdout).toContain("INTERRUPTED_AFTER 5/16");
  }, 120_000);

  test("a half-finished cleanup plus leftover shard postings still restarts", () => {
    // What an interrupted *cleanup* leaves behind: the previous attempt's output
    // partially removed. The reset deletes whole trees idempotently, so removing a
    // subset by hand is exactly that state, and the next start must cope with it.
    rmSync(join(config.outputDir, "indexes", VERSION), { recursive: true, force: true });
    rmSync(join(config.outputDir, "objects.jsonl"), { force: true });
    expect(readCompanies(config.outputDir, VERSION).byRef.size).toBeGreaterThan(0); // survived the half-cleanup
    expect(existsSync(join(config.outputDir, "objects.jsonl"))).toBe(false);

    // Leftover temporary postings, as an attempt that had flushed at least one batch
    // leaves them — including a posting for a company this run will emit again. The
    // reader only collapses a repeat that is adjacent, so if this file were appended
    // to instead of deleted, the finished shard would carry the ref twice.
    for (const path of staleShardFiles()) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `company 0\u00010\u000199\n${STALE_TERM}\u00017\u000199\n`, "utf8");
    }
    expect(staleShardFiles().every((path) => existsSync(path))).toBe(true);
  });

  test("the restart reproduces the clean run, with nothing stale and nothing duplicated", async () => {
    interrupted = await runIndex(config, {});
    expect(interrupted.resumed).toBe(true);
    expect(interrupted.manifest.validationPassed).toBe(true);

    // Counters are the clean run's, restored from the checkpoint rather than
    // recomputed from a partial pass 1.
    expect(interrupted.counters).toEqual(clean.counters);
    expect(interrupted.counters.rowsRead).toBe(COMPANIES * 2 + 1);
    expect(interrupted.counters.rowsRejected).toBe(1);
    expect(interrupted.counters.uniqueCompanies).toBe(COMPANIES);
    expect(interrupted.counters.uniqueContacts).toBe(COMPANIES * 2);
    expect(interrupted.objects.length).toBe(clean.objects.length);

    // The restart actually did reset work — otherwise this test would pass on a run
    // that silently appended to the previous attempt. Both leftover shard files and
    // the partial generated objects are reported as removed.
    expect(interrupted.pass2Reset.shardFiles).toBe(staleShardFiles().length);
    expect(interrupted.pass2Reset.outputFiles).toBeGreaterThan(0);
    expect(staleShardFiles().some((path) => existsSync(path))).toBe(false);
    // …and the planted posting left no trace in the finished index.
    const planted = readShards(config.outputDir, VERSION).filter(({ payload }) => Object.prototype.hasOwnProperty.call(payload.terms, STALE_TERM));
    expect(planted).toEqual([]);

    // Same files, same bytes: no stale company/contact object, no duplicated
    // posting, and deterministic refs and object boundaries. (The restarted run
    // deleted the previous attempt's output, so anything extra here would be a
    // survivor — and the second assertion names the exact file if there is one.)
    const restartedOutput = digestTree(config.outputDir);
    expect([...byteStable(restartedOutput).keys()].sort()).toEqual([...byteStable(cleanOutput).keys()].sort());
    expect(byteStable(restartedOutput)).toEqual(byteStable(cleanOutput));

    // The object list, which is what `validate` and `upload` trust, names exactly the
    // objects this run wrote — no obsolete entry from the abandoned attempt — and every
    // non-timestamped object has the same size and checksum as in the clean run.
    expect(interrupted.objects.map((object) => object.key)).toEqual(clean.objects.map((object) => object.key));
    expect(stableObjects(interrupted.objects)).toEqual(stableObjects(clean.objects));
    expect(readFileSync(join(config.outputDir, "objects.jsonl"), "utf8").endsWith("\n")).toBe(true);

    // The manifest is regenerated (it carries timestamps) but must describe the same
    // index: object count, bytes and counters all match the clean run.
    // The manifest and the directory are written uncompressed on purpose, so they
    // are readable with a plain GET and no content-encoding metadata.
    const manifest = JSON.parse(readFileSync(join(config.outputDir, `manifests/${VERSION}/manifest.json`), "utf8")) as {
      objectCount: number;
      bytes: number;
      counters: Record<string, unknown>;
      validationPassed: boolean;
    };
    // Compared against the reference run rather than against `objects.length`: the
    // summary is built before validation.json and manifest.json are written, so it
    // names two fewer objects than the run wrote (pre-existing, and unchanged here).
    expect(manifest.objectCount).toBe(clean.manifest.objectCount);
    expect(manifest.bytes).toBe(clean.manifest.bytes);
    expect(manifest.counters).toEqual(clean.counters);
    expect(manifest.validationPassed).toBe(true);
  }, 120_000);

  test("the Pass 1 spool, its manifest, the checkpoint and rejected rows are untouched", () => {
    expect(statTree(join(config.workDir, "spool"))).toEqual(spoolBefore);
    expect(readFileSync(spoolManifestPathFor(config.workDir), "utf8")).toBe(manifestBefore);
    expect(readFileSync(checkpointPathFor(config.workDir), "utf8")).toBe(checkpointBefore);
    // The rejection list is pass 1's output too: a restart must not append to it a
    // second time (which would double-count every rejected row).
    const rejected = readFileSync(join(config.workDir, "rejected.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(rejected).toHaveLength(1);
    expect((JSON.parse(rejected[0]) as { reason: string }).reason).toBe("missing_company_name");
  });

  test("another dataset version in the same output directory is never deleted", () => {
    for (const key of FOREIGN_FILES) {
      const path = join(config.outputDir, key);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(`{"sentinel":"${key}"}`);
    }
  });

  test("no posting carries the same ref twice, and every shard is well formed", () => {
    const shards = readShards(config.outputDir, VERSION);
    expect(shards.length).toBeGreaterThan(SHARDS.exact);
    let postings = 0;
    for (const { kind, shard, payload } of shards) {
      for (const [term, entry] of Object.entries(payload.terms)) {
        const duplicates = entry.refs.filter((ref, index) => index > 0 && entry.refs[index - 1] === ref);
        expect({ kind, shard, term, duplicates }).toEqual({ kind, shard, term, duplicates: [] });
        expect(new Set(entry.refs).size).toBe(entry.refs.length);
        expect(entry.q?.length).toBe(entry.refs.length);
        expect(term.length).toBeGreaterThan(0);
        postings += entry.refs.length;
      }
    }
    expect(postings).toBeGreaterThan(COMPANIES * 5);
  });

  test("companies and contacts hydrate across object boundaries", () => {
    const companies = readCompanies(config.outputDir, VERSION);
    const contacts = readContacts(config.outputDir, VERSION);

    expect(companies.byRef.size).toBe(COMPANIES);
    // Boundaries: 250 companies per object, 1,000 per contact object.
    expect(companies.firstRefs).toHaveLength(Math.ceil(COMPANIES / SHARDING.companiesPerPartition));
    expect(readDirectory(config.outputDir, VERSION).shards.companyPartitions).toBe(Math.ceil(COMPANIES / SHARDING.companiesPerPartition));
    expect(contacts.firstRefs).toEqual([0, SHARDING.companiesPerContactPartition]);
    for (const [index, firstRef] of companies.firstRefs.entries()) {
      // The reader locates a ref's object with `partitionOfRef`; the object must
      // therefore carry exactly that `firstRef`.
      expect(firstRef).toBe(index * SHARDING.companiesPerPartition);
      expect(partitionOfRef(firstRef)).toBe(index);
    }

    // Every company is reachable at its own ref and owns exactly its own contacts —
    // including the refs that sit either side of both object boundaries.
    for (const ref of [0, SHARDING.companiesPerPartition - 1, SHARDING.companiesPerPartition, SHARDING.companiesPerContactPartition - 1, SHARDING.companiesPerContactPartition, COMPANIES - 1]) {
      const company = companies.byRef.get(ref);
      expect(company).toBeDefined();
      // Refs are assigned in spool-partition order, so the company behind a ref is
      // whichever name hashed into that partition — the name says which one it is.
      const index = Number(/^Company (\d+) Ltd$/.exec(company!.name)?.[1]);
      expect(Number.isInteger(index)).toBe(true);
      const owned = contacts.byRef.get(ref) ?? [];
      expect(owned).toHaveLength(company!.contactCount);
      expect(owned).toHaveLength(2);
      expect(owned.every((contact) => contact.companyId === company!.id)).toBe(true);
      expect(owned.map((contact) => contact.email).sort()).toEqual([
        `alpha.${index}@company-${index}.example`,
        `beta.${index}@company-${index}.example`,
      ]);
      // The contacts really are in the object the reader would fetch for this ref.
      const expectedObject = contactPartitionOfRef(ref);
      expect(contacts.firstRefs[expectedObject]).toBe(expectedObject * SHARDING.companiesPerContactPartition);
    }

    const allContacts = [...contacts.byRef.values()].flat();
    expect(allContacts).toHaveLength(COMPANIES * 2);
    expect(new Set(allContacts.map((contact) => contact.email)).size).toBe(COMPANIES * 2);
    expect(new Set(allContacts.map((contact) => contact.id)).size).toBe(COMPANIES * 2);
  });

  test("the posting writer batches by shard and stays inside its memory and handle bounds", () => {
    const stats = interrupted.shardWrite;
    expect(stats.appends).toBeGreaterThan(COMPANIES * 5);
    // The old writer opened a stream for nearly every posting; batching must open
    // far fewer files than it writes postings.
    expect(stats.appends / stats.fileOpens).toBeGreaterThan(10);
    expect(stats.peakOpenHandles).toBeLessThanOrEqual(1);
    expect(stats.peakBufferedBytes).toBeLessThanOrEqual(SHARD_FLUSH_BYTES + 4096);
    expect(stats.bytes).toBeGreaterThan(stats.appends); // every line is at least a few bytes
  });

  test("a restart reads no source data at all", async () => {
    /*
     * The whole point of a preserved Pass 1 spool is that the multi-hour source read
     * is finished, so a restart must merge without touching the sources. The strongest
     * available proof is to make them impossible to read: the CSVs are deleted after
     * pass 1 (the config still names the same paths, which is what the checkpoint's
     * identity compares), and the restart has to produce the identical index anyway.
     * Profiling is part of that promise — it samples every source, so a resumed run
     * skips it rather than reading a few megabytes it cannot use.
     */
    const config2: IndexerConfig = { ...config, workDir: join(dir, "work-moved"), outputDir: join(dir, "out-moved") };
    const events: ProgressEvent[] = [];
    const first = await runIndex(config2, { onProgress: (event) => events.push(event) });
    expect(first.resumed).toBe(false);
    const reference = digestTree(config2.outputDir);

    rmSync(config2.sources[0].path, { force: true });
    rmSync(config2.sources[1].path, { force: true });

    const resumedEvents: ProgressEvent[] = [];
    const resumed = await runIndex(config2, { onProgress: (event) => resumedEvents.push(event) });
    expect(resumed.resumed).toBe(true);
    expect(resumed.stages.pass1Ms).toBe(0);
    expect(resumed.profiles).toEqual([]);
    expect(resumed.counters).toEqual(first.counters);
    expect(resumed.manifest.validationPassed).toBe(true);
    expect(resumedEvents.some((event) => /profiling skipped/.test(event.message))).toBe(true);
    // Byte-for-byte the same index, built with the sources no longer present.
    expect(byteStable(digestTree(config2.outputDir))).toEqual(byteStable(reference));
    expect(resumed.objects.map((object) => object.key)).toEqual(first.objects.map((object) => object.key));
    expect(stableObjects(resumed.objects)).toEqual(stableObjects(first.objects));
  }, 120_000);
});

/* -------------------------------------------------------------------------- */

describe("posting deduplication", () => {
  let dir: string;

  beforeAll(() => {
    dir = join(tmpdir(), `ci-dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Every company here has several aliases that share their leading letters, so one
   * company genuinely produces the same `(kind, term)` pair more than once: "alias" is
   * a prefix of all of its variants, and "aaaa"-style trigrams repeat inside one name.
   */
  const NAMES = ["Alias Holdings Limited", "Alias Holdings Private Limited", "Alias Holdings Ltd", "Alias Holdings Inc."];

  test("a term repeated by two aliases of one company is emitted once", async () => {
    const source = join(dir, "aliases.csv");
    const rows = ["Company Name,Company Domain,Industry,Country,City,Contact Name,Job Title,Email,Phone"];
    for (const [index, name] of NAMES.entries()) {
      rows.push(`"${name}",alias-${index}.example,Software,India,Pune,"Person ${index}",CTO,p${index}@alias-${index}.example,`);
    }
    writeFileSync(source, `${rows.join("\n")}\n`, "utf8");

    const result = await runIndex(
      {
        datasetVersion: "dedupe-v1",
        sources: [{ id: "csv1", path: source }],
        workDir: join(dir, "work"),
        outputDir: join(dir, "out"),
        partitions: 2,
        // One shard per kind: every term of every company lands in the same file.
        shards: { exact: 1, prefix: 1, token: 1, trigram: 1, ids: 1 },
      },
      {},
    );
    expect(result.manifest.validationPassed).toBe(true);

    const shards = readShards(join(dir, "out"), "dedupe-v1");
    const prefix = shards.find(({ kind }) => kind === "prefix")!;
    // "alias" is a prefix of all four variants AND of "alias holdings", so it is the
    // term most likely to carry a duplicate ref.
    const alias = prefix.payload.terms.alias;
    expect(alias).toBeDefined();
    expect(alias.refs).toHaveLength(NAMES.length);
    expect(new Set(alias.refs).size).toBe(NAMES.length);
    for (const [term, entry] of Object.entries(prefix.payload.terms)) {
      expect({ term, refs: new Set(entry.refs).size }).toEqual({ term, refs: entry.refs.length });
    }

    /*
     * …and the deduplication is actually doing work, measured exactly.
     *
     * The count below is what a straightforward "one posting per variant, per kind"
     * enumeration would emit for these same companies: every variant contributes one
     * exact posting, one per prefix (up to the reader's ceiling) and one per trigram
     * (` ${variant} ` has exactly `variant.length` of them), plus one token posting per
     * distinct token, plus the id postings. With the deduplication removed, `appends`
     * would equal this number; it must therefore be strictly smaller.
     */
    const { byRef } = readCompanies(join(dir, "out"), "dedupe-v1");
    let naive = 0;
    for (const company of byRef.values()) {
      for (const variant of [company.normalizedName, ...(company.aliases ?? [])]) {
        naive += 1 + Math.min(SHARDING.maxPrefixLength, variant.length) + variant.length;
      }
      naive += new Set(company.normalizedName.split(" ")).size;
      naive += 1 + company.contactCount; // ids: the company plus each of its contacts
    }
    expect(byRef.size).toBe(NAMES.length);
    expect(naive).toBeGreaterThan(result.shardWrite.appends);
    expect(naive - result.shardWrite.appends).toBeGreaterThan(NAMES.length);
  }, 120_000);
});

/* -------------------------------------------------------------------------- */

describe("pass-2 progress reporting", () => {
  let dir: string;
  let config: IndexerConfig;
  /** Every event of the very first (fresh) run, for the pass-1-side assertions. */
  let freshEvents: ProgressEvent[] = [];

  beforeAll(() => {
    dir = join(tmpdir(), `ci-progress-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const files = writeCorpus(join(dir, "raw"));
    config = {
      datasetVersion: "progress-v1",
      sources: [
        { id: "csv1", path: files.csv1 },
        { id: "csv2", path: files.csv2 },
      ],
      workDir: join(dir, "work"),
      outputDir: join(dir, "out"),
      partitions: PARTITIONS,
      shards: SHARDS,
    };
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Run the indexer and capture every progress event it emits. */
  async function run(overrides: Partial<IndexerConfig> = {}) {
    const events: ProgressEvent[] = [];
    const result = await runIndex({ ...config, ...overrides }, { onProgress: (event) => events.push(event) });
    const completions = events.filter((event) => event.stage === "pass2-merge" && /^pass 2: \d+\/\d+ partitions ·/.test(event.message));
    return { result, events, completions };
  }

  test("reports completed partitions, counters, throughput and an ETA after every partition", async () => {
    const { result, events, completions } = await run();
    freshEvents = events;
    expect(result.resumed).toBe(false); // the first run of this work directory
    expect(completions).toHaveLength(PARTITIONS);

    // The defect: after finishing partition 1 the old line reported `fileIndex / 16`
    // = 0%, which reads as "nothing is happening". It must be 1/16.
    expect(completions[0].progress).toBeCloseTo(1 / PARTITIONS, 10);
    expect(completions[0].message).toContain(`pass 2: 1/${PARTITIONS} partitions`);
    expect(completions[0].message).not.toContain("0%");

    let previous = 0;
    let previousCompanies = 0;
    let previousContacts = 0;
    for (const [index, event] of completions.entries()) {
      expect(event.progress).toBeCloseTo((index + 1) / PARTITIONS, 10);
      expect(event.progress!).toBeGreaterThan(previous);
      previous = event.progress!;
      // Counters are cumulative and never jump backwards between partitions.
      expect(event.companies).toBeGreaterThanOrEqual(previousCompanies);
      expect(event.contacts).toBeGreaterThanOrEqual(previousContacts);
      previousCompanies = event.companies;
      previousContacts = event.contacts;
      // Elapsed time, throughput and ETA are all in the line an operator reads.
      expect(event.message).toContain("companies/s");
      expect(event.message).toContain("ETA");
      expect(event.message).toContain("this partition");
    }
    expect(completions[completions.length - 1].progress).toBe(1);
    expect(completions[completions.length - 1].etaSeconds).toBe(0);
    // The final event carries the run's real counters, not an approximation.
    expect(completions[completions.length - 1].companies).toBe(result.counters.uniqueCompanies);
    expect(completions[completions.length - 1].contacts).toBe(result.counters.uniqueContacts);
    expect(completions[completions.length - 1].etaSeconds).toBe(0);
  }, 120_000);

  test("announces the restart and what it reset", async () => {
    // The previous test already built the spool with the same work directory, so this
    // run reuses it — and must say so, including that pass 2 replays from partition 1
    // rather than pretending to resume mid-way.
    const resumed = await run();
    expect(resumed.result.resumed).toBe(true);
    expect(resumed.events.some((event) => /reusing the Pass 1 spool/.test(event.message))).toBe(true);
    expect(
      resumed.events.some((event) => new RegExp(`restarting at partition 1 of ${PARTITIONS} on the preserved Pass 1 spool`).test(event.message)),
    ).toBe(true);
    expect(resumed.events.some((event) => /verified the recorded length of all \d+ spool partitions/.test(event.message))).toBe(true);
    // No pass 1, and no source profiling: neither the spool nor the mapping is rebuilt.
    expect(resumed.events.some((event) => /^pass 1: /.test(event.message))).toBe(false);
    expect(resumed.events.some((event) => /profiling skipped/.test(event.message))).toBe(true);
    expect(resumed.events.some((event) => /^profiled /.test(event.message))).toBe(false);

    // A run that does build the spool says that instead.
    expect(freshEvents.some((event) => /pass 1: spooled/.test(event.message))).toBe(true);
    expect(freshEvents.some((event) => /^profiled csv1:/.test(event.message))).toBe(true);
    expect(freshEvents.some((event) => /reusing the Pass 1 spool/.test(event.message))).toBe(false);
  }, 120_000);

  test("classifies working, slow and stalled steps in plain language", () => {
    const average = 8_000;
    // A normal step says nothing extra.
    expect(pass2StepNotes({ partitionMs: 400, rows: average, averageRows: average })).toEqual([]);

    // A slow step caused by size says so, and that it is expected — not a stall.
    const skewed = pass2StepNotes({ partitionMs: 20_000, rows: 24_000, averageRows: average });
    expect(skewed).toHaveLength(1);
    expect(skewed[0]).toContain("3.0x");
    expect(skewed[0]).toContain("not a stall");

    // A slow step with an average-sized partition points at I/O instead.
    const slow = pass2StepNotes({ partitionMs: 20_000, rows: average, averageRows: average });
    expect(slow[0]).toContain("I/O contention");

    // A big partition is flagged before it ever crosses the slow threshold, because
    // the merge's cost grows with the partition's row count.
    const large = pass2StepNotes({ partitionMs: 3_000, rows: 40_000, averageRows: average });
    expect(large[0]).toContain("5.0x the average");

    // Past the stall threshold the message stops hedging and points at the volume.
    const stalled = pass2StepNotes({ partitionMs: 130_000, rows: average, averageRows: average });
    expect(stalled[0]).toContain("treat it as a stall");
    expect(stalled[0]).toContain("check the volume");
  });
});
