import { beforeAll, describe, expect, test } from "bun:test";
import { LocalCandidateSource } from "../src/shared/search/local-index";
import { buildSearchCacheKey, prepareQuery, searchCompanies } from "../src/shared/search/engine";
import { MIN_QUERY_TRIGRAM_COVERAGE, minScoreFor, scoreDoc } from "../src/shared/search/score";
import { normalizeName } from "../src/shared/normalize";
import { boundedLevenshtein, diceCoefficient, editSimilarity, trigramSet } from "../src/shared/search/similarity";
import { FIXTURE_COMPANIES, RELEVANCE_CASES, fixtureCompanies } from "./fixtures/companies";

let source: LocalCandidateSource;

beforeAll(() => {
  source = new LocalCandidateSource(fixtureCompanies(), "test-v1");
});

async function search(query: string, overrides: Parameters<typeof searchCompanies>[2] = {}) {
  return searchCompanies(source, query, { resultBudget: 200, retrievalBudget: 400, ...overrides });
}

describe("similarity primitives", () => {
  test("trigrams are padded", () => {
    expect(trigramSet("abc")).toEqual(new Set([" ab", "abc", "bc "]));
    expect(trigramSet("")).toEqual(new Set());
  });

  test("dice is symmetric and bounded", () => {
    const a = trigramSet("microsoft");
    const b = trigramSet("microsft");
    expect(diceCoefficient(a, b)).toBeCloseTo(diceCoefficient(b, a), 10);
    expect(diceCoefficient(a, b)).toBeGreaterThan(0.5);
    expect(diceCoefficient(a, trigramSet("zzzzzz"))).toBe(0);
  });

  test("bounded levenshtein exits early but stays exact within budget", () => {
    expect(boundedLevenshtein("microsft", "microsoft", 2)).toBe(1);
    expect(boundedLevenshtein("googel", "google", 3)).toBe(2);
    expect(boundedLevenshtein("abcdefg", "zzzzzzz", 2)).toBe(3);
    expect(boundedLevenshtein("", "abc", 5)).toBe(3);
  });

  test("edit similarity is normalized 0..1", () => {
    expect(editSimilarity("infosys", "infosys")).toBe(1);
    expect(editSimilarity("infosys", "zzzzzzz", 2)).toBe(0);
    expect(editSimilarity("microsft", "microsoft")).toBeGreaterThan(0.8);
  });
});

describe("index construction", () => {
  test("indexes the whole fixture", () => {
    expect(source.size).toBe(FIXTURE_COMPANIES.length);
  });

  test("stats report document frequency", async () => {
    const stats = await source.stats();
    expect(stats.docCount).toBe(FIXTURE_COMPANIES.length);
    expect(stats.df["tata"]).toBeGreaterThanOrEqual(3);
  });

  test("exact lookup works on normalized and alias forms", async () => {
    const refs = await source.exact(["infosys", "infosysltd"], 10);
    expect(refs.length).toBeGreaterThan(0);
  });

  test("company documents keep original names and normalized keys", async () => {
    const ref = source.refOfCompanyId(source.companyAt(0)!.id)!;
    const docs = await source.docs([ref]);
    expect(docs[0].name).toBe(source.companyAt(0)!.name);
    expect(docs[0].normalizedName).toBe(source.companyAt(0)!.normalizedName);
  });
});

describe("query preparation", () => {
  test("normalizes and derives variants + tokens", () => {
    const prepared = prepareQuery("  Infosys   Ltd ");
    expect(prepared.query).toBe("Infosys   Ltd");
    expect(prepared.normalizedQuery).toBe("infosys");
    expect(prepared.variants).toContain("infosys limited");
    expect(prepared.queryTokens).toEqual(["infosys"]);
  });
});

