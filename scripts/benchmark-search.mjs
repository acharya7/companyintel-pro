#!/usr/bin/env node
/**
 * CompanyIntel search benchmark + relevance harness.
 *
 * TWO MODES, REPORTED SEPARATELY ON PURPOSE:
 *
 *   SYNTHETIC (default) — a generated corpus, no index files required:
 *     bun scripts/benchmark-search.mjs                         # 50,000 synthetic companies
 *     bun scripts/benchmark-search.mjs --companies 200000
 *
 *   REAL DATA — the index a local indexer run actually wrote:
 *     bun scripts/benchmark-search.mjs --index-dir .indexer-output --version v1-bench-1m
 *     bun scripts/benchmark-search.mjs --index-dir .indexer-output            # newest version
 *
 * Synthetic numbers answer "did the ranking logic change" and are reproducible
 * anywhere. Real-data numbers answer "what does this cost and return on the
 * dataset we ship", and are the only ones that can justify a completeness or
 * relevance claim — so the mode is printed in the header, in every report, and in
 * the JSON, and the two are never averaged together.
 *
 * What it measures, on the SAME engine the Worker and the app use
 * (`src/shared/search/engine.ts`):
 *
 *   - latency per query class (exact, variant, abbreviation, prefix, 1-typo,
 *     2-typo, transposition, multi-token, no-result);
 *   - candidate counts per retrieval stage, how many candidates the CPU budget
 *     truncated, how many hydration sweeps ran, and whether the partition budget
 *     was what limited the answer;
 *   - labelled relevance quality against tests/fixtures RELEVANCE_CASES
 *     (recall@1, recall@5, false positives on "no match" queries) — synthetic
 *     mode: the labelled set is the fixture corpus;
 *   - R2 objects/bytes per query and the isolate cache's hit rate (real mode);
 *   - the noise probe: exactly which companies a nonsense query returns, from
 *     which stage, with which score — the evidence behind "should this query
 *     return anything at all".
 *
 * `--index-dir` runs against the in-memory R2 binding, so read counts and bytes
 * are real object reads of the real index. Milliseconds are Bun's on a dev
 * machine, not workerd's, and exclude network time to Cloudflare.
 */

import { fixtureCompanies, RELEVANCE_CASES } from "../tests/fixtures/companies.ts";
import { LocalCandidateSource } from "../src/shared/search/local-index.ts";
import { searchCompanies } from "../src/shared/search/engine.ts";
import { SHARDING } from "../src/shared/search/index-format.ts";
import { loadLocalIndex, explainQuery } from "./lib/local-index-bench.mjs";

/* ---------------------------------- args --------------------------------- */

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const companyTarget = Number(flag("companies", 50_000));
const repeat = Number(flag("repeat", 5));
const warmup = Number(flag("warmup", 1));
const indexDir = flag("index-dir", null);
const version = flag("version", null);
const jsonOut = Boolean(flag("json"));
const realMode = Boolean(indexDir);

/** The query a user types when nothing should match. */
const NOISE_QUERY = "zzzzzzqqqqq";

/** Query classes used for latency reporting (label, query). */
const LATENCY_QUERIES = [
  ["exact", "Microsoft Corporation"],
  ["variant", "Infosys Ltd"],
  ["abbreviation", "ibm"],
  ["prefix-short", "tat"],
  ["typo-1", "Microsft"],
  ["typo-2", "Gooogle"],
  ["transposition", "Mircosoft"],
  ["multi-token", "international business machines"],
  ["word-split", "Total Energies"],
  ["generic", "global technology"],
  ["no-result", NOISE_QUERY],
];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/* ------------------------------ synthetic corpus -------------------------- */

