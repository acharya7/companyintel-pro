/**
 * The development bucket shim's active-pointer resolution.
 *
 * This is the integration the preview depends on to serve a newly published index.
 * A version resolved once at server start and then pinned keeps serving yesterday's
 * dataset after `cli publish` — the gap this suite closes:
 *
 *   - a pin (COMPANYINTEL_DEV_DATASET_VERSION / plugin option) always wins;
 *   - otherwise the newest activation of {this process, R2} wins;
 *   - the R2 pointer is re-read at most every 5 s (bounded reads, still live);
 *   - the preview never writes R2's pointer, and refuses to write index objects.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { createDevBucket } from "../tools/dev-api/dev-bucket.mjs";

type StoredObject = { bytes: Uint8Array; httpMetadata?: Record<string, string> };

function jsonObject(value: unknown): StoredObject {
  return { bytes: new TextEncoder().encode(JSON.stringify(value)), httpMetadata: { contentType: "application/json" } };
}

function counter() {
  let reads = 0;
  return { get reads() { return reads; }, count() { reads += 1; } };
}

/** A minimal R2 surface: `getBytes`/`head`/`list`, with a read counter. */
function fakeRemote(objects: Map<string, StoredObject>) {
  const stats = counter();
  return {
    stats,
    async getBytes(key: string) {
      stats.count();
      const found = objects.get(key);
      return found ? { ...found, etag: "etag" } : null;
    },
    async head(key: string) {
      const found = objects.get(key);
      return found ? { key, size: found.bytes.byteLength, etag: "etag" } : null;
    },
    async list() {
      return { objects: [...objects].map(([key, value]) => ({ key, size: value.bytes.byteLength, etag: "etag" })), truncated: false, cursor: null };
    },
  };
}

async function pointerVersion(bucket: { get: (key: string) => Promise<{ text: () => Promise<string> } | null> }) {
  const object = await bucket.get("manifests/active.json");
  if (!object) return null;
  return JSON.parse(await object.text()).version as string;
}

const realNow = Date.now();
afterEach(() => {
  // The fake clock is process-wide: always hand real time back.
  setSystemTime();
});

describe("dev bucket active pointer", () => {
  test("a pin wins over anything published later", async () => {
    const objects = new Map<string, StoredObject>([
      ["manifests/active.json", jsonObject({ version: "published-v9", activatedAt: new Date(realNow + 60_000).toISOString() })],
    ]);
    const bucket = createDevBucket({ remote: fakeRemote(objects), version: "pinned-v1", pin: true });
    expect(await pointerVersion(bucket)).toBe("pinned-v1");
  });

  test("without a pin the published R2 pointer is served", async () => {
    const objects = new Map<string, StoredObject>([
      ["manifests/active.json", jsonObject({ version: "dev-r2-full", activatedAt: new Date(realNow).toISOString() })],
    ]);
    const bucket = createDevBucket({ remote: fakeRemote(objects), version: "dev-r2-20k" });
    expect(await pointerVersion(bucket)).toBe("dev-r2-full");
    expect(await bucket.activeVersion()).toBe("dev-r2-full");
  });

  test("an in-process activation wins until something newer is published", async () => {
    const objects = new Map<string, StoredObject>([
      ["manifests/active.json", jsonObject({ version: "dev-old", activatedAt: new Date(realNow - 60_000).toISOString() })],
    ]);
    const bucket = createDevBucket({ remote: fakeRemote(objects), version: "dev-old" });
    await bucket.put(
      "manifests/active.json",
      JSON.stringify({ version: "dev-activated-here", previousVersion: "dev-old", activatedAt: new Date(realNow).toISOString() }),
      { httpMetadata: { contentType: "application/json" } },
    );
    expect(await pointerVersion(bucket)).toBe("dev-activated-here");

    // Publishing a NEWER version to R2 takes over within the TTL — no restart.
    setSystemTime(realNow + 6_000);
    objects.set(
      "manifests/active.json",
      jsonObject({ version: "dev-published-later", activatedAt: new Date(realNow + 1_000).toISOString() }),
    );
    expect(await pointerVersion(bucket)).toBe("dev-published-later");
  });

  test("the R2 pointer is re-read at most every five seconds", async () => {
    const objects = new Map<string, StoredObject>([
      ["manifests/active.json", jsonObject({ version: "dev-a", activatedAt: new Date(realNow).toISOString() })],
    ]);
    const remote = fakeRemote(objects);
    const bucket = createDevBucket({ remote, version: "dev-a" });

    expect(await pointerVersion(bucket)).toBe("dev-a");
    const afterFirst = remote.stats.reads;
    objects.set("manifests/active.json", jsonObject({ version: "dev-b", activatedAt: new Date(realNow + 1).toISOString() }));
    expect(await pointerVersion(bucket)).toBe("dev-a");
    expect(remote.stats.reads).toBe(afterFirst);

    // Relative to the real read, not to module load.
    setSystemTime(Date.now() + 5_001);
    expect(await pointerVersion(bucket)).toBe("dev-b");
    expect(remote.stats.reads).toBe(afterFirst + 1);
  });

  test("a bucket with index objects but no pointer still serves the discovered version", async () => {
    const bucket = createDevBucket({ remote: fakeRemote(new Map()), version: "dev-discovered" });
    expect(await pointerVersion(bucket)).toBe("dev-discovered");
  });

  test("the preview cannot write index objects or a malformed pointer", async () => {
    const bucket = createDevBucket({ remote: fakeRemote(new Map()), version: "dev-x" });
    await expect(bucket.put("companies/dev-x/00001.json.gz", new Uint8Array([1]))).rejects.toThrow(/refuses to write/);
    await expect(bucket.put("manifests/active.json", "not json")).rejects.toThrow(/unparseable/);
    // App data is writable, in memory only.
    await bucket.put("app-data/settings.json", JSON.stringify({ theme: "dark" }));
    expect(await pointerVersion(bucket)).toBe("dev-x");
  });
});