describe("scoring", () => {
  test("exact matches score 1 and are never flagged as possible", () => {
    const company = source.companyAt(source.refOfCompanyId(fixtureCompanies()[0].id)!)!;
    const prepared = prepareQuery(company.name);
    const result = scoreDoc(
      {
        id: company.id,
        name: company.name,
        normalizedName: company.normalizedName,
        aliases: company.aliases ?? [],
        tokens: prepared.queryTokens.concat(company.normalizedName.split(" ")),
        contactCount: company.contactCount,
      },
      { ...prepared, fuzzy: true },
    );
    expect(result!.score).toBe(1);
    expect(result!.category).toBe("exact");
    expect(result!.possibleMatch).toBe(false);
  });

  test("thresholds grow stricter for short queries", () => {
    expect(minScoreFor(2)).toBeGreaterThan(minScoreFor(10));
  });

  /*
   * The whole-string fuzzy gate, asserted at the scorer rather than through the
   * engine, because the failure it prevents is a *scoring* one: `0.85 × Dice` and
   * `0.9 × editSimilarity` are both normalized by length, so a 2–7 character name
   * is one edit from any short query and shares a couple of grams with a long
   * nonsense one. Every name below scored 0.378–0.680 against `zzzzzzqqqqq` under
   * the previous rule (threshold 0.36 at that length) and was therefore *shown*.
   */
  const junkNames = ["zz", "ZZP'er", "zzz", "zzzz", "zzzzz", "zzq", "qqq", "zzqq", "zzzzzz", "zzzzzzz", "Qqq"];

  function scorerDoc(name: string, domain?: string) {
    const normalizedName = normalizeName(name);
    return {
      id: `c_${normalizedName}`,
      name,
      normalizedName,
      aliases: [],
      tokens: normalizedName.split(" ").filter(Boolean),
      contactCount: 0,
      domain,
    };
  }

  test("a nonsense query does not score any short junk name", () => {
    const prepared = prepareQuery("zzzzzzqqqqq");
    for (const name of junkNames) {
      const result = scoreDoc(scorerDoc(name), { ...prepared, fuzzy: true });
      expect({ name, score: result?.score ?? 0 }).toEqual({ name, score: 0 });
      // When the gate is the only reason it did not score, it says which rule fired.
      if (result) expect(["short-name", "low-coverage"]).toContain(result.detail.fuzzyGate);
    }
  });

  test("the gate still lets a real typo through, with the score it had before", () => {
    const prepared = prepareQuery("Microsft");
    const result = scoreDoc(scorerDoc("Microsoft"), { ...prepared, fuzzy: true });
    expect(result).not.toBeNull();
    expect(result!.detail.fuzzyGate).toBe("ok");
    expect(result!.score).toBeGreaterThanOrEqual(minScoreFor(prepared.normalizedQuery.length));
    expect(result!.score).toBeGreaterThan(0.8);
  });

  test("the coverage gate withholds the whole-string term for a loosely related name", () => {
    const prepared = prepareQuery("global technology");
    const result = scoreDoc(scorerDoc("Global Solutions"), { ...prepared, fuzzy: true });
    // The shared *token* ("global") still matches, so this is not a null result...
    expect(result).not.toBeNull();
    // ...but the whole-string evidence is withheld, and the diagnostic says why.
    expect(result!.detail.fuzzyGate).toBe("low-coverage");
    expect(result!.detail.wholeScore).toBe(0);
    expect(result!.detail.trigramCoverage).toBeLessThan(MIN_QUERY_TRIGRAM_COVERAGE);
  });
});

describe("relevance evaluation set", () => {
  test("every labelled case behaves as expected", async () => {
    const failures: string[] = [];
    let top1Correct = 0;
    let expectedTotal = 0;
    let foundTotal = 0;
    let expectedFound = 0;

    for (const testCase of RELEVANCE_CASES) {
      const response = await search(testCase.query, { fuzzy: true });
      const top = response.hits[0];
      if (testCase.expect === null) {
        const confident = response.hits.filter((h) => !h.possibleMatch);
        if (confident.length > 0) {
          failures.push(`"${testCase.query}" (${testCase.note}) expected no confident match, got ${confident[0].name}`);
        }
        continue;
      }
      expectedTotal += 1;
      const names = response.hits.map((h) => h.name);
      if (names.includes(testCase.expect)) expectedFound += 1;
      foundTotal += response.hits.length;
      if (top?.name === testCase.expect) top1Correct += 1;
      else failures.push(`"${testCase.query}" (${testCase.note}) expected ${testCase.expect}, got ${top?.name ?? "no result"}`);
    }

    const precisionAt1 = top1Correct / expectedTotal;
    const recall = expectedFound / expectedTotal;

    // Reported so the numbers are visible in CI output, not just asserted.
    console.log(
      `[relevance] cases=${expectedTotal + (RELEVANCE_CASES.length - expectedTotal)} precision@1=${precisionAt1.toFixed(3)} ` +
        `recall=${recall.toFixed(3)} hitsReturned=${foundTotal}`,
    );
    if (failures.length) console.log(`[relevance] failures:\n - ${failures.join("\n - ")}`);

    expect(precisionAt1).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBe(1);
    expect(failures.length).toBe(0);
  });

  test("similar but different companies stay distinct", async () => {
    const tataSteel = await search("Tata Steel");
    expect(tataSteel.hits[0].name).toBe("Tata Steel Limited");

    const ibmIndia = await search("IBM India");
    expect(ibmIndia.hits[0].name).toBe("IBM India Private Limited");

    const relianceJio = await search("Reliance Jio");
    expect(relianceJio.hits[0].name).toBe("Reliance Jio Infocomm Limited");

    // "IBM" matches the parent company first, and the Indian entity may also be
    // listed — as its OWN record. Fuzzy search must not merge them, so every hit
    // keeps a distinct id and a distinct contact count.
    const ibm = await search("IBM");
    expect(ibm.hits[0].name).toBe("International Business Machines Corporation");
    const ids = ibm.hits.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    const ibmIndiaRecord = ibm.hits.find((h) => h.name === "IBM India Private Limited");
    expect(ibmIndiaRecord).toBeDefined();
    expect(ibmIndiaRecord!.contactCount).toBe(122);
    expect(ibm.hits[0].contactCount).toBe(318);
  });

  test("generic-only queries cannot look confident", async () => {
    const response = await search("solutions");
    for (const hit of response.hits) {
      expect(hit.relevance).toBeLessThan(0.72);
      expect(hit.possibleMatch).toBe(true);
    }
  });

  test("short queries use bounded prefix lookup and stay strict", async () => {
    const response = await search("mi");
    for (const hit of response.hits) expect(hit.relevance).toBeGreaterThanOrEqual(minScoreFor(2));
    expect(response.hits.every((h) => h.matchCategory === "exact" || h.matchCategory === "alias" || h.matchCategory === "prefix")).toBe(true);
  });

  test("fuzzy matching can be switched off", async () => {
    const off = await search("Microsft", { fuzzy: false });
    expect(off.hits.length).toBe(0);
    const on = await search("Microsft", { fuzzy: true });
    expect(on.hits[0].name).toBe("Microsoft Corporation");
  });
});

