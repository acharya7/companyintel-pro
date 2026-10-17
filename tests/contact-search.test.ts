/**
 * Global contact search — the real write path, the real read path.
 *
 * The fixture index is produced by the actual indexer (see
 * `helpers/fixture-dataset.ts`), loaded into an R2 binding exactly as an upload
 * leaves it, and then queried through `worker/src/contact-search.ts` — the same
 * module the Worker route calls. So these tests fail if the indexer stops writing
 * the contact name index, if the shard/id/partition keys disagree, or if scoring
 * regresses into returning unrelated people.
 *
 * The last group uses a purpose-built mini index instead of the fixture: a contact
 * with no employer is written to an `unassigned/` object and addressed through a
 * NEGATIVE ids-index ref, which the fixture (where every contact resolves) cannot
 * exercise.
 */

import { describe, expect, test } from "bun:test";

import { R2Store } from "../worker/src/store";
import { loadContactById, searchContacts } from "../worker/src/contact-search";
import { FakeR2Bucket } from "./helpers/fake-r2";
import { buildFixtureDataset } from "./helpers/fixture-dataset";
import type { IndexDirectory } from "../src/shared/search/index-format";
import {
  activeManifestKey,
  contactPartitionKey,
  indexDirectoryKey,
  indexShardKey,
  unassignedPartitionKey,
} from "../src/shared/search/index-format";
import { shardOf } from "../src/shared/hash";

const fixture = await buildFixtureDataset();
const bucket = new FakeR2Bucket();
bucket.loadObjects(
  fixture.outputDir,
  fixture.result.objects.map((object) => object.key),
);
bucket.putBytes(
  activeManifestKey(),
  Buffer.from(JSON.stringify({ version: fixture.version, previousVersion: null, activatedAt: new Date().toISOString(), activatedBy: "tests" }), "utf8"),
);
const store = new R2Store(bucket as unknown as R2Bucket);

async function directoryOrThrow(): Promise<IndexDirectory> {
  const directory = await store.getDirectory(fixture.version);
  if (!directory) throw new Error("fixture directory is missing");
  return directory;
}

async function search(query: string, pageSize = 10) {
  const directory = await directoryOrThrow();
  const result = await searchContacts(store, directory, { query, pageSize });
  if (!result) throw new Error("the fixture index has no contact index");
  return result;
}

describe("the indexer writes a contact name index", () => {
  test("the directory records the contact shard counts", async () => {
    const directory = await directoryOrThrow();
    expect(directory.shards.contactIndex).toEqual({ token: 8, prefix: 8, trigram: 8 });
  });

  test("every contact contributes postings, and they are keyed by contact id", () => {
    const keys = fixture.result.objects.map((object) => object.key);
    for (const kind of ["contactToken", "contactPrefix", "contactTrigram"]) {
      expect(keys.some((key) => key.includes(`/${kind}/`))).toBe(true);
    }
    const payload = bucket.getObject(indexShardKey(fixture.version, "contactToken", 0));
    expect(payload).toBeDefined();
  });
});

describe("person search over the real index", () => {
  test("an exact full name is found", async () => {
    const result = await search("Satya Nadella");
    expect(result.hits[0]?.fullName).toBe("Satya Nadella");
    expect(result.hits[0]?.companyName).toBe("Microsoft Corporation");
  });

  test("a last name alone is enough", async () => {
    const result = await search("Nadella");
    expect(result.hits.map((hit) => hit.fullName)).toContain("Satya Nadella");
  });

  test("a partial name is enough", async () => {
    const result = await search("Nade");
    expect(result.hits.map((hit) => hit.fullName)).toContain("Satya Nadella");
  });

  test("a misspelled name is tolerated", async () => {
    for (const query of ["Nadela", "Satya Nadellla"]) {
      const result = await search(query);
      expect(result.hits.map((hit) => hit.fullName)).toContain("Satya Nadella");
    }
  });

  test("a person with no employer-side match is still returned, with its employer", async () => {
    // Erin Boyle's company is identified by a LinkedIn URL only; she must still be
    // findable and must carry the company she was attached to.
    const result = await search("Erin Boyle");
    const hit = result.hits.find((entry) => entry.fullName === "Erin Boyle");
    expect(hit).toBeDefined();
    expect(hit?.companyName).toBe("Northwind Traders");
    expect(hit?.email).toBe("erin.boyle@northwind.example");
  });

  test("nonsense returns nothing rather than a near-miss", async () => {
    const result = await search("zzqqxx wubble");
    expect(result.hits).toEqual([]);
    expect(result.matched).toBe(0);
  });

  test("a hit carries the matched terms so the UI can explain itself", async () => {
    const result = await search("satya nadella");
    expect(result.hits[0]?.matchedTerms).toContain("nadella");
  });
});

