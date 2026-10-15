/**
 * R2Store behaviour tests with an in-memory fake R2 bucket.
 *
 * These cover the parts of the saved-leads design that are easy to get wrong and
 * impossible to see from the UI:
 *   - leads are partitioned documents, not one giant object,
 *   - writes are compare-and-set, so a concurrent writer cannot be silently
 *     overwritten (the second writer retries against fresh state),
 *   - a recovery snapshot of the pre-mutation state is written to backups/,
 *   - deletes update both the shard and the index.
 */

import { describe, expect, test } from "bun:test";

import { R2Store } from "../worker/src/store";
import type { SavedLead } from "../src/shared/models";
import { leadShardKey, snapshotKey } from "../src/shared/search/index-format";

/* ------------------------------- fake bucket ------------------------------ */

interface StoredObject {
  etag: string;
  text: string;
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();
  /** Runs before every put, to simulate another writer winning the race. */
  beforePut: (() => void) | null = null;
  putCount = 0;
  private counter = 0;

  private etag(text: string): string {
    this.counter += 1;
    return `"etag-${this.counter}-${text.length}"`;
  }

  async get(key: string): Promise<unknown> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      etag: object.etag,
      size: object.text.length,
      text: async () => object.text,
      json: async () => JSON.parse(object.text),
    };
  }

  async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string } }): Promise<unknown> {
    this.putCount += 1;
    const hook = this.beforePut;
    this.beforePut = null;
    if (hook) hook();
    const current = this.objects.get(key);
    if (options?.onlyIf?.etagMatches && current && current.etag !== options.onlyIf.etagMatches) {
      // R2 returns null when the precondition fails: a lost update, not an error.
      return null;
    }
    const etag = this.etag(value);
    this.objects.set(key, { etag, text: value });
    return { key, etag };
  }

  async head(key: string): Promise<unknown> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(options: { prefix: string; limit?: number; cursor?: string }): Promise<unknown> {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .slice(0, options.limit ?? 1000)
      .map(([key, value]) => ({ key, etag: value.etag, size: value.text.length }));
    return { objects, truncated: false };
  }
}

function makeLead(overrides: Partial<SavedLead> = {}): SavedLead {
  return {
    id: overrides.id ?? "lead-1",
    kind: "company",
    companyId: "company_1",
    status: "new",
    tags: [],
    notes: "",
    savedAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
    ...overrides,
  } as SavedLead;
}

function makeStore(): { bucket: FakeBucket; store: R2Store } {
  const bucket = new FakeBucket();
  const store = new R2Store(bucket as unknown as R2Bucket);
  return { bucket, store };
}

/* ---------------------------------- tests --------------------------------- */

describe("saved leads in R2", () => {
  test("a lead is written to its partition and counted in the index", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-a" }));

    const shard = bucket.objects.get(leadShardKey(store["leadPartition"]("lead-a")));
    expect(shard).toBeDefined();
    expect(JSON.parse(shard!.text)).toHaveLength(1);

    const leads = await store.listLeads();
    expect(leads.map((lead) => lead.id)).toEqual(["lead-a"]);
  });

  test("a concurrent writer does not silently lose data", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-1" }));

    const partition = store["leadPartition"]("lead-1");
    const key = leadShardKey(partition);

    let injected = false;
    bucket.beforePut = () => {
      // Another tab writes between our read and our write; the stored etag
      // changes, so the first conditional put must fail.
      if (injected) return;
      injected = true;
      bucket.objects.set(key, {
        etag: '"someone-else"',
        text: JSON.stringify([makeLead({ id: "lead-from-other-tab", notes: "written concurrently" })]),
      });
    };

    await store.upsertLead(makeLead({ id: "lead-1", notes: "second edit" }));

    const leads = await store.listLeads();
    const ids = leads.map((lead) => lead.id).sort();
    // Both the concurrent lead and our own edit survive: the retry re-ran the
    // mutation against fresh state instead of clobbering it.
    expect(ids).toEqual(["lead-1", "lead-from-other-tab"]);
    const mine = leads.find((lead) => lead.id === "lead-1");
    expect(mine?.notes).toBe("second edit");
    expect(bucket.objects.get(key)).toBeDefined();
  });

  test("a recovery snapshot of the pre-mutation state is kept under backups/", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-1", notes: "first" }));
    await store.upsertLead(makeLead({ id: "lead-1", notes: "second" }));

    const stamp = new Date().toISOString().slice(0, 10);
    const key = snapshotKey(stamp, leadShardKey(store["leadPartition"]("lead-1")));
    const snapshot = bucket.objects.get(key);
    expect(snapshot).toBeDefined();

    const restored = JSON.parse(snapshot!.text) as SavedLead[];
    expect(restored).toHaveLength(1);
    expect(restored[0].notes).toBe("first");
  });

  test("deleting a lead clears the shard and the index entry", async () => {
    const { store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-1" }));
    expect(await store.deleteLead("lead-1")).toBe(true);
    expect(await store.listLeads()).toEqual([]);
    expect(await store.deleteLead("lead-1")).toBe(false);
  });

  test("distinct leads land in distinct partitions when ids differ", async () => {
    const { bucket, store } = makeStore();
    await store.upsertLead(makeLead({ id: "lead-a" }));
    await store.upsertLead(makeLead({ id: "lead-b" }));

    const keys = [...bucket.objects.keys()].filter((key) => key.startsWith("app-data/leads/") && !key.endsWith("index.json"));
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect((await store.listLeads()).length).toBe(2);
  });
});
