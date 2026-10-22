/**
 * Deployment routing: `/api/*` must reach the Worker, never the SPA.
 *
 * Workers Static Assets serves the built frontend BEFORE the Worker script runs.
 * With `not_found_handling = "single-page-application"` a path that is not a file
 * is answered from the asset layer, so `/api/*` only reaches `worker/src/index.ts`
 * when the Wrangler config declares `assets.run_worker_first`. A staging
 * deployment shipped without it: `/api/health` answered with an HTML page and the
 * indexing panel reported "Cloudflare Access verification failed" because the
 * control-plane request was resolved by the asset layer instead of the Worker.
 *
 * The failure is silent — the response is a valid 200/404 page, not a crash — so
 * it is guarded in three places:
 *
 *   1. the real `wrangler.toml` / `wrangler.staging.toml` are parsed, and every
 *      `/api/…` route registered in the Worker source must route to the Worker
 *      first (no negation may take it back to the asset layer);
 *   2. non-API paths must NOT be routed to the Worker first, so the SPA fallback
 *      and immutable asset caching keep working;
 *   3. the real Worker entrypoint is called with an ASSETS binding that answers
 *      EVERY path with the shell (the worst case), and every API path must still
 *      come back as JSON.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import worker from "../worker/src/index";
import type { EnvWithContainer } from "../worker/src/indexer-container";
import { FakeR2Bucket } from "./helpers/fake-r2";

const root = join(import.meta.dir, "..");
const CONFIGS = ["wrangler.toml", "wrangler.staging.toml"] as const;
const SHELL = '<!doctype html><html><body><div id="root"></div></body></html>';

function config(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

/** Config lines only: a comment may name a secret, a setting may not. */
function configLines(file: string): string {
  return config(file)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** The lines of one `[table]` section, without comments. */
function tomlTable(source: string, header: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) throw new Error(`missing ${header} section`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("[")) break;
    if (line.trimStart().startsWith("#")) continue;
    body.push(line);
  }
  return body.join("\n");
}

