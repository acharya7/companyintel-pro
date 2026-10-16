#!/usr/bin/env node
/**
 * CompanyIntel pass-2 (merge) benchmark.
 *
 *   bun scripts/benchmark-pass2.mjs                              # 20,000 synthetic companies
 *   bun scripts/benchmark-pass2.mjs --rows 50000 --repeat 3
 *   bun scripts/benchmark-pass2.mjs --json
 *   bun scripts/benchmark-pass2.mjs --fs-count                   # count file handles opened
 *   bun scripts/benchmark-pass2.mjs --config tools/indexer/indexer.config.json \
 *       --version v1-bench-1m --sample 1000000 --output-dir .indexer-output-bench
 *
 * WHY IT EXISTS
 * -------------
 * Pass 1 is network and parse bound; pass 2 is *file-system* bound (one posting
 * line per term per company, spread over the whole shard skeleton). That second
 * half is what made the 1 M benchmark look stalled, and it cannot be measured
 * through the Worker-side search benchmarks or by a unit test's wall clock.
 *
 * The synthetic corpus is deliberately shaped like the real one: one company row
 * plus one contact row per company, with the real config's partition count and
 * shard skeleton (5 kinds, 1,792 shard files by default). It is small enough to
 * run in under a minute and large enough to show the per-posting cost.
 *
 * WHAT IT REPORTS
 * ---------------
 *   - pass 1 (build the spool) once, so a resumed pass 2 has something to merge;
 *   - pass 2 replayed from that preserved Pass 1 spool, `--repeat` times, into a
 *     fresh output directory each time, reporting merge / finalize / validate
 *     milliseconds and companies per second;
 *   - the shard writer's own counters (posting lines, shard files opened, flushes,
 *     peak buffered bytes) whenever the build reports them, so the "one append per
 *     shard per flush instead of one stream per posting" claim is a measurement;
 *   - with `--fs-count`, every `createWriteStream` / `openSync` / `writeSync` /
 *     `closeSync` call the run makes, counted by wrapping node:fs before the
 *     indexer is imported. That is how the old and new writers are compared on the
 *     same corpus.
 *
 * `--config` mode measures the *real* preserved spool instead: it reuses pass 1
 * (no R2 read at all) and merges into the output directory you name, which must
 * NOT be the one a normal run uses unless you mean to rewrite it.
 *
 * Unit note: these are seconds on THIS machine, not on yours. Run it on the
 * machine that runs the indexer.
 */

import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `node:fs` is loaded through `require` on purpose: this module must NOT have a
// static `node:fs` import, because that settles the module's binding table before
// `--fs-count` can wrap it (verified: with a static import the wrappers are never
// called, without one they are).
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const { mkdtempSync, rmSync, writeFileSync } = fs;
const { readFile } = require("node:fs/promises");

/* ---------------------------------- args ---------------------------------- */

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const configPath = flag("config");
const rows = Number(flag("rows", 20_000));
const partitions = Number(flag("partitions", 256));
const repeat = Number(flag("repeat", 1));
const json = Boolean(flag("json"));
const fsCount = Boolean(flag("fs-count"));
const version = flag("version", "pass2-bench");
const sample = flag("sample") ? Number(flag("sample")) : undefined;

/**
 * The real config's shard skeleton. 5 kinds × (512+256+256+512+256) = 1,792 shard
 * files, which is what the per-posting writer had to churn through.
 */
const SHARDS = { exact: 512, prefix: 256, token: 256, trigram: 512, ids: 256 };

/* ------------------------- optional fs instrumentation --------------------- */

const fsCounts = { createWriteStream: 0, openSync: 0, writeSync: 0, closeSync: 0 };
if (fsCount) {
  // The CommonJS exports object is what `import { x } from "node:fs"` resolves
  // against, so the wrappers below are the functions the indexer calls. (Patching
  // the module *namespace* does not work: its properties are bound per import.)
  for (const name of Object.keys(fsCounts)) {
    const real = fs[name];
    if (typeof real !== "function") continue;
    fs[name] = function counted(...args) {
      fsCounts[name] += 1;
      return real.apply(fs, args);
    };
  }
}