const STEMS = ["North", "Vertex", "Aurora", "Cobalt", "Summit", "Harbor", "Nimbus", "Granite", "Lumen", "Cedar", "Orbit", "Pioneer", "Silver", "Quartz", "Meridian", "Atlas", "Vista", "Zenith", "Delta", "Everest", "Kestrel", "Juniper"];
const WORDS = ["Systems", "Analytics", "Logistics", "Healthcare", "Industries", "Technologies", "Consulting", "Manufacturing", "Networks", "Energy", "Foods", "Motors", "Pharma", "Retail", "Capital", "Textiles", "Infrastructure", "Software"];
const SUFFIXES = ["Limited", "Private Limited", "Ltd", "Inc.", "Corporation", "LLC", "GmbH", "PLC", "Pvt Ltd", "Group"];
const INDUSTRIES = ["Software", "IT Services", "Manufacturing", "Banking", "Healthcare", "Logistics", "Energy", "Retail", "Telecom", "Consulting", "Automotive", "Pharmaceuticals"];
const PLACES = [
  { country: "India", cities: ["Mumbai", "Bengaluru", "Pune", "Delhi", "Chennai"] },
  { country: "United States", cities: ["Austin", "Seattle", "Boston", "Denver", "Chicago"] },
  { country: "United Kingdom", cities: ["London", "Manchester", "Leeds"] },
  { country: "Germany", cities: ["Munich", "Hamburg", "Berlin"] },
  { country: "Singapore", cities: ["Singapore"] },
  { country: "Japan", cities: ["Tokyo", "Osaka"] },
];

function rngFactory(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function buildCorpus(target) {
  const companies = [...fixtureCompanies()];
  const rng = rngFactory(20261015);
  const seen = new Set(companies.map((company) => company.domain));
  let attempts = 0;
  while (companies.length < target) {
    attempts += 1;
    const brand = rng() > 0.5 ? `${STEMS[Math.floor(rng() * STEMS.length)]}${STEMS[Math.floor(rng() * STEMS.length)]}` : STEMS[Math.floor(rng() * STEMS.length)];
    const middle = rng() > 0.4 ? ` ${WORDS[Math.floor(rng() * WORDS.length)]}` : "";
    const name = `${brand} ${WORDS[Math.floor(rng() * WORDS.length)]}${middle} ${SUFFIXES[Math.floor(rng() * SUFFIXES.length)]}`;
    const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 28)}-${companies.length}.example`;
    if (seen.has(domain)) continue;
    seen.add(domain);
    if (attempts > target * 4) break;
    const place = PLACES[Math.floor(rng() * PLACES.length)];
    companies.push({
      id: `company_${companies.length}`,
      name,
      normalizedName: name.toLowerCase().replace(/\b(limited|ltd|inc|llc|gmbh|plc|corporation|group|private|pvt)\b/g, "").replace(/\s+/g, " ").trim(),
      domain,
      website: `https://${domain}`,
      industry: INDUSTRIES[Math.floor(rng() * INDUSTRIES.length)],
      country: place.country,
      city: place.cities[Math.floor(rng() * place.cities.length)],
      contactCount: 1 + Math.floor(rng() * 240),
      sources: [{ source: rng() > 0.5 ? "csv2" : "csv1", row: companies.length + 1 }],
    });
  }
  return companies;
}

/* ----------------------------------- run ---------------------------------- */

const BUDGET_OPTIONS = { pageSize: 25, resultBudget: SHARDING.maxScored, retrievalBudget: 3000, fuzzy: true };

let mode;
let source;
let store = null;
let countObjects = null;
let clearCache = () => {};
let resetCounters = () => {};
let model;

if (realMode) {
  let loaded;
  try {
    loaded = await loadLocalIndex({ outputDir: String(indexDir), version: version === true ? null : version });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const { R2Store } = await import("../worker/src/store.ts");
  const { R2CandidateSource } = await import("../worker/src/search-source.ts");
  const { ObjectCache } = await import("../worker/src/search-cache.ts");
  // A cache is installed so the benchmark can report the isolate cache's hit
  // rate; it is the same bounded cache the Worker uses.
  const cache = new ObjectCache();
  store = new R2Store(loaded.bucket, { cache });
  source = new R2CandidateSource(store, loaded.directory);
  clearCache = () => cache.clear();
  resetCounters = () => loaded.bucket.resetCounters();
  countObjects = () => ({ objects: loaded.bucket.counters.gets, bytes: loaded.bucket.counters.bytesRead, cacheHits: cache.stats().hits });
  mode = {
    kind: "real",
    indexDir: String(indexDir),
    version: loaded.version,
    companies: loaded.directory.counts.companies,
    contacts: loaded.directory.counts.contacts,
    formatVersion: loaded.directory.formatVersion,
    shards: loaded.directory.shards,
    objects: loaded.files,
    bytes: loaded.bytes,
  };
  model = { indexBuildMs: null, indexHeapMb: null };
} else {
  const corpus = buildCorpus(companyTarget);
  const buildStart = Date.now();
  source = new LocalCandidateSource(corpus, "benchmark");
  model = { indexBuildMs: Date.now() - buildStart, indexHeapMb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)) };
  mode = { kind: "synthetic", companies: corpus.length, contacts: null, sharding: SHARDING };
}