/** `run_worker_first` as the array of route patterns the deployment carries. */
function workerFirstPatterns(source: string): string[] {
  const block = tomlTable(source, "[assets]");
  const match = /run_worker_first\s*=\s*\[([^\]]*)\]/.exec(block);
  if (!match) throw new Error('[assets] has no run_worker_first array; /api/* would be answered by the asset layer');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`);
}

/**
 * Cloudflare's documented precedence: a matching negative pattern wins, otherwise
 * a positive match routes to the Worker, and no match leaves the request to the
 * asset layer.
 */
function routesToWorkerFirst(patterns: string[], pathname: string): boolean {
  const matched = patterns.filter((pattern) => globToRegex(pattern.replace(/^!/, "")).test(pathname));
  if (matched.some((pattern) => pattern.startsWith("!"))) return false;
  return matched.length > 0;
}

/** Every `/api/…` route the Worker registers, with `:params` replaced by a value. */
function apiRoutes(): string[] {
  const sources = ["worker/src/app.ts", "worker/src/indexer-admin.ts"];
  const routes = new Set<string>();
  for (const file of sources) {
    const source = readFileSync(join(root, file), "utf8");
    const prefix = file.endsWith("indexer-admin.ts") ? "/api/cloud" : "";
    for (const match of source.matchAll(/\.(?:get|post|put|delete|patch|all)\("(\/[^"]*)"/g)) {
      const path = `${prefix}${match[1]}`.replace(/:[A-Za-z]+/g, "sample");
      // Wildcard handlers ("*", "/api/*") are fallbacks, not concrete routes.
      if (path.includes("*") || !path.startsWith("/api")) continue;
      routes.add(path);
    }
  }
  return [...routes].sort();
}

/** Paths the asset layer must keep owning: the SPA shell and hashed bundles. */
const ASSET_PATHS = ["/", "/indexing", "/companies/acme", "/assets/index-abc123.js", "/favicon.svg"];

/* -------------------------------------------------------------------------- */

describe("Static-asset routing configuration", () => {
  test("both deployments parse to a non-empty API route list", () => {
    // Guards the parser itself: an empty list would make every routing assertion
    // below vacuously true.
    expect(apiRoutes().length).toBeGreaterThan(10);
    expect(apiRoutes()).toContain("/api/health");
    expect(apiRoutes()).toContain("/api/cloud/jobs");
  });

  for (const file of CONFIGS) {
    test(`${file}: every /api route reaches the Worker before the asset layer`, () => {
      const source = config(file);
      expect(source).toMatch(/^main\s*=\s*"worker\/src\/index\.ts"$/m);
      expect(tomlTable(source, "[assets]")).toMatch(/binding\s*=\s*"ASSETS"/);
      expect(tomlTable(source, "[assets]")).toMatch(/not_found_handling\s*=\s*"single-page-application"/);

      const patterns = workerFirstPatterns(source);
      for (const path of apiRoutes()) {
        expect({ path, workerFirst: routesToWorkerFirst(patterns, path) }).toEqual({ path, workerFirst: true });
      }
    });

    test(`${file}: the SPA shell and hashed assets are still served directly`, () => {
      const patterns = workerFirstPatterns(config(file));
      for (const path of ASSET_PATHS) {
        expect({ path, workerFirst: routesToWorkerFirst(patterns, path) }).toEqual({ path, workerFirst: false });
      }
    });

    test(`${file}: the fix does not disturb Access, R2, containers or the budget`, () => {
      const source = config(file);
      const settings = configLines(file);
      // Access is configured with `wrangler secret put`, never in the file: the
      // names must stay absent from the settings and the Worker must keep verifying.
      for (const secret of ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "ALLOWED_EMAILS", "INDEXING_ADMIN_EMAILS"]) {
        expect(settings).not.toContain(secret);
      }
      expect(source).toMatch(/binding\s*=\s*"COMPANY_DATA"/);
      expect(source).toMatch(/bucket_name\s*=\s*"company-intel-data"/);
      // Production declares the wide swarm container AND keeps the single-job
      // container; staging keeps only the latter, at one instance.
      if (file === "wrangler.toml") {
        expect(source).toMatch(/class_name\s*=\s*"IndexerWorker"/);
        expect(source).toMatch(/instance_type\s*=\s*"standard-4"/);
        expect(source).toMatch(/max_instances\s*=\s*64/);
      } else {
        expect(source).toMatch(/max_instances\s*=\s*1/);
      }
      expect(source).toMatch(/class_name\s*=\s*"IndexerContainer"/);
      expect(source).toMatch(/^CLOUD_JOB_BUDGET_USD\s*=\s*"\d+"$/m);
      // And the Worker still gates every API route on the Access JWT.
      expect(readFileSync(join(root, "worker/src/app.ts"), "utf8")).toContain('app.use("/api/*"');
      expect(readFileSync(join(root, "worker/src/indexer-admin.ts"), "utf8")).toContain("verifyAccess(");
    });
  }

  test("staging keeps its isolation switches alongside the routing change", () => {
    const staging = config("wrangler.staging.toml");
    expect(staging).toMatch(/^STAGING_MODE\s*=\s*"true"$/m);
    expect(staging).toMatch(/^ACTIVE_MANIFEST_KEY\s*=\s*"staging\/active\.json"$/m);
    expect(staging).toMatch(/^name\s*=\s*"companyintel-staging"$/m);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * An ASSETS binding that answers every path with the SPA shell and a 200, which is
 * exactly what the deployed staging asset layer did to the API. If any API request
 * can reach this object, the implementation is wrong.
 */
const shellAssets = {
  async fetch(input: RequestInfo | URL): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const isBundle = url.pathname.startsWith("/assets/");
    return new Response(isBundle ? "console.log(1);" : SHELL, {
      status: 200,
      headers: { "content-type": isBundle ? "text/javascript" : "text/html; charset=utf-8" },
    });
  },
} as unknown as Fetcher;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function envFor(overrides: Partial<EnvWithContainer> = {}): EnvWithContainer {
  return {
    COMPANY_DATA: new FakeR2Bucket() as unknown as R2Bucket,
    ASSETS: shellAssets,
    ENVIRONMENT: "development",
    DEV_ALLOW_UNAUTHENTICATED: "true",
    MAX_SEARCHES_PER_MINUTE: "1000",
    APP_VERSION: "test",
    ...overrides,
  } as unknown as EnvWithContainer;
}

/** Parsed body of an arbitrary API response, including the error envelope. */
type JsonBody = {
  ok?: boolean;
  service?: string;
  staging?: boolean;
  jobs?: unknown[];
  error?: { code?: string; message?: string };
};

type Call = { status: number; contentType: string; text: string; json: JsonBody | null };

async function call(path: string, overrides: Partial<EnvWithContainer> = {}, init?: RequestInit): Promise<Call> {
  const response = await worker.fetch(new Request(`https://companyintel-staging.example${path}`, init), envFor(overrides), ctx);
  const text = await response.text();
  let json: JsonBody | null = null;
  try {
    json = JSON.parse(text) as JsonBody;
  } catch {
    json = null;
  }
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", text, json };
}