// Imported AFTER the instrumentation is installed, so the indexer's named imports
// resolve to the counting wrappers.
const { runIndex } = await import("../tools/indexer/src/build.ts");

/* ------------------------------- the corpus -------------------------------- */

const STEMS = ["North", "Vertex", "Aurora", "Cobalt", "Summit", "Harbor", "Nimbus", "Granite", "Lumen", "Cedar", "Orbit", "Pioneer", "Silver", "Quartz", "Meridian", "Atlas", "Vista", "Zenith", "Delta", "Everest", "Kestrel", "Juniper"];
const WORDS = ["Systems", "Analytics", "Logistics", "Healthcare", "Industries", "Technologies", "Consulting", "Manufacturing", "Networks", "Energy", "Foods", "Motors", "Pharma", "Retail", "Capital", "Textiles"];
const SUFFIXES = ["Limited", "Private Limited", "Ltd", "Inc.", "Corporation", "LLC", "GmbH", "PLC", "Pvt Ltd", "Group"];
const INDUSTRIES = ["Software", "IT Services", "Manufacturing", "Banking", "Healthcare", "Logistics", "Energy", "Retail"];
const PLACES = [
  ["India", "Mumbai"],
  ["United States", "Austin"],
  ["United Kingdom", "London"],
  ["Germany", "Munich"],
  ["Singapore", "Singapore"],
  ["Japan", "Tokyo"],
];

const HEADERS = ["Company Name", "Company Domain", "Industry", "Country", "City", "Full Name", "Job Title", "Email", "LinkedIn URL"];

