#!/usr/bin/env node
/**
 * Measure the *completeness* cost of the per-search hydration budget.
 *
 * The Worker reads at most `maxHydrate` company-profile partitions per search
 * (16 by default). Broad queries spread their candidates over more partitions
 * than that, so the first pass can run out of budget before the requested page
 * is full — the trade-off the previous report flagged as "some broad searches
 * return fewer matches".
 *
 * This script answers it with numbers instead of opinion:
 *
 *   - it loads an index a real indexer run produced (default: the real-data dry
 *     run in `.indexer-output`), and
 *   - it runs the same queries through the same code the Worker runs —
 *     `R2Store` + `R2CandidateSource` + the shared engine — under several
 *     hydration strategies, including a *reference* run with an effectively
 *     unlimited budget (the complete answer the index can give), and
 *   - it reports, per strategy and per query: rows returned, rows lost against
 *     the reference, how many of the reference's top-25 rows survive, R2 GETs
 *     and bytes read.
 *
 *   bun scripts/benchmark-hydration.mjs
 *   bun scripts/benchmark-hydration.mjs --output-dir .indexer-output --version v1-dry5-250
 *   bun scripts/benchmark-hydration.mjs --json
 *
 * NOTE: local numbers. Latency and CPU here are Bun's on a dev machine, not
 * workerd's, and they exclude network time to Cloudflare.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const outputDir = flag("output-dir", ".indexer-output");
const version = flag("version", "v1-dry5-250");
const repeat = Number(flag("repeat", 3));
const jsonOut = Boolean(flag("json"));

const { FakeR2Bucket } = await import("../tests/helpers/fake-r2.ts");
const { R2Store } = await import("../worker/src/store.ts");
const { R2CandidateSource } = await import("../worker/src/search-source.ts");
const { searchCompanies } = await import("../src/shared/search/engine.ts");
const { activeManifestKey } = await import("../src/shared/search/index-format.ts");

/* --------------------------------- load ---------------------------------- */

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(relative(outputDir, path).split(sep).join("/"));
  }
})(outputDir);

const bucket = new FakeR2Bucket();
bucket.loadObjects(
  outputDir,
  files.filter((file) => !file.endsWith("objects.jsonl")),
);
bucket.putBytes(activeManifestKey(), Buffer.from(JSON.stringify({ version, previousVersion: null }), "utf8"));

const store = new R2Store(bucket);
const directory = await store.getDirectory(version);
if (!directory) {
  console.error(`No indexes/${version}/directory.json under ${outputDir}. Run the indexer first.`);
  process.exit(1);
}
console.log(
  `Index: ${outputDir} @ ${version} · ${directory.counts.companies} companies · ` +
    `${directory.shards.companyPartitions} company partitions · format v${directory.formatVersion}\n`,
);

/* -------------------------------- queries -------------------------------- */
// Deliberately broad / ambiguous: these are the queries whose candidates spread
// over more partitions than the default budget can read.
const QUERIES = [
  ["single common token", "global"],
  ["single common token 2", "services"],
  ["two generic tokens", "global technology"],
  ["short prefix", "in"],
  ["industry word", "consulting"],
  ["exact name", "Microsoft"],
  ["name fragment", "solutions group"],
  ["no result", "zzzzzzqqqqq"],
];

const BASE = { pageSize: 25, resultBudget: 400, retrievalBudget: 3000 };
const STRATEGIES = [
  { label: "fixed 16 (old default)", options: { maxHydrate: 16, adaptiveHydration: false } },
  { label: "fixed 32", options: { maxHydrate: 32, adaptiveHydration: false } },
  { label: "fixed 64", options: { maxHydrate: 64, adaptiveHydration: false } },
  { label: "adaptive 16→32 (new default)", options: { maxHydrate: 16, adaptiveHydration: true } },
  // Reference: every partition the index has, so nothing is cap-limited.
  { label: "reference (all partitions)", options: { maxHydrate: 4096, adaptiveHydration: true }, reference: true },
];

const source = () => new R2CandidateSource(store, directory);

async function run(query, options) {
  bucket.resetCounters();
  const started = performance.now();
  const response = await searchCompanies(source(), query, { ...BASE, ...options });
  const elapsed = performance.now() - started;
  return {
    ids: response.hits.map((hit) => hit.id),
    rows: response.hits.length,
    total: response.total,
    totalIsLowerBound: response.totalIsLowerBound ?? false,
    gets: bucket.counters.gets,
    bytes: bucket.counters.bytesRead,
    scored: response.retrieval?.scored ?? 0,
    elapsed,
  };
}

