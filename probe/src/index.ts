/**
 * CompanyIntel R2 probe — read-only, development only.
 *
 * The smallest possible Worker that can answer the question "is the real
 * `company-intel-data` bucket reachable, what is under `raw/`, and what do those
 * two CSVs actually look like?" — using the native `COMPANY_DATA` binding, so no
 * R2 S3 access key or secret ever exists for this path.
 *
 * Safety properties, all of them enforced by code and by tests:
 *   - only `list`, `head` and ranged `get` are ever called: the shared
 *     verification code receives a `ReadOnlyBucket`, which has no write method;
 *   - every read is bounded by the constants in `probe/wrangler.toml`, and query
 *     parameters may only ask for *less*;
 *   - non-GET/HEAD requests are refused with 405;
 *   - the probe refuses to answer when `ENVIRONMENT === "production"`, so it
 *     cannot be repurposed as a public read endpoint;
 *   - the report never contains cell values, contact names, emails or phones.
 *
 * It is started by `bun run verify:r2:remote` on 127.0.0.1 and is never deployed.
 */

import { buildSchemaReport, recommendedColumnOverride, type SchemaReport } from "../../src/shared/r2/schema";
import { verifyRawPrefix, type ReadOnlyBucket, type SourceVerification, type VerificationReport } from "../../src/shared/r2/verify";

export interface Env {
  /** Native R2 binding → company-intel-data (see probe/wrangler.toml). */
  COMPANY_DATA: R2Bucket;
  ENVIRONMENT?: string;
  PROBE_READ_ONLY?: string;
  RAW_PREFIX?: string;
  MAX_RAW_OBJECTS?: string;
  MAX_LIST_LIMIT?: string;
  MAX_READ_BYTES?: string;
  MAX_SAMPLE_BYTES?: string;
  MAX_SCHEMA_ROWS?: string;
}

const SERVICE = "companyintel-r2-probe";
const ABSOLUTE_MAX_LIST = 100;
const ABSOLUTE_MAX_READ_BYTES = 65536;
const ABSOLUTE_MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
const ABSOLUTE_MAX_ROWS = 5000;
/** Keys accepted in `?keys=`; a source list is never large. */
const MAX_EXPLICIT_KEYS = 8;
const KEY_PATTERN = /^[\w./-]+$/;

function positiveInt(raw: string | null | undefined, fallback: number, cap: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), cap);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-companyintel-probe": "read-only",
    },
  });
}

interface Bounds {
  prefix: string;
  maxObjects: number;
  maxPages: number;
  readBytes: number;
  sampleBytes: number;
  maxRows: number;
  keys: string[];
}

function resolveBounds(env: Env, url: URL): Bounds | { error: string } {
  const rawKeys = url.searchParams.get("keys");
  const keys = rawKeys
    ? rawKeys
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    : [];
  if (keys.length > MAX_EXPLICIT_KEYS) return { error: `at most ${MAX_EXPLICIT_KEYS} keys may be named` };
  for (const key of keys) {
    if (!KEY_PATTERN.test(key) || key.startsWith("/") || key.includes("..")) {
      return { error: `unsupported key: ${key}` };
    }
  }

  return {
    prefix: url.searchParams.get("prefix") ?? env.RAW_PREFIX ?? "raw/",
    maxObjects: positiveInt(url.searchParams.get("max"), positiveInt(env.MAX_RAW_OBJECTS, 25, ABSOLUTE_MAX_LIST), ABSOLUTE_MAX_LIST),
    maxPages: positiveInt(url.searchParams.get("pages"), 2, 4),
    readBytes: positiveInt(url.searchParams.get("readBytes"), 1024, positiveInt(env.MAX_READ_BYTES, ABSOLUTE_MAX_READ_BYTES, ABSOLUTE_MAX_READ_BYTES)),
    sampleBytes: positiveInt(
      url.searchParams.get("sampleBytes"),
      6 * 1024 * 1024,
      positiveInt(env.MAX_SAMPLE_BYTES, ABSOLUTE_MAX_SAMPLE_BYTES, ABSOLUTE_MAX_SAMPLE_BYTES),
    ),
    maxRows: positiveInt(url.searchParams.get("rows"), 500, positiveInt(env.MAX_SCHEMA_ROWS, ABSOLUTE_MAX_ROWS, ABSOLUTE_MAX_ROWS)),
    keys,
  };
}

/**
 * Bounded sample of one source object, profiled into a schema report.
 * `maxSamplesPerColumn: 0` inside the shared profiler is what keeps cell values
 * out of the report.
 */