describe("Worker entrypoint dispatch", () => {
  test("/api/health reaches its handler and answers JSON even if ASSETS would return the shell", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("application/json");
    expect(response.text).not.toContain("<!doctype html>");
    expect(response.json?.ok).toBe(true);
    expect(response.json?.service).toBe("companyintel-worker");
  });

  test("/api/cloud/jobs reaches the indexing control plane, not the app catch-all", async () => {
    const response = await call("/api/cloud/jobs");
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("application/json");
    expect(Array.isArray(response.json?.jobs)).toBe(true);
    expect(response.json?.staging).toBe(false);
  });

  test("every registered API route answers as JSON or CSV, never as the SPA shell", async () => {
    for (const path of apiRoutes()) {
      const response = await call(path);
      expect({ path, html: response.contentType.includes("text/html") }).toEqual({ path, html: false });
      // An API path must also never be answered by the shell body.
      expect({ path, shell: response.text.includes('<div id="root">') }).toEqual({ path, shell: false });
    }
  });

  test("unknown API paths are JSON 404s in both routers", async () => {
    for (const path of ["/api", "/api/nope", "/api/cloud/nope"]) {
      const response = await call(path);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect({ path, json: response.contentType.includes("application/json") }).toEqual({ path, json: true });
      expect({ path, code: response.json?.error?.code }).toEqual({ path, code: "not_found" });
    }
  });

  test("the SPA is still served for non-API paths", async () => {
    for (const path of ["/", "/indexing", "/companies/acme"]) {
      const response = await call(path);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect({ path, html: response.contentType.includes("text/html") }).toEqual({ path, html: true });
      expect({ path, shell: response.text.includes('<div id="root">') }).toEqual({ path, shell: true });
    }
  });

  test("Access verification still gates the API: no token means no result, in JSON", async () => {
    const production = { ENVIRONMENT: "production", DEV_ALLOW_UNAUTHENTICATED: "false" };
    for (const path of ["/api/health", "/api/cloud/jobs"]) {
      const response = await call(path, production);
      expect({ path, refused: response.status >= 400 }).toEqual({ path, refused: true });
      expect({ path, json: response.contentType.includes("application/json") }).toEqual({ path, json: true });
      expect({ path, code: response.json?.error?.code }).toEqual({ path, code: "unauthorized" });
    }
  });

  test("the dev bypass cannot engage in production", async () => {
    // `DEV_ALLOW_UNAUTHENTICATED` is set but ENVIRONMENT is production: refuse.
    const response = await call("/api/health", { ENVIRONMENT: "production", DEV_ALLOW_UNAUTHENTICATED: "true" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.json?.error?.code).toBe("unauthorized");
  });
});
