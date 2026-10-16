#!/usr/bin/env node
/**
 * Benchmark the **real R2-backed search path**.
 *
 * Unlike `benchmark-search.mjs` (which measures the engine against an in-memory
 * index), this loads index objects the way the bucket holds them — gzipped
 * shards, versioned keys — and answers queries through the same code the Worker
 * runs: `R2Store` + `R2CandidateSource` + the shared engine.
 *
 *   # against the built-in two-schema fixture (works anywhere)
 *   bun scripts/benchmark-r2-path.mjs
 *
 *   # against an index you generated locally (sample or full run)
 *   bun scripts/benchmark-r2-path.mjs --output-dir .indexer-output --version v1-sample-100k
 *
 * Reported per query class: median/p95 latency, R2 GET count, bytes read, and
 * how many candidates were retrieved per stage. It also reports the index size,
 * object count and mean object size, which is what the storage cost estimate in
 * docs/cost.md is based on.
 *
 * NOTE: these are local measurements. Latency excludes network time to Cloudflare
 * and CPU accounting is Bun's, not workerd's — use `wrangler tail` on a real
 * deployment for authoritative Worker CPU numbers.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const outputDir = flag("output-dir");
const repeat = Number(flag("repeat", 5));
const jsonOut = Boolean(flag("json"));

const { FakeR2Bucket } = await import("../tests/helpers/fake-r2.ts");
const { R2Store } = await import("../worker/src/store.ts");
const { R2CandidateSource } = await import("../worker/src/search-source.ts");
const { searchCompanies } = await import("../src/shared/search/engine.ts");
const { activeManifestKey } = await import("../src/shared/search/index-format.ts");

let version;
let files;
let loadRoot;

if (outputDir) {
  version = typeof flag("version") === "string" ? flag("version") : "v1";
  loadRoot = outputDir;
  files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(loadRoot, path).split(sep).join("/"));
    }
  };
  walk(loadRoot);
  // Only index objects belong in the bucket; skip the local validation log.
  files = files.filter((file) => !file.endsWith("objects.jsonl"));
  console.log(`Index source: ${loadRoot} (version ${version}, ${files.length} objects)\n`);
} else {
  const { buildFixtureDataset } = await import("../tests/helpers/fixture-dataset.ts");
  const fixture = await buildFixtureDataset();
  version = fixture.version;
  loadRoot = fixture.outputDir;
  files = fixture.result.objects.map((object) => object.key);
  console.log("Index source: built-in two-schema fixture (run the indexer for real numbers)\n");
}

/* --------------------------------- load ---------------------------------- */

const bucket = new FakeR2Bucket();
bucket.loadObjects(loadRoot, files);
bucket.putBytes(activeManifestKey(), Buffer.from(JSON.stringify({ version, previousVersion: null }), "utf8"));

let totalBytes = 0;
let largest = { key: "", bytes: 0 };
for (const object of bucket.objects.values()) {
  totalBytes += object.bytes.length;
  if (object.bytes.length > largest.bytes) largest = { key: "", bytes: object.bytes.length };
}
const indexFiles = files.filter((file) => file.startsWith("indexes/"));
const indexBytes = indexFiles.reduce((sum, file) => sum + (bucket.getObject(file)?.bytes.length ?? 0), 0);

const store = new R2Store(bucket);
const directory = await store.getDirectory(version);
if (!directory) {
  console.error(`No indexes/${version}/directory.json in ${loadRoot}. Point --output-dir at a completed run.`);
  process.exitCode = 1;
  process.exit();
}

/**
 * A fresh candidate source per query — exactly what the Worker does, because
 * `requireDataset` builds one per request. The source memoises hydrated profile
 * objects *for its own search*; reusing one instance across iterations would
 * report warm numbers and hide the cold-query cost this script exists to measure.
 */
const source = () => new R2CandidateSource(store, directory);
const options = { pageSize: 25, resultBudget: 400, retrievalBudget: 3000 };

/* -------------------------------- queries -------------------------------- */

const QUERIES = [
  ["exact", "Microsoft Corporation"],
  ["alias/legal suffix", "Infosys Ltd"],
  ["short prefix", "micro"],
  ["typo (1 char)", "Microsft"],
  ["transposition", "Mircosoft"],
  ["multi-token", "international business machines"],
  ["no result", "zzzzzzqqqqq"],
];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

// Warm-up: the directory and first shards are read on the first call, exactly as
// an isolate warms up in production.
for (const [, query] of QUERIES) await searchCompanies(source(), query, options);

const rows = [];
for (const [label, query] of QUERIES) {
  const times = [];
  let gets = 0;
  let bytes = 0;
  let retrieval = null;
  const keys = new Set();
  for (let i = 0; i < repeat; i += 1) {
    bucket.resetCounters();
    const started = performance.now();
    const response = await searchCompanies(source(), query, options);
    times.push(performance.now() - started);
    gets = Math.max(gets, bucket.counters.gets);
    // Reads are cached by the isolate, so report the *cold* byte volume too.
    bytes = Math.max(bytes, bucket.counters.bytesRead);
    retrieval = response.retrieval;
    for (const key of bucket.counters.readKeys) keys.add(key);
  }
  times.sort((a, b) => a - b);
  rows.push({
    label,
    query,
    medianMs: Number(percentile(times, 50).toFixed(2)),
    p95Ms: Number(percentile(times, 95).toFixed(2)),
    r2Gets: gets,
    bytesRead: bytes,
    distinctKeys: keys.size,
    grandTotalMs: Number(times.reduce((sum, value) => sum + value, 0).toFixed(1)),
    retrieval,
  });
}

const report = {
  version,
  objects: files.length,
  indexObjects: indexFiles.length,
  totalBytes,
  indexBytes,
  meanObjectBytes: Math.round(totalBytes / Math.max(1, files.length)),
  companies: directory.counts.companies,
  contacts: directory.counts.contacts,
  shards: directory.shards,
  queries: rows,
};

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `index: ${files.length} objects · ${indexFiles.length} index objects · ${(totalBytes / 1024).toFixed(1)} KB total · ` +
      `${(indexBytes / 1024).toFixed(1)} KB index · ${directory.counts.companies} companies · ${directory.counts.contacts} contacts\n`,
  );
  console.log("query class        median      p95   R2 GETs  bytes read  scored  query");
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(18)}${`${row.medianMs} ms`.padStart(8)}${`${row.p95Ms} ms`.padStart(9)}` +
        `${String(row.r2Gets).padStart(9)}${String(row.bytesRead).padStart(12)}${String(row.retrieval?.scored ?? 0).padStart(8)}  ${row.query}`,
    );
  }
  const worst = rows.reduce((max, row) => (row.p95Ms > max.p95Ms ? row : max), rows[0]);
  console.log(`\nworst p95: ${worst.p95Ms} ms (${worst.label})`);
  console.log(
    "\nNote: reads repeat inside one isolate, so `R2 GETs` is the cold-start count per query class;\n" +
      "the byte column is the largest read volume observed. Cache hit rates are measured in the browser\n" +
      "(Settings → cache) and in production via Worker analytics, not here.",
  );
}
