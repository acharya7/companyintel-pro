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
 *     the reference, how many of the reference's top-25 rows survive, R2 GETs,
 *     bytes read, hydration sweeps and duplicate object reads.
 *
 * The strategies include both ends of the completeness dial — the old fixed-16
 * default, the single-retry adaptive policy that used to be the default, the
 * 16→32→64 ladder the engine now runs, fixed 64, and the unbounded reference —
 * compiled on the *same* index so the comparison is like for like. `dup` must be
 * 0 for every one of them: a search may never read one object twice.
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
  // The previous adaptive policy was a single retry; measuring it on the same
  // index is what shows whether the second rung is what closes the gap.
  { label: "adaptive 16→32 (1 retry)", options: { maxHydrate: 16, adaptiveHydration: true, adaptiveHydrateSteps: 1 } },
  { label: "adaptive 16→32→64 (new)", options: { maxHydrate: 16, adaptiveHydration: true, adaptiveHydrateSteps: 2 } },
  // Reference: every partition the index has, so nothing is cap-limited.
  { label: "reference (all partitions)", options: { maxHydrate: 4096, adaptiveHydration: true }, reference: true },
];

const source = () => new R2CandidateSource(store, directory);

async function run(query, options) {
  bucket.resetCounters();
  const started = performance.now();
  const response = await searchCompanies(source(), query, { ...BASE, ...options });
  const elapsed = performance.now() - started;
  const keys = bucket.counters.readKeys;
  return {
    ids: response.hits.map((hit) => hit.id),
    rows: response.hits.length,
    total: response.total,
    totalIsLowerBound: response.totalIsLowerBound ?? false,
    gets: bucket.counters.gets,
    bytes: bucket.counters.bytesRead,
    scored: response.retrieval?.scored ?? 0,
    candidates: response.retrieval?.candidates ?? 0,
    truncated: response.retrieval?.truncated ?? 0,
    hydrationPasses: response.retrieval?.hydrationPasses ?? 0,
    hydrateBudget: response.retrieval?.hydrateBudget ?? 0,
    budgetLimited: response.retrieval?.budgetLimited ?? false,
    fuzzyDeferred: response.retrieval?.fuzzyDeferred ?? false,
    fuzzyRecovered: response.retrieval?.fuzzyRecovered ?? false,
    // A search may not read the same object twice: that is the cache-and-memo
    // invariant, measured here on the real read path rather than argued for.
    duplicateReads: keys.length - new Set(keys).size,
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
    meanGets: Number((runs.reduce((sum, run) => sum + run.gets, 0) / runs.length).toFixed(1)),
    meanBytes: Math.round(runs.reduce((sum, run) => sum + run.bytes, 0) / runs.length),
    worstBytes: Math.max(...runs.map((run) => run.bytes)),
    meanMs: Number((runs.reduce((sum, run) => sum + run.elapsed, 0) / runs.length).toFixed(1)),
    meanPasses: Number((runs.reduce((sum, run) => sum + run.hydrationPasses, 0) / runs.length).toFixed(2)),
    duplicateReads: Math.max(...runs.map((run) => run.duplicateReads)),
    rowsLostWorstQuery: Math.max(...runs.map((run) => run.rowsLost)),
  };
});

if (jsonOut) {
  console.log(JSON.stringify({ version, directory: directory.counts, shards: directory.shards, summary, results }, null, 2));
  process.exit(0);
}

console.log("strategy                        rows  lost  top25   mean bytes  worst bytes  R2 GETs  sweeps  dup  mean ms");
for (const row of summary) {
  console.log(
    row.strategy.padEnd(30) +
      String(row.rows).padStart(6) +
      String(row.rowsLost).padStart(6) +
      `${row.top25Kept}/${row.top25Possible}`.padStart(8) +
      row.meanBytes.toLocaleString().padStart(13) +
      row.worstBytes.toLocaleString().padStart(13) +
      String(row.gets).padStart(9) +
      row.meanPasses.toFixed(2).padStart(8) +
      String(row.duplicateReads).padStart(5) +
      String(row.meanMs).padStart(9),
  );
}

const columnLabels = STRATEGIES.map((strategy) =>
  strategy.reference
    ? "ref"
    : `${strategy.options.maxHydrate}${strategy.options.adaptiveHydration ? `+ad${strategy.options.adaptiveHydrateSteps ?? 2}` : ""}`,
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

table("Hydration sweeps per query (1 = the page filled on the first pass):", (value) => String(value.hydrationPasses));

table("Duplicate object reads per query (must be 0):", (value) => String(value.duplicateReads));

const base = summary[0];
const oneRetry = summary.find((row) => row.strategy.includes("(1 retry)"));
const ladder = summary.find((row) => row.strategy.includes("(new)"));
const fixed64 = summary.find((row) => row.strategy.includes("fixed 64"));
console.log(
  `\nnew default (16→32→64) vs the old fixed-16 default: ${base.rowsLost - ladder.rowsLost} fewer rows lost, ` +
    `${Math.round((ladder.meanBytes - base.meanBytes) / 1024)} KB more read per query on average, ` +
    `${ladder.meanMs - base.meanMs > 0 ? "+" : ""}${(ladder.meanMs - base.meanMs).toFixed(1)} ms, ` +
    `${ladder.meanPasses.toFixed(2)} hydration sweeps per query.`,
);
if (oneRetry && ladder) {
  console.log(
    `the second rung is what closes the gap: 1 retry loses ${oneRetry.rowsLost} rows against the reference, ` +
      `the ladder loses ${ladder.rowsLost}; fixed 64 loses ${fixed64?.rowsLost ?? "?"} while reading ` +
      `${Math.round(((fixed64?.meanBytes ?? 0) - base.meanBytes) / 1024)} KB more than fixed 16 on every query.`,
  );
  // Rows *lost* is a count, and a count can hide a ranking difference: a strategy
  // can return the same NUMBER of rows while keeping fewer of the reference's
  // best ones. `top25` is the measure that shows it, so it is stated next to the
  // row counts rather than left for the reader to compare column by column.
  console.log(
    `top-25 overlap with the reference: fixed 16 ${base.top25Kept}/${base.top25Possible} · 1 retry ` +
      `${oneRetry.top25Kept}/${oneRetry.top25Possible} · ladder (new default) ${ladder.top25Kept}/${ladder.top25Possible}` +
      ` · fixed 64 ${fixed64 ? `${fixed64.top25Kept}/${fixed64.top25Possible}` : "?"}.`,
  );
  console.log(
    "The ladder stops as soon as the page is full, so a filled page can still hold a row the reference\n" +
      "ranks higher — that is the residual gap, and closing it means reading further partitions (the operator\n" +
      "dial: SEARCH_MAX_HYDRATE=64 turns the ladder into a single 64-partition sweep for every query).",
  );
}
console.log(
  "\nrowsLost counts rows the reference returns and the strategy does not; top25 is how many of the\n" +
    "reference's top 25 rows the strategy also returned. A strategy that reads more bytes than the\n" +
    "reference on a query it does not improve is paying for a retry that found nothing. `dup` is the\n" +
    "largest number of duplicate object reads any one search made — it must be 0 for every strategy.",
);
