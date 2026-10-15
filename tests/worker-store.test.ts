/**
 * R2Store behaviour tests.
 *
 * These cover the parts of the saved-leads design that are easy to get wrong and
 * impossible to see from the UI:
 *   - leads are partitioned documents, not one giant object,
 *   - writes are compare-and-set, so a concurrent writer cannot be silently
 *     overwritten (the second writer retries against fresh state),
 *   - a recovery snapshot of the pre-mutation state is written to backups/,
 *   - deletes update both the shard and the index,
 *   - `raw/` can be listed with bounded metadata for the Dataset page.
 *
 * They use the same `FakeR2Bucket` as the end-to-end tests. A second, divergent
 * double used to live in this file and drifted from the real binding (it lacked
 * `arrayBuffer()`), which made passing tests meaningless — one realistic double
 * is now shared by every test that needs R2.
 *
 * Deeper failure-mode coverage (missing/corrupt/stale directory, repair) lives in
 * `leads-recovery.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { R2Store } from "../worker/src/store";
import type { SavedLead } from "../src/shared/models";
import { leadShardKey, snapshotKey } from "../src/shared/search/index-format";
import { FakeR2Bucket } from "./helpers/fake-r2";

function makeLead(overrides: Partial<SavedLead> = {}): SavedLead {
  return {
    id: overrides.id ?? "lead-1",
    kind: "company",
    companyId: "company_1",
    status: "new",
    tags: [],
    notes: [],
    savedAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
    datasetVersion: "v1",
    ...overrides,
  } as SavedLead;
}

function makeStore(): { bucket: FakeR2Bucket; store: R2Store } {
  const bucket = new FakeR2Bucket();
  const store = new R2Store(bucket as unknown as R2Bucket);
  return { bucket, store };
}

const readJson = <T>(bucket: FakeR2Bucket, key: string): T =>
  JSON.parse(bucket.getObject(key)!.bytes.toString("utf8")) as T;

/* ---------------------------------- tests --------------------------------- */

describe("saved leads in R2", () => {
  test("a lead is written to its partition and counted in the index", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-a" }));

    const partition = (store as unknown as { leadPartition(id: string): number })["leadPartition"]("lead-a");
    const shard = bucket.getObject(leadShardKey(partition));
    expect(shard).toBeDefined();
    expect(readJson<SavedLead[]>(bucket, leadShardKey(partition))).toHaveLength(1);

    const leads = await store.listLeads();
    expect(leads.map((lead) => lead.id)).toEqual(["lead-a"]);
  });

  test("a concurrent writer does not silently lose data", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-1" }));

    const partition = (store as unknown as { leadPartition(id: string): number })["leadPartition"]("lead-1");
    const key = leadShardKey(partition);

    let injected = false;
    bucket.beforePut = () => {
      // Another tab writes between our read and our write; the stored etag
      // changes, so the first conditional put must fail.
      if (injected) return;
      injected = true;
      bucket.putBytes(key, Buffer.from(JSON.stringify([makeLead({ id: "lead-from-other-tab" })]), "utf8"));
    };

    await store.upsertLead(makeLead({ id: "lead-1", tags: ["edited"] }));

    const leads = await store.listLeads();
    expect(leads.map((lead) => lead.id).sort()).toEqual(["lead-1", "lead-from-other-tab"]);
    expect(leads.find((lead) => lead.id === "lead-1")?.tags).toEqual(["edited"]);
    expect(bucket.getObject(key)).toBeDefined();
  });

  test("a recovery snapshot of the pre-mutation state is kept under backups/", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-1", tags: ["first"] }));
    await store.upsertLead(makeLead({ id: "lead-1", tags: ["second"] }));

    const stamp = new Date().toISOString().slice(0, 10);
    const partition = (store as unknown as { leadPartition(id: string): number })["leadPartition"]("lead-1");
    const snapshot = bucket.getObject(snapshotKey(stamp, leadShardKey(partition)));
    expect(snapshot).toBeDefined();

    const restored = JSON.parse(snapshot!.bytes.toString("utf8")) as SavedLead[];
    expect(restored).toHaveLength(1);
    expect(restored[0].tags).toEqual(["first"]);
  });

  test("deleting a lead clears the shard and the index entry", async () => {
    const { store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-1" }));
    expect(await store.deleteLead("lead-1")).toBe(true);
    expect(await store.listLeads()).toEqual([]);
    expect(await store.deleteLead("lead-1")).toBe(false);
  });

  test("raw/ can be listed with bounded metadata for the dataset page", async () => {
    const { bucket, store } = makeStore();
    bucket.putBytes("raw/companies_part1.csv", Buffer.from("id,name\n1,Acme\n"));
    bucket.putBytes("raw/companies_part2.csv", Buffer.from("id,name\n2,Globex\n"));
    bucket.putBytes("indexes/v1/exact/0000.json.gz", Buffer.from("{}"));

    const listed = await store.list("raw/");
    expect(listed.map((object) => object.key).sort()).toEqual([
      "raw/companies_part1.csv",
      "raw/companies_part2.csv",
    ]);
    // Sizes come from object metadata, and nothing outside the prefix leaks in.
    expect(listed.every((object) => typeof object.size === "number")).toBe(true);
  });

  test("distinct leads land in distinct partitions when ids differ", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-a" }));
    await store.upsertLead(makeLead({ id: "lead-b" }));

    const keys = bucket.keys("app-data/leads/").filter((key) => !key.endsWith("index.json"));
    expect(keys.length).toBe(2);
    expect((await store.listLeads()).length).toBe(2);
  });
});