function writeCorpus(path) {
  const lines = [HEADERS.join(",")];
  for (let i = 0; i < rows; i += 1) {
    const name = `${STEMS[i % STEMS.length]} ${WORDS[(i * 7) % WORDS.length]} ${SUFFIXES[i % SUFFIXES.length]} ${i}`;
    const [country, city] = PLACES[i % PLACES.length];
    lines.push(
      [
        `"${name}"`,
        `company-${i}.example`,
        INDUSTRIES[i % INDUSTRIES.length],
        country,
        city,
        `"Person ${i}"`,
        "Chief Technology Officer",
        `person.${i}@company-${i}.example`,
        `https://linkedin.com/in/person-${i}`,
      ].join(","),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

/* --------------------------------- the run --------------------------------- */

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const report = { mode: null, corpus: {}, runs: [], fsCounts: null };

const zeroFsCounts = () => {
  for (const key of Object.keys(fsCounts)) fsCounts[key] = 0;
};  let root = null;
  let exitCode = 0;
  try {
    let config;
    let replayDirs = [];
    let coldRun = true;


  if (configPath) {
    const outputDir = flag("output-dir");
    if (!outputDir) {
      console.error(
        "--config needs --output-dir: this mode merges the preserved Pass 1 spool, and a benchmark must not\n" +
          "  silently rewrite the output directory a normal run writes to.",
      );
      process.exit(2);
    }
    const parsed = JSON.parse(await readFile(resolve(String(configPath)), "utf8"));
    config = {
      ...parsed,
      datasetVersion: typeof version === "string" ? version : parsed.datasetVersion,
      workDir: resolve(parsed.workDir),
      outputDir: resolve(String(outputDir)),
    };
    report.mode = "resume-preserved-spool";
    report.corpus = { config: resolve(String(configPath)), workDir: config.workDir, outputDir: config.outputDir, sample: sample ?? null };
    replayDirs = [config.outputDir];
    // The spool already exists: there is no pass 1 to run.
    coldRun = false;
  } else {
    root = mkdtempSync(join(tmpdir(), "companyintel-pass2-"));
    const csvPath = join(root, "source.csv");
    writeCorpus(csvPath);
    config = {
      datasetVersion: typeof version === "string" ? version : "pass2-bench",
      sources: [{ id: "csv1", path: csvPath }],
      workDir: join(root, "work"),
      outputDir: join(root, "out-0"),
      partitions,
      shards: SHARDS,
    };
    report.mode = "synthetic";
    report.corpus = { rows, partitions, shards: SHARDS, csv: csvPath };
    replayDirs = Array.from({ length: Math.max(1, repeat) }, (_, index) => join(root, `out-${index + 1}`));
  }

  // Pass 1 — build the spool once, so every replay below reuses it exactly as a
  // resumed real run does (no source read at all).
  if (coldRun) {
    const first = await runIndex({ ...config, outputDir: join(root, "out-pass1") }, { sampleLimit: sample });
    report.runs.push({
      label: "pass 1 + pass 2 (cold)",
      stages: first.stages,
      companies: first.counters.uniqueCompanies,
      contacts: first.counters.uniqueContacts,
      outputBytes: first.outputBytes,
      objects: first.objects.length,
    });
  }

  for (const [index, outputDir] of replayDirs.entries()) {
    // A replay always starts from an empty shard directory: the writer appends, so
    // a leftover `.lines` file from a previous attempt would be counted twice. The
    // current build resets it itself; doing it here too keeps the numbers
    // comparable with builds that do not.
    rmSync(join(config.workDir, "shards"), { recursive: true, force: true });
    zeroFsCounts();
    const started = Date.now();
    const resumed = await runIndex({ ...config, outputDir }, { sampleLimit: sample });
    const wallMs = Date.now() - started;
    report.runs.push({
      label: replayDirs.length > 1 ? `pass 2 replay #${index + 1}` : "pass 2 replay (preserved spool)",
      stages: resumed.stages,
      companies: resumed.counters.uniqueCompanies,
      contacts: resumed.counters.uniqueContacts,
      companiesPerSecond: resumed.stages.pass2Ms > 0 ? Math.round(resumed.counters.uniqueCompanies / (resumed.stages.pass2Ms / 1000)) : null,
      wallMs,
      outputBytes: resumed.outputBytes,
      objects: resumed.objects.length,
      shardWrite: resumed.shardWrite ?? null,
      resumed: resumed.resumed,
    });
  }
  report.fsCounts = fsCount ? { ...fsCounts } : null;
} catch (error) {
  exitCode = 1;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (root) rmSync(root, { recursive: true, force: true });
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("\nPass-2 benchmark");
  console.log(`  mode              ${report.mode}`);
  if (report.corpus?.rows) console.log(`  corpus            ${rows.toLocaleString()} companies, ${partitions} partitions, ${Object.values(SHARDS).reduce((a, b) => a + b, 0)} shards`);
  else console.log(`  corpus            preserved Pass 1 spool in ${report.corpus?.workDir}`);
  for (const run of report.runs) {
    const stages = run.stages ?? {};
    console.log(`\n  ${run.label}`);
    if (stages.pass1Ms) console.log(`    pass 1          ${seconds(stages.pass1Ms)}`);
    console.log(`    pass 2 merge    ${seconds(stages.pass2Ms ?? 0)}${run.companiesPerSecond ? `  (${run.companiesPerSecond.toLocaleString()} companies/s)` : ""}`);
    console.log(`    finalize+index  ${seconds(stages.finalizeMs ?? 0)}`);
    console.log(`    validate        ${seconds(stages.validateMs ?? 0)}`);
    console.log(`    companies       ${(run.companies ?? 0).toLocaleString()}  contacts ${(run.contacts ?? 0).toLocaleString()}  objects ${run.objects}`);
    if (run.shardWrite) {
      const stats = run.shardWrite;
      console.log(`    postings        ${stats.appends.toLocaleString()} lines, ${stats.bytes ? `${(stats.bytes / 1e9).toFixed(2)} GB` : ""}`);
      console.log(`    shard appends   ${stats.fileOpens.toLocaleString()} file open(s) in ${stats.flushes.toLocaleString()} flush(es)  (${(stats.appends / Math.max(1, stats.fileOpens)).toFixed(1)} lines per open)`);
      console.log(`    peak buffer     ${(stats.peakBufferedBytes / 1e6).toFixed(2)} MB buffered, at most ${stats.peakOpenHandles} open handle(s)`);
    }
  }
  if (report.fsCounts) {
    console.log("\n  file-system calls during the last replay");
    for (const [key, value] of Object.entries(report.fsCounts)) console.log(`    ${key.padEnd(18)} ${value.toLocaleString()}`);
  }
  if (report.error) console.log(`\n  ERROR ${report.error}`);
  console.log("");
}
process.exitCode = exitCode;
