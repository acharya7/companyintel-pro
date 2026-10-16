/**
 * API client contract — the regression net for the preview failure.
 *
 * The preview showed `Request failed — api.datasetStatus is not a function` on the
 * Dashboard and Dataset pages while every typecheck passed. Root cause: the
 * persistent-cache wrapper was built with object spread (`{ ...base, ... })`, and
 * spread copies only *own enumerable* properties — class methods live on the
 * prototype — so 23 of the 27 ApiClient methods disappeared at runtime.
 *
 * These tests assert the property that was violated, not the symptom:
 *   - every method of `ApiClient` exists and is callable on every client,
 *   - the wrapper forwards to the underlying client and preserves `mode`,
 *   - a client that is missing a method is rejected loudly instead of silently
 *     producing an object with holes,
 *   - the three application modes are derived from a published manifest, never
 *     from a reachable bucket.
 *
 * Type-level proof lives in `src/lib/api/types.ts`
 * (`API_CLIENT_METHODS_ARE_EXHAUSTIVE`); this file proves the runtime half.
 */

import { describe, expect, test } from "bun:test";

import {
  API_CLIENT_METHODS,
  API_CLIENT_METHODS_ARE_EXHAUSTIVE,
  apiClientMethodNames,
  datasetModeInfo,
  datasetModeOf,
  type ApiClient,
} from "../src/lib/api/types";
import { LocalApiClient } from "../src/lib/api/local";
import { ApiRequestError, WorkerApiClient } from "../src/lib/api/worker";
import { createApiClient, withPersistentCache } from "../src/lib/api/client";

type AnyClient = Record<string, unknown>;

const clients: { name: string; client: ApiClient }[] = [
  { name: "LocalApiClient (demo)", client: new LocalApiClient() },
  { name: "WorkerApiClient", client: new WorkerApiClient("https://example.invalid") },
  { name: "wrapped client (createApiClient)", client: createApiClient() },
];

describe("every client implements the whole ApiClient interface at runtime", () => {
  for (const { name, client } of clients) {
    test(`${name} exposes all ${API_CLIENT_METHODS.length} methods`, () => {
      const missing = API_CLIENT_METHODS.filter(
        (method) => typeof (client as unknown as AnyClient)[method] !== "function",
      );
      // Named in the failure message, so a regression shows exactly which call a
      // page would crash on (this is what `datasetStatus` did).
      expect(missing).toEqual([]);
    });
  }

  test("the runtime list matches the interface exactly", () => {
    expect(API_CLIENT_METHODS_ARE_EXHAUSTIVE).toBe(true);
    expect(new Set(API_CLIENT_METHODS).size).toBe(API_CLIENT_METHODS.length);
  });

  test("object spread is not a valid way to wrap a client (root cause pinned)", () => {
    // If someone reintroduces `{ ...client }`, this is what happens: the prototype
    // methods vanish. The assertion above would then fail for real.
    const spread = { ...new LocalApiClient() } as unknown as AnyClient;
    const present = API_CLIENT_METHODS.filter((method) => typeof spread[method] === "function");
    expect(present.length).toBeLessThan(API_CLIENT_METHODS.length);
    expect(typeof spread.datasetStatus).not.toBe("function");
  });

  test("client methods live on the prototype, which is why they must be forwarded", () => {
    const names = apiClientMethodNames(new LocalApiClient());
    expect(names).toContain("datasetStatus");
    expect(names).toContain("downloadExport");
    // Own properties alone would only be `mode` plus instance fields.
    expect(Object.keys(new LocalApiClient())).not.toContain("datasetStatus");
  });
});