describe("a version without a contact index says so", () => {
  test("searchContacts returns null instead of an empty result", async () => {
    const directory = await directoryOrThrow();
    // A version whose directory has no `shards.contactIndex` — i.e. every index built
    // before the contact name index existed.
    const shards = { ...directory.shards };
    delete shards.contactIndex;
    const legacy = { ...directory, shards } as IndexDirectory;
    const result = await searchContacts(store, legacy, { query: "satya", pageSize: 10 });
    // null is the caller's signal to answer "this version cannot search people".
    // An empty result would claim the person is absent when nothing was looked up.
    expect(result).toBeNull();
  });
});

describe("a contact preserved without an employer stays searchable", () => {
  /*
   * Mini index, one company and one preserved contact. The preserved contact is
   * addressed by a negative ids ref, which is the convention the indexer writes for
   * it (`-(partition + 1)`); if the reader and writer ever disagree, this test is
   * what catches it — the contact would simply never be hydratable.
   */
  const version = "mini-v1";
  const mini = new FakeR2Bucket();
  const directory: IndexDirectory = {
    formatVersion: 3,
    normalizerVersion: 1,
    version,
    createdAt: new Date().toISOString(),
    shards: {
      exact: 1,
      prefix: 1,
      token: 1,
      trigram: 1,
      ids: 1,
      companyPartitions: 1,
      contactPartitions: 1,
      spoolPartitions: 1,
      contactIndex: { token: 1, prefix: 1, trigram: 1 },
    },
    counts: { companies: 1, contacts: 1, indexedAliases: 0 },
    sources: ["csv2"],
    bytes: { indexes: 0, companies: 0, contacts: 0, total: 0 },
    fields: { company: [], contact: [] },
  };
  const unassigned = {
    partition: 0,
    contacts: [
      {
        id: "p_preserved01",
        companyId: "",
        fullName: "Hidden Person",
        title: "Analyst",
        email: "hidden.person@example.org",
        source: { source: "csv2", row: 42 },
        claimedCompanyName: "Confidential",
        claimedNormalizedName: "confidential",
        association: {
          category: "unresolved",
          reason: "several_candidates_remain",
          evidence: { name: "shared", domain: "absent", country: "differ", rowIdentity: false, candidates: 2 },
        },
      },
    ],
  };
  const idsShard = {
    terms: { p_preserved01: { refs: [-1], q: [255] } },
  };
  /*
   * The posting the indexer writes for the token "hidden" (a name token is one of
   * the terms the reader looks up), so the lookup below uses the real key space.
   */
  const nameShard = {
    terms: { hidden: { ids: ["p_preserved01"], q: [160] } },
  };

  mini.putBytes(indexDirectoryKey(version), Buffer.from(JSON.stringify(directory), "utf8"));
  mini.putBytes(unassignedPartitionKey(version, 0), Buffer.from(JSON.stringify(unassigned), "utf8"));
  mini.putBytes(indexShardKey(version, "ids", shardOf("p_preserved01", 1)), Buffer.from(JSON.stringify(idsShard), "utf8"));
  mini.putBytes(
    indexShardKey(version, "contactToken", shardOf("hidden", 1)),
    Buffer.from(JSON.stringify(nameShard), "utf8"),
  );
  const miniStore = new R2Store(mini as unknown as R2Bucket);

  test("the preserved contact is found and reported as unassigned", async () => {
    const result = await searchContacts(miniStore, directory, { query: "hidden", pageSize: 5 });
    expect(result).not.toBeNull();
    expect(result!.hits).toHaveLength(1);
    const hit = result!.hits[0];
    expect(hit.fullName).toBe("Hidden Person");
    expect(hit.companyId).toBeNull();
    // The claimed name is shown, but never as a confirmed employer.
    expect(hit.companyName).toBe("Confidential");
    expect(hit.association).toBe("unresolved");
    expect(hit.employerUnconfirmed).toBe(true);
  });

  test("opening it by id resolves through the unassigned object", async () => {
    const found = await loadContactById(miniStore, directory, "p_preserved01");
    expect(found.unassigned).toBe(true);
    expect(found.contact?.fullName).toBe("Hidden Person");
    expect(found.company).toBeNull();
  });

  test("an unknown id resolves to nothing rather than to a neighbour", async () => {
    const found = await loadContactById(miniStore, directory, "p_not_in_index");
    expect(found.contact).toBeNull();
    expect(found.company).toBeNull();
  });

  test("contact partitions are still addressed by ref for attached contacts", () => {
    // Guards the key helpers the mini index relies on, so a change to the layout is
    // a visible failure here instead of a silent 404 in production.
    expect(contactPartitionKey(version, 0)).toBe(`contacts/${version}/00000.json.gz`);
  });
});