// Warm-up: the directory and the first shards are read once per isolate, as in
// production.
for (const [, query] of QUERIES) await run(query, { maxHydrate: 16 });

const results = [];
for (const [label, query] of QUERIES) {
  const perStrategy = {};
  for (const strategy of STRATEGIES) {
    let best = null;
    for (let i = 0; i < Math.max(1, strategy.reference ? 1 : repeat); i += 1) {
      const measured = await run(query, strategy.options);
      // Report the cheapest run of the repeats: read caching only ever makes a
      // rerun cheaper, so this is the floor the strategy can achieve.
      if (!best || measured.bytes < best.bytes) best = measured;
    }
    perStrategy[strategy.label] = best;
  }
  const reference = perStrategy["reference (all partitions)"];
  const referenceIds = new Set(reference.ids);
  for (const [name, value] of Object.entries(perStrategy)) {
    value.top25Kept = value.ids.filter((id) => referenceIds.has(id)).length;
    value.rowsLost = reference.rows - value.rows;
  }
  results.push({ label, query, reference, perStrategy });
}

/* -------------------------------- report --------------------------------- */

const summary = STRATEGIES.map((strategy) => {
  const runs = results.map((row) => row.perStrategy[strategy.label]);
  return {
    strategy: strategy.label,
    rows: runs.reduce((sum, run) => sum + run.rows, 0),
    rowsLost: runs.reduce((sum, run) => sum + run.rowsLost, 0),
    top25Kept: runs.reduce((sum, run) => sum + run.top25Kept, 0),
    top25Possible: results.reduce((sum, row) => sum + Math.min(25, row.reference.rows), 0),
    gets: Math.max(...runs.map((run) => run.gets)),
    meanBytes: Math.round(runs.reduce((sum, run) => sum + run.bytes, 0) / runs.length),
    worstBytes: Math.max(...runs.map((run) => run.bytes)),
    meanMs: Number((runs.reduce((sum, run) => sum + run.elapsed, 0) / runs.length).toFixed(1)),
  };
});

if (jsonOut) {
  console.log(JSON.stringify({ version, directory: directory.counts, shards: directory.shards, summary, results }, null, 2));
  process.exit(0);
}

console.log("strategy                        rows  lost  top25   mean bytes  worst bytes  R2 GETs  mean ms");
for (const row of summary) {
  console.log(
    row.strategy.padEnd(30) +
      String(row.rows).padStart(6) +
      String(row.rowsLost).padStart(6) +
      `${row.top25Kept}/${row.top25Possible}`.padStart(8) +
      row.meanBytes.toLocaleString().padStart(13) +
      row.worstBytes.toLocaleString().padStart(13) +
      String(row.gets).padStart(9) +
      String(row.meanMs).padStart(9),
  );
}

const columnLabels = STRATEGIES.map((strategy) =>
  strategy.reference ? "ref" : `${strategy.options.maxHydrate}${strategy.options.adaptiveHydration ? "+ad" : ""}`,
);

function table(title, cellOf) {
  console.log(`\n${title}`);
  console.log("query class".padEnd(22) + "query".padEnd(22) + columnLabels.map((label) => label.padStart(9)).join(""));
  for (const row of results) {
    const cells = STRATEGIES.map((strategy) => cellOf(row.perStrategy[strategy.label]).padStart(9));
    console.log(row.label.padEnd(22) + row.query.padEnd(22) + cells.join(""));
  }
}

table("Rows returned per query (reference = the complete answer the index holds):", (value) =>
  `${value.rows}${value.rowsLost > 0 ? `(-${value.rowsLost})` : ""}`,
);
table("R2 bytes read per query (KB):", (value) => `${Math.round(value.bytes / 1024)}`);

table("Company buckets scored per query:", (value) => String(value.scored));

const base = summary[0];
console.log(
  `\nadaptive vs the old fixed-16 default: ${base.rowsLost - summary[3].rowsLost} fewer rows lost, ` +
    `${Math.round((summary[3].meanBytes - base.meanBytes) / 1024)} KB more read per query on average, ` +
    `${summary[3].meanMs - base.meanMs > 0 ? "+" : ""}${(summary[3].meanMs - base.meanMs).toFixed(1)} ms.`,
);
console.log(
  "\nrowsLost counts rows the reference returns and the strategy does not; top25 is how many of the\n" +
    "reference's top 25 rows the strategy also returned. A strategy that reads more bytes than the\n" +
    "reference on a query it does not improve is paying for a retry that found nothing.",
);
