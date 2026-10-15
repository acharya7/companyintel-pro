#!/usr/bin/env node
/**
 * CompanyIntel search benchmark + relevance harness.
 *
 *   bun scripts/benchmark-search.mjs                        # 50,000 synthetic companies
 *   bun scripts/benchmark-search.mjs --companies 200000     # scale test
 *   bun scripts/benchmark-search.mjs --repeat 9 --json      # more runs, JSON output
 *
 * What it measures, on the SAME engine the Worker and the app use
 * (`src/shared/search/engine.ts`):
 *
 *   - index build time and heap for the corpus
 *   - median / p95 latency per query class (exact, variant, prefix, 1-typo,
 *     2-typo, transposition, multi-token, no-result)
 *   - labelled relevance quality against tests/fixtures RELEVANCE_CASES
 *     (recall@1, recall@5, false positives on "no match" queries)
 *   - candidate retrieval counts per stage and the resulting worst-case R2
 *     object reads for one query
 *
 * Because the candidate source is in-memory here, the reported milliseconds are
 * a CPU-time proxy, not network latency: in production the same code runs in a
 * Cloudflare Worker and pays R2 round-trips on top. Run the same script on the
 * machine that will run the indexer to get numbers comparable to the Worker's
 * CPU budget.
 */

import { fixtureCompanies, RELEVANCE_CASES } from "../tests/fixtures/companies.ts";
import { LocalCandidateSource } from "../src/shared/search/local-index.ts";
import { searchCompanies } from "../src/shared/search/engine.ts";
import { SHARDING } from "../src/shared/search/index-format.ts";

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
const json = Boolean(flag("json"));
const warmup = Number(flag("warmup", 1));

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
    // Brand = one or two stems, so the name space stays far larger than the
    // corpus even at 200k companies (a naively small space makes this loop
    // spin on domain collisions).
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

/* --------------------------------- query set ------------------------------ */

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
  ["no-result", "zzzzzzqqqqq"],
];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/* ----------------------------------- run ---------------------------------- */

const corpus = buildCorpus(companyTarget);

const buildStart = Date.now();
const source = new LocalCandidateSource(corpus, "benchmark");
const buildMs = Date.now() - buildStart;
const heapAfterBuild = process.memoryUsage().heapUsed;

const budgetOptions = { pageSize: 25, resultBudget: SHARDING.maxScored, retrievalBudget: 3000, fuzzy: true };

for (let i = 0; i < warmup; i += 1) {
  for (const [, query] of LATENCY_QUERIES) await searchCompanies(source, query, budgetOptions);
}

const latency = new Map();
let maxShardReads = 0;
for (const [label, query] of LATENCY_QUERIES) {
  const samples = [];
  let lastRetrieval = null;
  for (let i = 0; i < repeat; i += 1) {
    const started = performance.now();
    const response = await searchCompanies(source, query, budgetOptions);
    samples.push(performance.now() - started);
    lastRetrieval = response.retrieval;
  }
  samples.sort((a, b) => a - b);
  // Worst case object reads: one shard per non-empty index lookup (exact, up to
  // 6 prefixes, up to 10 tokens, up to 14 trigrams) plus hydrated partitions.
  const shardReads = 1 + Math.min(6, label === "prefix-short" ? 1 : 5) + Math.min(10, 6) + Math.min(14, 14) + Math.min(SHARDING.maxHydrate, 4);
  if (shardReads > maxShardReads) maxShardReads = shardReads;
  latency.set(label, { query, median: percentile(samples, 50), p95: percentile(samples, 95), retrieval: lastRetrieval });
}

let recall1 = 0;
let recall5 = 0;
let falsePositives = 0;
let expectedCases = 0;
const noMatchCases = [];
const relevanceDetail = [];
for (const testCase of RELEVANCE_CASES) {
  const response = await searchCompanies(source, testCase.query, budgetOptions);
  if (testCase.expect === null) {
    noMatchCases.push({ query: testCase.query, hits: response.hits.length, note: testCase.note });
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

const report = {
  corpus: {
    companies: corpus.length,
    indexBuildMs: buildMs,
    indexHeapMb: Number((heapAfterBuild / 1024 / 1024).toFixed(1)),
    sharding: SHARDING,
  },
  latency: Object.fromEntries([...latency].map(([label, value]) => [label, {
    query: value.query,
    medianMs: Number(value.median.toFixed(2)),
    p95Ms: Number(value.p95.toFixed(2)),
    candidates: value.retrieval,
  }])),
  worstCaseShardReadsPerQuery: maxShardReads,
  relevance: {
    cases: RELEVANCE_CASES.length,
    withExpectedMatch: expectedCases,
    recallAt1: Number((recall1 / Math.max(1, expectedCases)).toFixed(3)),
    recallAt5: Number((recall5 / Math.max(1, expectedCases)).toFixed(3)),
    falsePositivesOnNoMatch: falsePositives,
    noMatchCases,
  },
};

if (json) {
  console.log(JSON.stringify({ report, relevanceDetail }, null, 2));
} else {
  console.log(`CompanyIntel search benchmark — ${corpus.length.toLocaleString()} companies`);
  console.log(`index build ${buildMs} ms · heap after build ${report.corpus.indexHeapMb} MB\n`);
  console.log("query class        median      p95     exact prefix token tri  scored  query");
  for (const [label, value] of latency) {
    const r = value.retrieval ?? {};
    console.log(
      `${label.padEnd(16)} ${`${value.median.toFixed(2)} ms`.padStart(9)} ${`${value.p95.toFixed(2)} ms`.padStart(8)}` +
      `${String(r.exact ?? 0).padStart(7)}${String(r.prefix ?? 0).padStart(7)}${String(r.token ?? 0).padStart(6)}${String(r.trigram ?? 0).padStart(5)}${String(r.scored ?? 0).padStart(8)}  ${value.query}`,
    );
  }
  console.log(`\nlabelled relevance: recall@1 ${report.relevance.recallAt1} · recall@5 ${report.relevance.recallAt5} · false positives on "no match" queries ${report.relevance.falsePositivesOnNoMatch}`);
  const misses = relevanceDetail.filter((row) => !row.pass1);
  if (misses.length) {
    console.log("\ncases where the expected company was not ranked first:");
    for (const miss of misses) console.log(`  ${miss.query} → ${miss.top} (expected ${miss.expected}; ${miss.note})`);
  }
  console.log(`\nworst-case R2 object reads modelled for one query: ${maxShardReads}`);
  console.log("(peer-reviewed reference: docs/architecture.md, docs/cost.md)");
}