describe("result presentation", () => {
  test("typo queries explain themselves", async () => {
    const response = await search("Microsft");
    expect(response.notice).toBe('Showing similar results for "Microsft".');
    expect(response.correctedQuery).toBe("Microsoft Corporation");
  });

  test("no-result queries return a clear message and empty hits", async () => {
    const response = await search("zzzzzzqqqqq");
    expect(response.hits.length).toBe(0);
    expect(response.notice).toContain("No companies matched");
  });

  test("pagination is bounded and stable", async () => {
    const first = await search("tata", { pageSize: 2, page: 1 });
    const second = await search("tata", { pageSize: 2, page: 2 });
    expect(first.hits.length).toBeLessThanOrEqual(2);
    expect(first.page.hasMore).toBe(true);
    const firstIds = first.hits.map((h) => h.id);
    const secondIds = second.hits.map((h) => h.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  test("sorting by name and by contact count is honoured", async () => {
    const byName = await search("tata", { sort: "name", order: "asc" });
    const names = byName.hits.map((h) => h.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);

    const byContacts = await search("reliance", { sort: "contactCount", order: "desc" });
    const counts = byContacts.hits.map((h) => h.contactCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  test("filters constrain the retrieved pool", async () => {
    const india = await search("tata", { filters: { country: "India" } });
    expect(india.hits.length).toBeGreaterThan(0);
    expect(india.hits.every((h) => h.country === "India")).toBe(true);

    const withContacts = await search("tata", { filters: { hasContacts: true } });
    expect(withContacts.hits.every((h) => h.contactCount > 0)).toBe(true);
  });

  test("retrieval never exceeds the configured budgets", async () => {
    const response = await search("tata consultancy services international", { resultBudget: 5, retrievalBudget: 10 });
    expect(response.retrieval.scored).toBeLessThanOrEqual(5);
  });
});

describe("cache keys", () => {
  test("equivalent queries share a key", () => {
    const base = {
      datasetVersion: "v1",
      fuzzy: true,
      sort: "relevance" as const,
      order: "desc" as const,
      page: 1,
      pageSize: 25,
      resultBudget: 800,
    };
    const a = buildSearchCacheKey({ ...base, query: "Microsoft Corp" });
    const b = buildSearchCacheKey({ ...base, query: "  microsoft   corp. " });
    expect(a).toBe(b);
  });

  test("repeated misspellings share a key", () => {
    const base = {
      datasetVersion: "v1",
      fuzzy: true,
      sort: "relevance" as const,
      order: "desc" as const,
      page: 1,
      pageSize: 25,
      resultBudget: 800,
    };
    expect(buildSearchCacheKey({ ...base, query: "Microsft" })).toBe(buildSearchCacheKey({ ...base, query: "microsft" }));
  });

  test("version, page, filters and fuzzy flag change the key", () => {
    const base = {
      query: "tata",
      fuzzy: true,
      sort: "relevance" as const,
      order: "desc" as const,
      page: 1,
      pageSize: 25,
      resultBudget: 800,
      datasetVersion: "v1",
    };
    const keys = new Set([
      buildSearchCacheKey(base),
      buildSearchCacheKey({ ...base, datasetVersion: "v2" }),
      buildSearchCacheKey({ ...base, page: 2 }),
      buildSearchCacheKey({ ...base, fuzzy: false }),
      buildSearchCacheKey({ ...base, filters: { country: "India" } }),
    ]);
    expect(keys.size).toBe(5);
  });
});