for (let i = 0; i < warmup; i += 1) {
  for (const [, query] of LATENCY_QUERIES) await searchCompanies(source, query, BUDGET_OPTIONS);
}

const latency = new Map();
for (const [label, query] of LATENCY_QUERIES) {
  const samples = [];
  let last = null;
  let objects = 0;
  let bytes = 0;
  let cacheHits = 0;
  let coldObjects = null;
  let coldBytes = null;
  let coldMs = null;
  for (let i = 0; i < repeat; i += 1) {
    source.beginSearch?.();
    // A cold measurement first: an empty cache is the worst case for a query, and
    // averaging it away with warm reads would hide the number an operator cares
    // about. Every later repeat runs warm and reports what the cache saved.
    if (countObjects && i === 0) {
      clearCache();
      resetCounters();
      const coldStarted = performance.now();
      await searchCompanies(source, query, BUDGET_OPTIONS);
      coldMs = performance.now() - coldStarted;
      coldObjects = countObjects().objects;
      coldBytes = countObjects().bytes;
      source.beginSearch?.();
    }
    const started = performance.now();
    if (countObjects) resetCounters();
    const response = await searchCompanies(source, query, BUDGET_OPTIONS);
    samples.push(performance.now() - started);
    last = response;
    if (countObjects) {
      const counted = countObjects();
      objects += counted.objects;
      bytes += counted.bytes;
      cacheHits += counted.cacheHits;
    }
  }
  samples.sort((a, b) => a - b);
  latency.set(label, {
    query,
    median: percentile(samples, 50),
    p95: percentile(samples, 95),
    coldMs,
    retrieval: last.retrieval,
    hits: last.hits.length,
    total: last.page.total,
    totalIsLowerBound: last.page.totalIsLowerBound,
    notice: last.notice,
    objects: countObjects ? Math.round(objects / repeat) : null,
    bytes: countObjects ? Math.round(bytes / repeat) : null,
    coldObjects,
    coldBytes,
  });
}

/* ------------------------------ relevance set ----------------------------- */

let recall1 = 0;
let recall5 = 0;
let falsePositives = 0;
let expectedCases = 0;
let skippedLabelCases = 0;
const noMatchCases = [];
const relevanceDetail = [];
for (const testCase of RELEVANCE_CASES) {
  // The labelled expectations assert exact company names from the fixture corpus
  // ("Microsoft Corporation"). A real dataset names its records differently
  // ("Microsoft"), so scoring those labels against it would measure the label
  // set, not the engine — and reporting a low recall from it would be a false
  // alarm. Only the name-independent check survives: a query that must return
  // NOTHING is evaluated on both corpora, because that claim does not depend on
  // how the data happens to be spelled.
  if (realMode && testCase.expect !== null) {
    skippedLabelCases += 1;
    continue;
  }
  source.beginSearch?.();
  const response = await searchCompanies(source, testCase.query, BUDGET_OPTIONS);
  if (testCase.expect === null) {
    noMatchCases.push({
      query: testCase.query,
      hits: response.hits.length,
      confident: response.hits.filter((hit) => !hit.possibleMatch).length,
      note: testCase.note,
    });
    if (response.hits.length > 0) falsePositives += 1;
    continue;
  }
  expectedCases += 1;
  const names = response.hits.map((hit) => hit.name);
  const top = names[0];
  const rank = names.indexOf(testCase.expect);
  const pass1 = top === testCase.expect;
  const pass5 = rank > -1 && rank < 5;
  if (pass1) recall1 += 1;
  if (pass5) recall5 += 1;
  relevanceDetail.push({ query: testCase.query, expected: testCase.expect, top: top ?? null, rank, pass1, pass5, note: testCase.note });
}

