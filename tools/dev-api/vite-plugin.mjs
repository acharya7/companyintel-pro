/**
 * CompanyIntel — private development API for the Freebuff preview.
 *
 * WHY A DEV SERVER AND NOT A DEPLOYED WORKER
 * ------------------------------------------
 * The preview is a static Vite app on a sandbox URL, so it cannot reach a private
 * R2 bucket (credentials can never ship to a browser) and the platform runs no
 * Worker. Deploying one is also blocked here: this environment has no Cloudflare
 * API token (`wrangler whoami` → not authenticated). What IS available is a Node
 * process — the Vite dev server — with network access and the R2 S3 keys.
 *
 * So this plugin mounts the REAL Worker application at `/api/*` inside the dev
 * server:
 *
 *   browser  →  /api/…  →  worker/src/index.ts (the production Hono app)
 *                          ↳ COMPANY_DATA = S3-backed binding shim
 *                          ↳ Cloudflare Access bypassed for `development` only
 *                          ↳ the real R2 bucket company-intel-data
 *
 * That makes the preview exercise the production API routes, the production index
 * reader and the production search engine against the real bucket. Only the
 * binding is substituted.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 *   - it never writes an index object, a manifest or source data (see
 *     `dev-bucket.mjs`: only `app-data/…` in memory and the in-process active
 *     pointer are writable);
 *   - it never touches `manifests/active.json` in R2, so nothing can be activated
 *     for production from a browser session;
 *   - it is added only for `serve`, so `bun run build` keeps the client in its
 *     configured mode and ships no dev code;
 *   - it never logs a credential or a record value.
 *
 * The index version served is chosen in this order:
 *   1. `COMPANYINTEL_DEV_DATASET_VERSION` — explicit, used by the dev scripts;
 *   2. the newest `manifests/<version>/manifest.json` under a `dev-` prefix;
 *   3. the newest manifest of any version that passed validation;
 *   4. the real `manifests/active.json` if one exists.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createDevBucket } from "./dev-bucket.mjs";

export const DEV_VERSION_ENV = "COMPANYINTEL_DEV_DATASET_VERSION";
export const DEV_BUCKET_ENV = "COMPANYINTEL_DEV_BUCKET";

/** Read the request body of a Node `IncomingMessage` (may be absent for GET/HEAD). */
function readBody(request) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve_(chunks.length ? Buffer.concat(chunks) : undefined));
    request.on("error", reject);
  });
}

/**
 * The origin the browser used, so the Worker's own same-origin check passes even
 * when the sandbox sits behind a proxy that reports a different `Host`.
 */
function originFor(request) {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin) return origin;
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host ?? "localhost:5173";
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? "http";
  return `${proto}://${host}`;
}

/** Convert a Node request into a WHATWG Request the Hono app can route. */
async function toRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else headers.set(name, value);
  }
  const method = (request.method ?? "GET").toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
  return new Request(new URL(request.url ?? "/", originFor(request)), { method, headers, body });
}

/** Write a WHATWG Response back to the Node response. */
async function writeResponse(response, nodeResponse) {
  nodeResponse.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (["content-encoding", "content-length", "transfer-encoding"].includes(name)) continue;
    nodeResponse.setHeader(name, value);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  nodeResponse.end(buffer);
}

/** Choose the index version the dev server serves. */
async function resolveVersion(client, requested) {
  if (requested) return requested;
  try {
    const objects = await client.list("manifests/", 1000);
    const versions = objects
      .filter((object) => object.key.endsWith("/manifest.json"))
      .map((object) => object.key.slice("manifests/".length, -"/manifest.json".length));
    if (versions.length) {
      const dev = versions.filter((version) => version.startsWith("dev-")).sort().reverse();
      return (dev[0] ?? versions.sort().reverse()[0]) ?? null;
    }
  } catch {
    // An unreadable manifest list is not fatal: the real pointer below may answer.
  }
  try {
    const pointer = await client.get("manifests/active.json");
    if (pointer.ok) {
      const parsed = await pointer.json();
      return parsed?.version ?? null;
    }
  } catch {
    // No pointer, no index: the API will answer with its own honest "no dataset" state.
  }
  return null;
}

/**
 * Build the request handler. Loading the Worker and the S3 client through Vite's
 * SSR module runner keeps ONE implementation of each: the same `worker/src/app.ts`
 * that runs in production, and the same signed R2 client the indexer uses.
 */
