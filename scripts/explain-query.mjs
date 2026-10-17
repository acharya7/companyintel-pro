#!/usr/bin/env node
/**
 * CompanyIntel — explain one search against a real local index (read-only).
 *
 *   bun run search:explain -- --query zzzzzzqqqqq
 *   bun run search:explain -- --query "global technology" --limit 40 --version v1-bench-1m
 *   bun run search:explain -- --query microsft --json
 *
 * Answers the questions a surprising result raises, for the *real* index, with
 * the *real* engine code:
 *
 *   - which companies came back, and from which retrieval stage and index term
 *     each one was found (exact / prefix / token / trigram);
 *   - what each candidate scored, whether that score passed the query's
 *     threshold, and — when a whole-string fuzzy score was withheld — which gate
 *     withheld it (short name vs low query trigram coverage);
 *   - what the search actually cost: candidates per stage, how many were dropped
 *     by the CPU budget, how many hydration sweeps ran, and the R2 objects and
 *     bytes the search fetched.
 *
 * It is read-only: it loads the local output directory into the in-memory R2
 * binding the Worker uses, and writes nothing.
 *
 * Exit codes: 0 = explanation produced; 1 = no index to explain against.
 */

import { loadLocalIndex, explainQuery } from "./lib/local-index-bench.mjs";

const argv = process.argv.slice(2);

function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const asJson = Boolean(flag("json"));
const outputDir = String(flag("output-dir", ".indexer-output"));
const version = flag("version", null);
const query = flag("query", null);
const limit = Math.max(1, Number(flag("limit", 50)) || 50);
const maxHydrate = flag("max-hydrate", null);

if (!query || query === true) {
  console.error('Usage: bun scripts/explain-query.mjs --query "<query>" [--output-dir .indexer-output] [--version v1-bench-1m] [--limit 50] [--json]');
  process.exit(1);
}

let index;
try {
  index = await loadLocalIndex({ outputDir, version: version === true ? null : version });
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const { bucket, store, directory, version: resolved } = index;
bucket.resetCounters();

const explained = await explainQuery({
  store,
  directory,
  query: String(query),
  options: { maxHydrate: maxHydrate === null || maxHydrate === true ? undefined : Number(maxHydrate) },
});

const r = explained.engine.retrieval;
const bytes = bucket.counters.bytesRead;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        version: resolved,
        outputDir,
        query: explained.query,
        normalizedQuery: explained.prepared.normalizedQuery,
        variants: explained.prepared.variants,
        terms: explained.terms,
        stageCounts: explained.stageCounts,
        candidates: explained.candidates,
        hydratedCandidates: explained.hydratedCandidates,
        unhydratedCandidates: explained.unhydratedCandidates,
        minScore: explained.minScore,
        engine: {
          retrieval: r,
          total: explained.engine.page.total,
          totalIsLowerBound: explained.engine.page.totalIsLowerBound,
          hasMore: explained.engine.page.hasMore,
          notice: explained.engine.notice,
          correctedQuery: explained.engine.correctedQuery,
          tookMs: explained.engine.tookMs,
        },
        r2: { objectsRead: bucket.counters.gets, bytesRead: bytes, readKeys: bucket.counters.readKeys },
        candidates_detail: explained.rows.slice(0, limit),
        hits: explained.engine.hits.map((hit) => ({
          name: hit.name,
          category: hit.matchCategory,
          relevance: hit.relevance,
          possibleMatch: hit.possibleMatch,
          domain: hit.domain ?? null,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`Query "${explained.query}" (normalized "${explained.prepared.normalizedQuery}") against ${outputDir} @ ${resolved}`);
console.log(`min score for this query length: ${explained.minScore}`);
console.log("");
console.log("Retrieval terms");
console.log(`  exact variants     ${explained.prepared.variants.join(", ") || "(none)"}`);
console.log(`  prefixes           ${explained.terms.prefixQueries.join(", ") || "(none)"}`);
console.log(`  tokens             ${explained.terms.tokenQueries.join(", ") || "(none)"}`);
console.log(`  trigrams           ${explained.terms.trigramQueries.join(", ") || "(none)"}`);
console.log("");
console.log("Candidates by stage (a candidate found by more than one stage is counted in each)");
for (const [stage, count] of Object.entries(explained.stageCounts)) console.log(`  ${stage.padEnd(8)} ${String(count).padStart(7)}`);
console.log(`  unique          ${String(explained.candidates).padStart(7)}`);
console.log(`  hydrated        ${String(explained.hydratedCandidates).padStart(7)}`);
console.log(`  not hydrated    ${String(explained.unhydratedCandidates).padStart(7)}   (partition budget)`);
console.log("");
console.log(`Candidate explanation (top ${Math.min(limit, explained.rows.length)} of ${explained.rows.length}, best score first)`);
console.log("  stage  term            score  min   ok  cat     coverage gate          evid  contacts  name");
for (const row of explained.rows.slice(0, limit)) {
  console.log(
    `  ${String(row.stage).padEnd(6)} ${String(row.term ?? "-").slice(0, 14).padEnd(14)} ` +
      `${String(row.score ?? "-").padStart(5)} ${String(row.minScore).padStart(5)} ` +
      `${(row.passesThreshold ? "yes" : "no").padStart(3)}  ${String(row.category ?? "-").padEnd(7)} ` +
      `${String(row.coverage ?? "-").padStart(8)} ${String(row.gate ?? "-").padEnd(13)} ` +
      `${String(row.identityEvidence).padStart(4)} ${String(row.contacts).padStart(9)}  ${row.name}${row.domain ? `  (${row.domain})` : ""}`,
  );
}
console.log("");
console.log("What the search itself did (same query, same engine, same budgets)");
console.log(`  exact ${r.exact}  prefix ${r.prefix}  token ${r.token}  trigram ${r.trigram}  scored ${r.scored}`);
console.log(`  candidates ${r.candidates}  truncated ${r.truncated}  hydrationPasses ${r.hydrationPasses}  hydrateBudget ${r.hydrateBudget}`);
console.log(`  budgetLimited ${r.budgetLimited}  fuzzyDeferred ${r.fuzzyDeferred}  fuzzyRecovered ${r.fuzzyRecovered}`);
if (r.ladderStopped) console.log(`  ladder stopped at ${r.hydrateBudget} partitions: a rung ranked nothing new`);
console.log(`  total ${explained.engine.page.total}${explained.engine.page.totalIsLowerBound ? " (lower bound)" : ""}  hasMore ${explained.engine.page.hasMore}  took ${explained.engine.tookMs} ms`);
if (explained.engine.notice) console.log(`  notice: ${explained.engine.notice}`);
console.log(`  R2 objects read ${bucket.counters.gets}  bytes ${bytes.toLocaleString()}`);
console.log("");
console.log("Returned hits");
for (const hit of explained.engine.hits) {
  console.log(`  ${String(hit.relevance).padStart(5)}  ${hit.matchCategory.padEnd(8)} ${hit.possibleMatch ? "possible " : "confident"}  ${hit.name}`);
}
if (!explained.engine.hits.length) console.log("  (none)");