describe("the caching wrapper delegates instead of replacing", () => {
  const wrapped = createApiClient();

  test("datasetStatus reaches the underlying client and keeps its contract", async () => {
    const status = await wrapped.datasetStatus();
    expect(typeof status.indexed).toBe("boolean");
    expect(typeof status.bucket).toBe("string");
    expect(status.dataOrigin === "sample" || status.dataOrigin === "r2").toBe(true);
  });

  test("uncached methods are delegated too (activity, settings, leads, exports)", async () => {
    const [activity, settings, leads, exports] = await Promise.all([
      wrapped.listActivity(),
      wrapped.getSettings(),
      wrapped.listLeads(),
      wrapped.listExports(),
    ]);
    expect(Array.isArray(activity)).toBe(true);
    expect(settings).toBeDefined();
    expect(leads.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(exports)).toBe(true);
  });

  test("mode is preserved, so the sample-data banner still works", async () => {
    expect(wrapped.mode).toBe("local");
    const health = await wrapped.health();
    expect(health.mode).toBe("local");
  });

  test("a client missing a method is rejected loudly, naming the method", () => {
    const instance = new LocalApiClient() as unknown as AnyClient;
    const proto = Object.getPrototypeOf(instance) as AnyClient;
    // A prototype with every method except one — exactly the shape the spread bug
    // produced, where only the four overridden methods survived.
    const stripped: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor" || key === "datasetSources") continue;
      stripped[key] = proto[key];
    }
    const base = Object.assign(Object.create(stripped), instance);
    expect(typeof (base as AnyClient).datasetSources).not.toBe("function");
    expect(() => withPersistentCache(base as unknown as ApiClient)).toThrow(/datasetSources/);
    // …and a complete base is accepted, so the guard is not just always throwing.
    const complete = Object.assign(Object.create(proto), instance);
    expect(() => withPersistentCache(complete as unknown as ApiClient)).not.toThrow();
  });
});

describe("the Worker adapter fails loudly and usefully", () => {
  const originalFetch = globalThis.fetch;

  function stubFetch(status: number, body: unknown) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  }

  test("a 401 becomes an Access explanation, not a silent empty result", async () => {
    stubFetch(401, { error: { code: "unauthorized", message: "Access denied", requestId: "req_1" } });
    try {
      const client = new WorkerApiClient("https://example.invalid");
      let caught: unknown;
      try {
        await client.datasetStatus();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiRequestError);
      const apiError = caught as ApiRequestError;
      expect(apiError.status).toBe(401);
      expect(apiError.isAuthError).toBe(true);
      expect(apiError.requestId).toBe("req_1");
      expect(apiError.message).toMatch(/Cloudflare Access/);
      // No fallback to synthetic rows: the call rejects, it never resolves with data.
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a 503 with a non-JSON body still produces a readable error", async () => {
    globalThis.fetch = (async () => new Response("<html>blocked</html>", { status: 503 })) as unknown as typeof fetch;
    try {
      await expect(new WorkerApiClient("https://example.invalid").datasetStatus()).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("application modes are derived from a published manifest", () => {
  const base = { indexed: false, activeVersion: null, dataOrigin: "r2" as const };

  test("demo only when the adapter is the synthetic one", () => {
    expect(datasetModeOf({ ...base, dataOrigin: "sample" })).toBe("demo");
    expect(datasetModeInfo({ ...base, dataOrigin: "sample" }).synthetic).toBe(true);
  });

  test("real requires an active version that reports as indexed", () => {
    expect(datasetModeOf({ ...base, indexed: true, activeVersion: "v1" })).toBe("real");
    // An indexed flag without a version is not a servable dataset.
    expect(datasetModeOf({ ...base, indexed: true, activeVersion: null })).toBe("no-dataset");
    expect(datasetModeOf({ ...base, indexed: false, activeVersion: "v1" })).toBe("no-dataset");
  });

  test("a reachable bucket is NOT real data", () => {
    // This is the rule the brief asks for: do not infer availability from the
    // presence of R2 access. Only a published, validated version counts.
    const reachableOnly = { indexed: false, activeVersion: null, dataOrigin: "r2" as const, bucketOk: true };
    expect(datasetModeOf(reachableOnly)).toBe("no-dataset");
    expect(datasetModeInfo(reachableOnly).synthetic).toBe(false);
    expect(datasetModeInfo(reachableOnly).label).toBe("No dataset indexed");
  });

  test("an unreadable status is no-dataset, never demo", () => {
    expect(datasetModeOf(undefined)).toBe("no-dataset");
    expect(datasetModeOf(null)).toBe("no-dataset");
    expect(datasetModeInfo(undefined).label).toBe("No dataset indexed");
  });
});