async function inspectSource(bucket: ReadOnlyBucket, source: SourceVerification, bounds: Bounds): Promise<SchemaReport | null> {
  if (!source.present || !source.readable) return null;
  const body = await bucket.get(source.key, { range: { offset: 0, length: bounds.sampleBytes } });
  if (!body) return null;
  const bytes = new Uint8Array(await body.arrayBuffer());
  if (!bytes.length) return null;
  const objectBytes = typeof body.size === "number" ? body.size : source.sizeBytes;
  return buildSchemaReport({
    key: source.key,
    bytes,
    objectBytes: objectBytes ?? null,
    // The bound cut the read short only when we read exactly what we asked for
    // and the object is larger than that.
    truncatedByBound: bytes.length >= bounds.sampleBytes && (objectBytes === null || objectBytes === undefined || objectBytes > bytes.length),
    maxRows: bounds.maxRows,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: { code: "method_not_allowed", message: "The R2 probe is read-only: only GET and HEAD are supported." } }, 405);
    }

    // Guard: this Worker must never be reachable as production infrastructure.
    if (env.ENVIRONMENT === "production") {
      return json(
        {
          error: {
            code: "refused_production",
            message:
              "The R2 probe refused to run with ENVIRONMENT=production. It is a development-only, read-only probe: start it with `bun run verify:r2:remote` against probe/wrangler.toml.",
          },
        },
        403,
      );
    }

    // No cast: the real binding must be structurally assignable to the read-only
    // surface. If Cloudflare ever changed the binding shape, this stops compiling
    // instead of silently losing the guarantee.
    const bucket: ReadOnlyBucket = env.COMPANY_DATA;

    if (url.pathname === "/" || url.pathname === "/help") {
      return json({
        service: SERVICE,
        mode: "development-only read-only probe",
        bucket: "company-intel-data (via the COMPANY_DATA native binding, no S3 credentials)",
        routes: {
          "GET /health": "liveness — used by the verification script before it asks for a report",
          "GET /verify": "bounded raw/ listing, source presence, sizes, ETags and a 1 KB body read per source",
          "GET /schema": "bounded sample of each source: encoding, delimiter, headers, fill rates and mapping suggestions",
          "GET /report": "verification + schema in one document (what the script reads)",
        },
        parameters: {
          keys: "comma-separated exact object keys to verify (default: the two largest .csv objects)",
          max: "objects per page, and the number of objects reported (upper bound from config)",
          pages: "how many listing pages may be read",
          readBytes: "bounded body read per source, in bytes",
          sampleBytes: "bounded sample per source for the schema report",
          rows: "data rows inspected per source",
          prefix: "object prefix (default raw/)",
        },
        guarantees: [
          "read-only: no put, no delete, no upload path exists in this Worker",
          "every read is bounded, so a 50 GB object is never downloaded",
          "no cell values, names, emails or phone numbers appear in any response",
          "never deployed: started locally on 127.0.0.1 by `bun run verify:r2:remote`",
        ],
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: SERVICE, readOnly: true, environment: env.ENVIRONMENT ?? "unknown" });
    }

    const bounds = resolveBounds(env, url);
    if ("error" in bounds) return json({ error: { code: "bad_request", message: bounds.error } }, 400);

    const wantsSchema = url.pathname === "/schema" || url.pathname === "/report";
    const wantsVerification = url.pathname === "/verify" || url.pathname === "/report";

    if (!wantsSchema && !wantsVerification) {
      return json({ error: { code: "not_found", message: `Unknown probe route ${url.pathname}. See GET / for the route list.` } }, 404);
    }

    try {
      const verification: VerificationReport | null = wantsVerification
        ? await verifyRawPrefix(bucket, {
            prefix: bounds.prefix,
            maxObjects: bounds.maxObjects,
            maxPages: bounds.maxPages,
            readBytes: bounds.readBytes,
            keys: bounds.keys,
          })
        : null;

      let sources: SourceVerification[] = verification?.sources ?? [];
      if (!verification && wantsSchema) {
        // `/schema` on its own still needs the bounded listing to know the keys.
        const listing = await verifyRawPrefix(bucket, {
          prefix: bounds.prefix,
          maxObjects: bounds.maxObjects,
          maxPages: bounds.maxPages,
          readBytes: bounds.readBytes,
          keys: bounds.keys,
          includeDataset: false,
        });
        sources = listing.sources;
        if (listing.access === "denied") {
          return json({ error: { code: "access_denied", message: listing.problems.join("; ") } }, 502);
        }
      }

      const schemas: { key: string; report: SchemaReport; columnsOverride: Record<string, string> }[] = [];
      for (const source of sources) {
        const report = await inspectSource(bucket, source, bounds);
        if (report) schemas.push({ key: source.key, report, columnsOverride: recommendedColumnOverride(report) });
      }

      const payload = {
        service: SERVICE,
        generatedAt: new Date().toISOString(),
        readOnly: true,
        bounds,
        verification,
        schemas,
      };
      return json(url.pathname === "/verify" ? { ...payload, schemas: undefined } : payload);
    } catch (error) {
      return json(
        {
          error: {
            code: "probe_failed",
            message: error instanceof Error ? error.message : String(error),
            hint: "If this mentions authentication, run `bunx wrangler login` once, then retry. Nothing was written to the bucket.",
          },
        },
        502,
      );
    }
  },
};