async function createHandler(server, options) {
  const { R2Client, credentialsFromEnv } = await server.ssrLoadModule("/tools/indexer/src/r2.ts");
  const workerEntry = await server.ssrLoadModule("/worker/src/index.ts");
  const worker = workerEntry.default ?? workerEntry;

  const bucket = options.bucket ?? process.env[DEV_BUCKET_ENV] ?? "company-intel-data";
  const credentials = credentialsFromEnv(bucket);
  if (!credentials) {
    throw new Error(
      `The development API needs R2 credentials for ${bucket}. ` +
        "Add them to .r2-credentials.json (the same private file the indexer uses) or set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.",
    );
  }

  const client = new R2Client(credentials);
  const version = await resolveVersion(client, options.version ?? process.env[DEV_VERSION_ENV] ?? null);

  const remote = {
    async head(key) {
      const head = await client.head(key);
      if (!head.exists) return null;
      return { key, size: head.size ?? 0, etag: head.etag ?? null };
    },
    async getBytes(key) {
      const response = await client.get(key);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const contentEncoding = response.headers.get("content-encoding") ?? undefined;
      const etag = (response.headers.get("etag") ?? "").replace(/"/g, "") || null;
      return { bytes, httpMetadata: { contentType, ...(contentEncoding ? { contentEncoding } : {}) }, etag, size: bytes.length };
    },
    async list(prefix, limit, cursor) {
      return client.listPage(prefix, limit, cursor);
    },
  };

  const dataBucket = createDevBucket({
    remote,
    version,
    log: (message) => server.config.logger.info(`  [dev-api] ${message}`),
  });

  const env = {
    // The ONLY substitution: the binding. Everything else is a development value.
    COMPANY_DATA: dataBucket,
    ENVIRONMENT: "development",
    APP_VERSION: "0.1.0-dev-api",
    DEV_ALLOW_UNAUTHENTICATED: "true",
    MAX_SEARCHES_PER_MINUTE: "1000000",
    SEARCH_MAX_HYDRATE: "16",
  };

  const context = { waitUntil: () => {}, passThroughOnException: () => {} };

  if (version) {
    server.config.logger.info(`  [dev-api] serving index version ${version} from bucket ${bucket} (read-only; active pointer untouched)`);
  } else {
    server.config.logger.warn(
      "  [dev-api] no index version found. Run `bun run dev:index` to build a real development index from R2, " +
        "or set COMPANYINTEL_DEV_DATASET_VERSION.",
    );
  }

  return {
    version,
    bucket,
    async handle(request, response) {
      const started = Date.now();
      const apiRequest = await toRequest(request);
      const apiResponse = await worker.fetch(apiRequest, env, context);
      // A dev-only marker, so a browser can prove which process answered.
      apiResponse.headers.set("x-companyintel-dev-api", version ?? "no-version");
      await writeResponse(apiResponse, response);
      server.config.logger.info(`  [dev-api] ${apiRequest.method} ${new URL(apiRequest.url).pathname} → ${apiResponse.status} (${Date.now() - started} ms)`);
    },
  };
}

/**
 * Vite plugin. Added only in `serve` (see vite.config.ts), so no development code
 * can reach a production build.
 */
export function companyIntelDevApi(options = {}) {
  const root = options.root ?? process.cwd();
  return {
    name: "companyintel-dev-api",
    apply: "serve",
    async configureServer(server) {
      let handler = null;
      let failure = null;
      /*
       * Drop the cached handler when the R2 client, the bucket shim or the Worker
       * changes. Vite invalidates those SSR modules itself, but the handler holds
       * the *old* module objects; without this, a fix to `r2.ts` looks like it did
       * nothing until the whole dev server happens to restart.
       */
      /*
       * Any module the handler was built from. The Worker routes, the shared
       * search/index code and the R2 client all load through Vite's SSR module
       * runner, and the handler closure keeps the OLD module objects alive — so an
       * edit to `worker/src/app.ts` would otherwise look like it did nothing until
       * the dev server happened to restart.
       */
      const watchedDirs = [
        resolve(root, "worker/src"),
        resolve(root, "src/shared"),
        resolve(root, "tools/indexer/src"),
        resolve(root, "tools/dev-api"),
      ].filter((dir) => existsSync(dir));
      const invalidate = (file) => {
        if (!watchedDirs.some((dir) => file.startsWith(dir))) return;
        handler = null;
        failure = null;
      };
      server.watcher.on("change", invalidate);
      server.watcher.on("add", invalidate);
      server.middlewares.use(async (request, response, next) => {
        const url = request.url ?? "/";
        if (!url.startsWith("/api/")) return next();
        if (process.env.COMPANYINTEL_DEV_API === "off") return next();
        try {
          if (!handler && !failure) handler = await createHandler(server, options);
          if (failure) throw failure;
          await handler.handle(request, response);
        } catch (error) {
          failure = error;
          server.config.logger.error(`  [dev-api] ${error?.message ?? error}`);
          response.statusCode = 503;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              error: {
                code: "dev_api_unavailable",
                message: `The private development API is not available: ${error?.message ?? error}`,
              },
            }),
          );
        }
      });
    },
  };
}

/** True when the given project root looks like a CompanyIntel checkout. */
export function looksLikeCompanyIntel(root) {
  return existsSync(resolve(root, "worker/src/app.ts")) && existsSync(resolve(root, "tools/indexer/src/r2.ts"));
}
