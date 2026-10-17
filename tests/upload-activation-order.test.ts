/**
 * Upload ordering and activation rollback.
 *
 * Two rules keep an interrupted or repeated publish from breaking the running
 * application, and both are enforced in code that is easy to get subtly wrong:
 *
 *  1. `manifests/<version>/manifest.json` is uploaded LAST. `publish` and the
 *     Dataset page both read the presence of that object as "this version is
 *     complete", so writing it in the middle of a long upload would make a
 *     half-uploaded version look activatable.
 *  2. The active pointer is only flipped after R2 itself confirms the version, and
 *     the version that was serving becomes `previousVersion` — the one-click
 *     rollback target.
 *
 * Both are tested here against a fake bucket, so the assertions are about the
 * decisions, not about the network.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishVersion, uploadOutput, type R2WriteClient } from "../tools/indexer/src/build";
import type { RunResult } from "../tools/indexer/src/build";

interface Recorded {
  puts: string[];
  bodies: Map<string, string>;
}

function fakeClient(options: {
  existing?: Record<string, number>;
  objects?: Record<string, unknown>;
} = {}): R2WriteClient & { recorded: Recorded } {
  const recorded: Recorded = { puts: [], bodies: new Map() };
  const existing = options.existing ?? {};
  const objects = options.objects ?? {};
  return {
    recorded,
    async head(key: string) {
      const size = existing[key];
      return size === undefined ? { exists: false } : { exists: true, size };
    },
    async get(key: string) {
      const body = objects[key];
      return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
    },
    async put(key: string, body: Uint8Array | string) {
      recorded.puts.push(key);
      recorded.bodies.set(key, typeof body === "string" ? body : Buffer.from(body).toString("utf8"));
      return {};
    },
    async putJson(key: string, value: unknown) {
      recorded.puts.push(key);
      recorded.bodies.set(key, JSON.stringify(value));
      return {};
    },
  };
}

/** A run result with a realistic mix of object kinds, in the writer's order. */
function runResult(version: string, dir: string): RunResult {
  const objects = [
    { key: `companies/${version}/00001.json.gz`, bytes: 10, sha256: "a", gzip: true },
    { key: `indexes/${version}/exact/0001.json.gz`, bytes: 10, sha256: "b", gzip: true },
    { key: `manifests/${version}/validation.json`, bytes: 10, sha256: "c", gzip: false },
    { key: `manifests/${version}/manifest.json`, bytes: 10, sha256: "d", gzip: false },
  ];
  for (const object of objects) {
    const path = join(dir, object.key);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x".repeat(object.bytes), "utf8");
  }
  return {
    version,
    objects,
    manifest: { createdAt: new Date(0).toISOString(), counters: {} },
    counters: { rowsRead: 0, rowsRejected: 0, uniqueCompanies: 0, uniqueContacts: 0 },
  } as unknown as RunResult;
}

const sandbox = mkdtempSync(join(tmpdir(), "companyintel-upload-order-"));

describe("upload ordering", () => {
  const version = "v-order";
  const dir = join(sandbox, "out");
  const config = { datasetVersion: version, outputDir: dir, upload: { enabled: true, bucket: "b" } } as never;

  test("the manifest is uploaded after every index object", async () => {
    const client = fakeClient();
    const result = runResult(version, dir);
    const output = await uploadOutput(config, result, undefined, client);
    expect(output.uploaded).toBe(result.objects.length);

    const puts = client.recorded.puts;
    const manifestAt = puts.indexOf(`manifests/${version}/manifest.json`);
    const validationAt = puts.indexOf(`manifests/${version}/validation.json`);
    expect(manifestAt).toBe(puts.length - 2); // …then the progress object, which is last
    expect(validationAt).toBeGreaterThan(puts.indexOf(`companies/${version}/00001.json.gz`));
    expect(manifestAt).toBeGreaterThan(puts.indexOf(`indexes/${version}/exact/0001.json.gz`));
    // The progress object is the very last write: it is the upload's own completion mark.
    expect(puts[puts.length - 1]).toBe(`manifests/${version}/progress.json`);
  });

  test("objects already present with the right size are skipped", async () => {
    const result = runResult(version, dir);
    const existing: Record<string, number> = {};
    for (const object of result.objects) existing[object.key] = object.bytes;
    const client = fakeClient({ existing });
    const output = await uploadOutput(config, result, undefined, client);
    expect(output.uploaded).toBe(0);
    expect(output.skipped).toBe(result.objects.length);
    // Only the progress object is written on a no-op re-run.
    expect(client.recorded.puts).toEqual([`manifests/${version}/progress.json`]);
  });
});

describe("activation rollback", () => {
  const goodObjects = {
    "manifests/v-new/manifest.json": { version: "v-new", validationPassed: true, objectCount: 3, bytes: 30 },
    "manifests/v-new/validation.json": { version: "v-new", passed: true },
    "manifests/active.json": { version: "v-old", previousVersion: null },
  };

  test("publishing records the version it replaced as the rollback target", async () => {
    const client = fakeClient({ objects: goodObjects });
    const result = await publishVersion("v-new", "b", client);
    expect(result.previousVersion).toBe("v-old");
    const written = JSON.parse(client.recorded.bodies.get("manifests/active.json")!) as {
      version: string;
      previousVersion: string | null;
    };
    expect(written.version).toBe("v-new");
    expect(written.previousVersion).toBe("v-old");
    // The verification reads happen before the pointer is written.
    expect(client.recorded.puts).toEqual(["manifests/active.json"]);
  });

  test("a version that is not in R2 is never activated", async () => {
    const client = fakeClient({ objects: { "manifests/active.json": { version: "v-old" } } });
    await expect(publishVersion("v-new", "b", client)).rejects.toThrow(/not complete in R2/);
    expect(client.recorded.puts).toEqual([]);
  });

  test("publishing the version that is already active keeps the previous target", async () => {
    const client = fakeClient({
      objects: {
        "manifests/v-new/manifest.json": { version: "v-new", validationPassed: true, objectCount: 3, bytes: 30 },
        "manifests/v-new/validation.json": { version: "v-new", passed: true },
        "manifests/active.json": { version: "v-new", previousVersion: "v-old" },
      },
    });
    const result = await publishVersion("v-new", "b", client);
    expect(result.previousVersion).toBe("v-old");
  });
});
