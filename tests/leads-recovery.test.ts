/**
 * Saved-lead consistency and recovery.
 *
 * The lead **shards** are authoritative (`app-data/leads/<partition>.json`); the
 * index object only exists so reads never list the bucket. These tests cover the
 * failure modes a two-object write on R2 can produce:
 *
 *   1. the index is missing entirely (a crash before the second write),
 *   2. the index is present but references a shard that is gone,
 *   3. the index says "no leads" while shards still hold leads,
 *   4. a concurrent tab wins the write race (compare-and-set),
 *   5. an operator runs the explicit repair route.
 *
 * In every case the leads themselves must survive: a directory is derived data
 * and must never be able to make saved leads disappear.
 */

import { describe, expect, test } from "bun:test";

import { R2Store } from "../worker/src/store";
import type { SavedLead } from "../src/shared/models";
import { leadShardKey, R2_PREFIX } from "../src/shared/search/index-format";
import { FakeR2Bucket } from "./helpers/fake-r2";

const LEAD_INDEX_KEY = `${R2_PREFIX.appData}leads/index.json`;

function makeLead(id: string, notes = ""): SavedLead {
  return {
    id,
    kind: "company",
    companyId: `company_${id}`,
    name: `Company ${id}`,
    status: "new",
    tags: [],
    notes: notes ? [{ at: "2026-10-15T10:00:00.000Z", text: notes }] : [],
    savedAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
    datasetVersion: "fixture-v1",
  } as SavedLead;
}

function makeStore() {
  const bucket = new FakeR2Bucket();
  return { bucket, store: new R2Store(bucket as unknown as R2Bucket) };
}

describe("saved-lead directory recovery", () => {
  test("a missing index is rebuilt from the shards instead of losing leads", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead("lead-1"));
    await store.upsertLead(makeLead("lead-2", "follow up"));

    // Simulate a crash after the shard write but before the directory write.
    bucket.objects.delete(LEAD_INDEX_KEY);
    expect(bucket.getObject(LEAD_INDEX_KEY)).toBeUndefined();

    const leads = await store.listLeads();
    expect(leads.map((lead) => lead.id).sort()).toEqual(["lead-1", "lead-2"]);

    // The read repaired the directory, so the next read needs no listing.
    const repaired = bucket.getObject(LEAD_INDEX_KEY);
    expect(repaired).toBeDefined();
    const index = JSON.parse(repaired!.bytes.toString("utf8")) as { total: number; partitions: unknown[] };
    expect(index.total).toBe(2);
    expect(index.partitions.length).toBeGreaterThan(0);

    bucket.resetCounters();
    await store.listLeads();
    expect(bucket.counters.lists).toBe(0);
  });

  test("an index that references a deleted shard does not hide the surviving leads", async () => {
    const { bucket, store } = makeStore();
    // Force the two leads into different partitions.
    const ids = ["lead-alpha", "lead-bravo"];
    for (const id of ids) await store.upsertLead(makeLead(id));

    const index = JSON.parse(bucket.getObject(LEAD_INDEX_KEY)!.bytes.toString("utf8")) as {
      partitions: { partition: number; count: number }[];
    };
    expect(index.partitions.length).toBe(2);

    // One shard is deleted out-of-band (manual cleanup, failed write).
    const victim = index.partitions[0].partition;
    bucket.objects.delete(leadShardKey(victim));

    const leads = await store.listLeads();
    expect(leads).toHaveLength(1);

    const after = JSON.parse(bucket.getObject(LEAD_INDEX_KEY)!.bytes.toString("utf8")) as {
      partitions: { partition: number }[];
      total: number;
    };
    expect(after.partitions.map((part) => part.partition)).not.toContain(victim);
    expect(after.total).toBe(1);
  });

  test("an index claiming zero leads while shards exist is corrected", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead("lead-1"));
    bucket.putBytes(LEAD_INDEX_KEY, Buffer.from(JSON.stringify({ total: 0, partitions: [], updatedAt: "2026-01-01" }), "utf8"));

    const leads = await store.listLeads();
    expect(leads.map((lead) => lead.id)).toEqual(["lead-1"]);
  });

  test("corrupt index JSON is treated as missing, not as an error", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead("lead-1"));
    bucket.putBytes(LEAD_INDEX_KEY, Buffer.from("}{ not json", "utf8"));
    expect((await store.listLeads()).map((lead) => lead.id)).toEqual(["lead-1"]);
  });

  test("explicit repair rebuilds the directory and reports the true total", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead("lead-1"));
    await store.upsertLead(makeLead("lead-2"));
    bucket.objects.delete(LEAD_INDEX_KEY);

    const index = await store.rebuildLeadIndex();
    expect(index.total).toBe(2);
    expect(index.partitions.reduce((sum, part) => sum + part.count, 0)).toBe(2);
  });

  test("a concurrent writer cannot erase a lead (compare-and-set)", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead("lead-1", "first"));

    const partition = (store as unknown as { leadPartition(id: string): number })["leadPartition"]("lead-1");
    let injected = false;
    bucket.beforePut = () => {
      if (injected) return;
      injected = true;
      bucket.putBytes(
        leadShardKey(partition),
        Buffer.from(JSON.stringify([makeLead("lead-from-other-tab", "concurrent")]), "utf8"),
      );
    };

    await store.upsertLead(makeLead("lead-1", "second"));
    const ids = (await store.listLeads()).map((lead) => lead.id).sort();
    // The other tab's lead and our own edit both survive.
    expect(ids).toEqual(["lead-1", "lead-from-other-tab"]);
  });

  test("recovery snapshots preserve the pre-mutation state", async () => {
    const { bucket, store } = makeStore();
    // The first write creates the shard, so there is nothing to snapshot yet;
    // the second write snapshots the state it is about to replace.
    await store.upsertLead(makeLead("lead-1", "original"));
    expect(bucket.keys(`${R2_PREFIX.backups}app-data/`)).toHaveLength(0);

    await store.upsertLead(makeLead("lead-1", "edited"));
    const snapshotKeys = bucket.keys(`${R2_PREFIX.backups}app-data/`);
    expect(snapshotKeys.length).toBeGreaterThan(0);
    const snapshot = JSON.parse(bucket.getObject(snapshotKeys[0])!.bytes.toString("utf8")) as SavedLead[];
    expect(snapshot[0].notes[0].text).toBe("original");

    // The snapshot is a copy, not a move: the live shard holds the new state.
    expect((await store.listLeads())[0].notes[0].text).toBe("edited");
  });
});
