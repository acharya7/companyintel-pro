/**
 * Shared helpers for the *real-data* search scripts.
 *
 * `benchmark-hydration.mjs`, `benchmark-search.mjs` (with `--index-dir`) and
 * `explain-query.mjs` all need the same three things: load a locally generated
 * index into the in-memory R2 binding the Worker uses, run the shared engine over
 * it, and attribute every candidate to the retrieval stage that produced it.
 *
 * They used to each carry their own copy of the loader; keeping it here means a
 * change to the layout (or to the metric definitions) cannot make one report
 * disagree with another.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { SHARDING } from "../../src/shared/search/index-format.ts";

/**
 * Load an indexer output directory as an R2 bucket plus a store.
 *
 * Mirrors what the Worker sees: only the objects the indexer uploads (the local
 * `objects.jsonl` log is left out), with `.gz` bodies carrying
 * `content-encoding: gzip`, plus the `manifests/active.json` pointer.
 */
export async function loadLocalIndex({ outputDir = ".indexer-output", version = null, cache = null } = {}) {
  const { FakeR2Bucket } = await import("../../tests/helpers/fake-r2.ts");
  const { R2Store } = await import("../../worker/src/store.ts");
  const { activeManifestKey } = await import("../../src/shared/search/index-format.ts");

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(outputDir, path).split(sep).join("/"));
    }
  };
  walk(outputDir);

  const bucket = new FakeR2Bucket();
  bucket.loadObjects(
    outputDir,
    files.filter((file) => !file.endsWith("objects.jsonl")),
  );

  const store = new R2Store(bucket, cache ? { cache } : {});
  const resolvedVersion = version ?? (await resolveVersion(store, files, activeManifestKey));
  if (!resolvedVersion) {
    throw new Error(`No index version found under ${outputDir}. Run the indexer first (see docs/indexing.md).`);
  }
  bucket.putBytes(
    activeManifestKey(),
    Buffer.from(JSON.stringify({ version: resolvedVersion, previousVersion: null }), "utf8"),
  );

  const directory = await store.getDirectory(resolvedVersion);
  if (!directory) {
    throw new Error(`The directory for version ${resolvedVersion} is missing under ${outputDir}/indexes/.`);
  }
  let bytes = 0;
  for (const file of files) bytes += statSync(join(outputDir, file)).size;
  return { bucket, store, directory, version: resolvedVersion, files: files.length, bytes, outputDir };
}

/** Newest version that has a directory, or the `manifests/active.json` pointer. */
async function resolveVersion(store, files, activeManifestKey) {
  const active = await store.getJson(activeManifestKey());
  if (active?.version && files.includes(`indexes/${active.version}/directory.json`)) return active.version;
  const directories = files
    .filter((file) => file.startsWith("indexes/") && file.endsWith("/directory.json"))
    .map((file) => file.split("/")[1])
    .sort();
  return directories.length ? directories[directories.length - 1] : null;
}

/**
 * Attribute every candidate the four retrieval stages produced to the stage and
 * the exact index term that found it, and score it with the real scorer.
 *
 * This is the diagnostic the noise investigation needs: for a query that should
 * return nothing, it names *which* companies came back, from which stage, on
 * which term, and why the score passed (or failed) the query's threshold. It
 * deliberately drives the candidate source directly instead of the engine, so it
 * can show candidates the engine would have dropped — including the ones that
 * reveal a false positive.
 */
export async function explainQuery({ store, directory, query, options = {} }) {
  const { R2CandidateSource } = await import("../../worker/src/search-source.ts");
  const { searchCompanies, prepareQuery, prefixQueriesFor, tokenQueriesFor, trigramQueriesFor, SEARCH_LIMITS } =
    await import("../../src/shared/search/engine.ts");
  const { minScoreFor, scoreDoc } = await import("../../src/shared/search/score.ts");
  const { trigramSet } = await import("../../src/shared/search/similarity.ts");

  const prepared = prepareQuery(query);
  const retrievalBudget = options.retrievalBudget ?? SEARCH_LIMITS.defaultRetrievalBudget;
  const source = new R2CandidateSource(store, directory);
  source.beginSearch();

  const stats = await source.stats().catch(() => null);
  const df = stats?.df ?? null;
  const prefixQueries = prefixQueriesFor(prepared.normalizedQuery, prepared.variants);
  const tokenQueries = tokenQueriesFor(prepared.queryTokens, df);
  const gramQueries = trigramQueriesFor(prepared.grams, df);

  const stages = {
    exact: await source.exact(prepared.variants, retrievalBudget),
    prefix: await source.prefix(prefixQueries, retrievalBudget),
    token: tokenQueries.length ? await source.tokens(tokenQueries, retrievalBudget) : [],
    trigram: prepared.normalizedQuery.length >= 3 ? await source.trigrams(gramQueries, retrievalBudget) : [],
  };

  const seen = new Map();
  const order = ["exact", "prefix", "token", "trigram"];
  for (const stage of order) {
    for (const ref of stages[stage]) if (!seen.has(ref)) seen.set(ref, stage);
  }

  const refs = [...seen.keys()];
  // Hydration returns documents in its own score order, so the ref travels with
  // the document — that is the whole point of `docsWithRefs`. A candidate whose
  // partition the budget did not reach simply is not returned.
  const hydrated = refs.length
    ? await source.docsWithRefs(refs, { maxPartitions: options.maxHydrate ?? SHARDING.maxHydrate })
    : [];
  const minScore = minScoreFor(prepared.normalizedQuery.length);
  const queryTrigrams = trigramSet(prepared.normalizedQuery);

  const rows = [];
  for (const { ref, doc: resolved } of hydrated) {
    const evidence = source.stageEvidenceOf(ref);
    const scored = scoreDoc(resolved, {
      query: prepared.query,
      normalizedQuery: prepared.normalizedQuery,
      queryTokens: prepared.queryTokens,
      variants: prepared.variants,
      fuzzy: options.fuzzy ?? true,
      queryTrigrams,
    });
    rows.push({
      ref,
      stage: evidence?.kind ?? seen.get(ref) ?? "unknown",
      term: evidence?.term ?? null,
      name: resolved.name,
      domain: resolved.domain ?? null,
      contacts: resolved.contactCount,
      minScore,
      score: scored?.score ?? null,
      category: scored?.category ?? null,
      driver: scored?.driver ?? null,
      passesThreshold: scored ? scored.score >= minScore : false,
      coverage: scored?.detail.trigramCoverage ?? null,
      gate: scored?.detail.fuzzyGate ?? null,
      identityEvidence: scored?.detail.identityEvidence ?? 0,
      detail: scored?.detail ?? null,
    });
  }

  const unhydrated = refs.filter((ref) => !hydrated.some((pair) => pair.ref === ref));

  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (a.name < b.name ? -1 : 1));

  source.beginSearch();
  const engine = await searchCompanies(source, query, {
    pageSize: 25,
    resultBudget: options.resultBudget ?? SEARCH_LIMITS.defaultResultBudget,
    retrievalBudget,
    fuzzy: options.fuzzy ?? true,
    maxHydrate: options.maxHydrate,
    adaptiveHydration: options.adaptiveHydration,
  });

  return {
    query,
    prepared,
    terms: { prefixQueries, tokenQueries, trigramQueries: gramQueries },
    stageCounts: Object.fromEntries(order.map((stage) => [stage, stages[stage].length])),
    candidates: refs.length,
    hydratedCandidates: hydrated.length,
    unhydratedCandidates: unhydrated.length,
    minScore,
    rows,
    engine,
  };
}