/* ------------------------------ noise probe ------------------------------- */

/**
 * What a nonsense query actually returns.
 *
 * Two things have to be reported separately and honestly: the hits the API would
 * show, and the retrieval evidence behind them. On a synthetic corpus of clean
 * generated names there should be none; against a real 1 M index the interesting
 * question is *which* names came back and from which stage, which is what the
 * attribution below answers — it is evidence, not a verdict, and if the names are
 * junk records in the source data no scoring rule can fix that.
 */
let noise;
if (realMode) {
  const explained = await explainQuery({ store, directory: source.directory, query: NOISE_QUERY });
  noise = {
    query: NOISE_QUERY,
    stageCounts: explained.stageCounts,
    candidates: explained.candidates,
    minScore: explained.minScore,
    candidates_detail: explained.rows.slice(0, 25).map((row) => ({
      stage: row.stage,
      term: row.term,
      name: row.name,
      score: row.score,
      passesThreshold: row.passesThreshold,
      coverage: row.coverage,
      gate: row.gate,
    })),
    hits: explained.engine.hits.map((hit) => ({ name: hit.name, relevance: hit.relevance, category: hit.matchCategory })),
    notice: explained.engine.notice,
  };
} else {
  const response = await searchCompanies(source, NOISE_QUERY, BUDGET_OPTIONS);
  noise = {
    query: NOISE_QUERY,
    stageCounts: {
      exact: response.retrieval.exact,
      prefix: response.retrieval.prefix,
      token: response.retrieval.token,
      trigram: response.retrieval.trigram,
    },
    candidates: response.retrieval.candidates,
    hits: response.hits.map((hit) => ({ name: hit.name, relevance: hit.relevance, category: hit.matchCategory })),
    notice: response.notice,
  };
}

/* --------------------------------- report -------------------------------- */

const report = {
  mode: mode.kind,
  dataset: mode,
  corpus: { ...model },
  latency: Object.fromEntries(
    [...latency].map(([label, value]) => [
      label,
      {
        query: value.query,
        medianMs: Number(value.median.toFixed(2)),
        p95Ms: Number(value.p95.toFixed(2)),
        candidates: value.retrieval,
        hits: value.hits,
        total: value.total,
        totalIsLowerBound: value.totalIsLowerBound,
        notice: value.notice,
        objects: value.objects,
        bytes: value.bytes,
      },
    ]),
  ),
  relevance: {
    cases: RELEVANCE_CASES.length,
    withExpectedMatch: expectedCases,
    labelledCasesSkipped: skippedLabelCases,
    recallAt1: Number((recall1 / Math.max(1, expectedCases)).toFixed(3)),
    recallAt5: Number((recall5 / Math.max(1, expectedCases)).toFixed(3)),
    falsePositivesOnNoMatch: falsePositives,
    noMatchCases,
  },
  noise,
};

if (jsonOut) {
  console.log(JSON.stringify({ report, relevanceDetail }, null, 2));
  process.exit(0);
}

console.log(`CompanyIntel search benchmark — ${mode.kind === "real" ? "REAL DATA" : "SYNTHETIC"}`);
if (mode.kind === "real") {
  console.log(
    `index ${mode.indexDir} @ ${mode.version} · ${mode.companies.toLocaleString()} companies · ` +
      `${mode.contacts.toLocaleString()} contacts · format v${mode.formatVersion} · ${mode.objects.toLocaleString()} objects (${(mode.bytes / 1024 / 1024).toFixed(1)} MB)`,
  );
} else {
  console.log(`${mode.companies.toLocaleString()} synthetic companies · index build ${model.indexBuildMs} ms · heap after build ${model.indexHeapMb} MB`);
}
console.log(
  "note: synthetic numbers show ranking behaviour; only the real-data numbers speak to this dataset's relevance and cost.\n",
);

if (countObjects) {
  console.log(
    "query class        median      p95     exact prefix token tri  candidates trunc  sweeps  scored   hits   cold objs  cold KB  warm objs  warm KB  query",
  );
} else {
  console.log("query class        median      p95     exact prefix token tri  candidates trunc  sweeps  scored   hits  query");
}
for (const [label, value] of latency) {
  const r = value.retrieval ?? {};
  let row =
    `${label.padEnd(16)} ${`${value.median.toFixed(2)} ms`.padStart(9)} ${`${value.p95.toFixed(2)} ms`.padStart(8)}` +
    `${String(r.exact ?? 0).padStart(7)}${String(r.prefix ?? 0).padStart(7)}${String(r.token ?? 0).padStart(6)}${String(r.trigram ?? 0).padStart(5)}` +
    `${String(r.candidates ?? 0).padStart(12)}${String(r.truncated ?? 0).padStart(6)}${String(r.hydrationPasses ?? 0).padStart(8)}${String(r.scored ?? 0).padStart(8)}` +
    `${String(value.hits).padStart(7)}`;
  if (countObjects) {
    row +=
      `${String(value.coldObjects ?? "-").padStart(11)}${String(Math.round((value.coldBytes ?? 0) / 1024)).padStart(9)}` +
      `${String(value.objects ?? "-").padStart(11)}${String(Math.round((value.bytes ?? 0) / 1024)).padStart(9)}`;
  }
  console.log(`${row}  ${value.query}`);
  if (value.notice && label !== "no-result") console.log(`${" ".repeat(16)}  notice: ${value.notice}`);
}
console.log(`\nworst-case partition budget modelled for one query: ${SHARDING.maxHydrate} (${SHARDING.companiesPerPartition} companies each)`);

if (realMode) {
  console.log(
    `\nno-match queries: false positives ${report.relevance.falsePositivesOnNoMatch} of ${noMatchCases.length} ` +
      `(the ${skippedLabelCases} labelled expectations are fixture-specific company names and are NOT scored against real data)`,
  );
} else {
  console.log(
    `\nlabelled relevance: recall@1 ${report.relevance.recallAt1} · recall@5 ${report.relevance.recallAt5} · ` +
      `false positives on "no match" queries ${report.relevance.falsePositivesOnNoMatch}`,
  );
}
const misses = relevanceDetail.filter((row) => !row.pass1);
if (misses.length) {
  console.log("\ncases where the expected company was not ranked first:");
  for (const miss of misses) console.log(`  ${miss.query} → ${miss.top} (expected ${miss.expected}; ${miss.note})`);
}

console.log(`\nnoise probe — "${noise.query}"`);
console.log(`  candidates by stage: exact ${noise.stageCounts.exact} prefix ${noise.stageCounts.prefix} token ${noise.stageCounts.token} trigram ${noise.stageCounts.trigram} (${noise.candidates} unique)`);
if (noise.candidates_detail) {
  console.log("  candidate attribution (stage · term · name · score · passes threshold · coverage · gate):");
  if (!noise.candidates_detail.length) console.log("    (no candidate was retrieved at all)");
  for (const row of noise.candidates_detail) {
    console.log(
      `    ${String(row.stage).padEnd(7)} ${String(row.term ?? "-").slice(0, 12).padEnd(12)} ${String(row.name).slice(0, 40).padEnd(40)} ` +
        `${String(row.score ?? "-").padStart(5)} ${(row.passesThreshold ? "pass" : "drop").padStart(5)} ${String(row.coverage ?? "-").padStart(8)} ${row.gate ?? "-"}`,
    );
  }
}
console.log(`  hits the API would show (${noise.hits.length}):`);
if (!noise.hits.length) console.log("    (none — the query returns an explicit empty result)");
for (const hit of noise.hits) console.log(`    ${String(hit.relevance).padStart(5)}  ${hit.category.padEnd(8)} ${hit.name}`);
if (noise.notice) console.log(`  notice: ${noise.notice}`);
console.log(
  "\nA nonsense query returning rows is a data-or-scoring question, not a ranking one: the attribution above says\n" +
    "which stage produced each candidate and what it scored. See docs/search-quality.md for the measured finding.",
);
console.log("(reference: docs/architecture.md, docs/cost.md, docs/search-quality.md)");
