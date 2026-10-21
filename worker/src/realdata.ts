/**
 * REAL DATA provenance and bounded direct-scan API.
 *
 *   GET  /api/realdata/coverage          what the active dataset actually contains
 *   POST /api/realdata/scan              start (or reuse) a bounded source scan
 *   GET  /api/realdata/scan/:jobId       poll a scan and read its progressive results
 *   POST /api/realdata/scan/:jobId/cancel stop a running scan
 *
 * Level order is enforced by the callers, not assumed here: the search pages use
 * the normal index first (level 2), and only ask this module when the user wants a
 * record outside the activated coverage (level 3). Nothing in this file scans a
 * file inside a Worker request — it starts the existing indexing container with a
 * `scan` command and follows `realdata/scans/<jobId>/status.json` in R2.
 *
 * Safety properties:
 *   - Access is verified by the app-wide `/api/*` middleware before any handler;
 *     this module adds same-origin (also app-wide) and job ownership checks.
 *   - a job id is derived from (dataset version, kind, normalised query, budget), so
 *     a double click cannot create two scans of the same query;
 *   - the byte budget comes from `REALDATA_SCAN_MAX_MB` and is clamped; a caller can
 *     lower it, never raise it;
 *   - completed results are cached per dataset version and query. A cache entry is
 *     never treated as proof that a record does not exist: it carries the scanned
 *     byte counts and the job's bounded `complete` flag.
 */

import { Hono } from "hono";
import { z } from "zod";

import type { AccessIdentity, Env } from "./env";
import type { EnvWithContainer } from "./indexer-container";
import { R2Store } from "./store";
import { normalizeQuery } from "../../src/shared/normalize";
import { stableHash } from "../../src/shared/hash";
import {
  REALDATA_LIMITS,
  isCacheKey,
  isScanJobId,
  realDataKeys,
  type RealDataCoverage,
  type RealDataCoverageResponse,
  type RealDataScanCacheEntry,
  type RealDataScanKind,
  type RealDataScanResponse,
  type RealDataScanResults,
  type RealDataScanStartResponse,
  type RealDataScanStatus,
} from "../../src/shared/realdata/types";

type Variables = { identity: AccessIdentity; store: R2Store };

export const realdataRoutes = new Hono<{ Bindings: EnvWithContainer; Variables: Variables }>();

const scanRequestSchema = z.object({
  q: z.string().trim().min(1).max(REALDATA_LIMITS.maxQueryLength),
  kind: z.enum(["companies", "contacts", "both"]).optional(),
  // A caller may ask for any number here; the handler clamps it to this deployment's
  // budget (and to the hard ceiling). Rejecting a larger value instead would make
  // the UI's "scan deeper" request fail rather than safely use the configured limit.
  maxMb: z.number().int().positive().max(1_000_000).optional(),
  force: z.boolean().optional(),
});

interface ScanRequestRecord {
  jobId: string;
  query: string;
  kind: RealDataScanKind;
  maxMb: number;
  limit: number;
  datasetVersion: string;
  email: string;
  createdAt: string;
}

interface ActiveScanPointer {
  jobId: string;
  email: string;
  startedAt: string;
}

function scanBudgetMb(env: Env): number {
  const configured = Number(env.REALDATA_SCAN_MAX_MB);
  if (!Number.isFinite(configured) || configured <= 0) return REALDATA_LIMITS.defaultScanMb;
  return Math.min(Math.round(configured), REALDATA_LIMITS.maxScanMb);
}

function cacheKeyFor(kind: RealDataScanKind, normalizedQuery: string, maxMb: number): string {
  return stableHash(`${kind}|${normalizedQuery}|${maxMb}`).slice(0, 32);
}

function emailHash(email: string): string {
  return stableHash(email.toLowerCase()).slice(0, 16);
}

function isFresh(status: RealDataScanStatus | null): boolean {
  if (!status || (status.state !== "running" && status.state !== "queued")) return false;
  const at = Date.parse(status.heartbeatAt ?? status.updatedAt);
  return Number.isFinite(at) && Date.now() - at < REALDATA_LIMITS.staleMs;
}

async function readJson<T>(store: R2Store, key: string): Promise<T | null> {
  return store.getJson<T>(key);
}

/* ------------------------------- coverage -------------------------------- */

realdataRoutes.get("/api/realdata/coverage", async (c) => {
  const store = c.get("store");
  const checkedAt = new Date().toISOString();
  const budget = scanBudgetMb(c.env);
  const scanAvailable = Boolean(c.env.INDEXER_CONTAINER);
  const pointer = await store.getActivePointer().catch(() => null);
  if (!pointer?.version) {
    const response: RealDataCoverageResponse = {
      version: null,
      dataOrigin: "none",
      label: "NO REAL DATA ACTIVE",
      partial: true,
      companies: 0,
      contacts: 0,
      coverage: null,
      scanBudgetMb: budget,
      scanAvailable,
      directScan: scanAvailable,
      checkedAt,
      message: "No real-data dataset is activated on this deployment.",
    };
    return c.json(response);
  }
  const [manifest, coverage] = await Promise.all([
    store.getManifest(pointer.version),
    readJson<RealDataCoverage>(store, realDataKeys.coverage(pointer.version)),
  ]);
  const companies = manifest?.counters?.uniqueCompanies ?? 0;
  const contacts = manifest?.counters?.uniqueContacts ?? 0;
  const partial = coverage?.partial ?? true;
  const label = coverage?.label ?? (partial ? "REAL DATA — PARTIAL COVERAGE" : "REAL DATA — COMPLETE COVERAGE");
  const response: RealDataCoverageResponse = {
    version: pointer.version,
    dataOrigin: "r2",
    label,
    partial,
    companies,
    contacts,
    coverage: coverage
      ? {
          ...coverage,
          companies,
          contacts,
          lastRefreshAt: manifest?.completedAt ?? coverage.generatedAt,
        }
      : null,
    scanBudgetMb: budget,
    scanAvailable,
    directScan: scanAvailable,
    checkedAt,
    message: partial
      ? `Search is answering from ${companies.toLocaleString()} companies and ${contacts.toLocaleString()} contacts read from the original R2 files. The rest of the 64 GB corpus has not been indexed yet; a bounded source scan can look for a specific record outside this coverage.`
      : `Search is answering from the complete indexed corpus (${companies.toLocaleString()} companies, ${contacts.toLocaleString()} contacts).`,
  };
  return c.json(response);
});

/* --------------------------------- start --------------------------------- */

realdataRoutes.post("/api/realdata/scan", async (c) => {
  const store = c.get("store");
  const identity = c.get("identity");
  const body = scanRequestSchema.parse(await c.req.json().catch(() => ({})));
  const pointer = await store.getActivePointer().catch(() => null);
  if (!pointer?.version) {
    return c.json(
      { error: { code: "dataset_unavailable", message: "No real-data dataset is active, so there is nothing to correlate a scan with." } },
      503,
    );
  }
  const kind: RealDataScanKind = body.kind ?? "both";
  const requested = body.maxMb ?? scanBudgetMb(c.env);
  const maxMb = Math.min(requested, scanBudgetMb(c.env), REALDATA_LIMITS.maxScanMb);
  const normalizedQuery = normalizeQuery(body.q);
  const cacheKey = cacheKeyFor(kind, normalizedQuery, maxMb);
  const datasetVersion = pointer.version;

  // Level 1: a completed, version-scoped scan result is returned immediately.
  const cached = await readJson<RealDataScanCacheEntry>(store, realDataKeys.cache(datasetVersion, cacheKey));
  if (cached && !body.force) {
    const response: RealDataScanStartResponse = {
      jobId: cached.jobId,
      state: "complete",
      cacheHit: true,
      cached: {
        jobId: cached.jobId,
        status: cached.status,
        results: cached.results,
        cacheHit: true,
        datasetVersion,
        tookMs: 0,
      },
      message: "Returned a verified direct-scan result from the cache; no source bytes were read.",
    };
    return c.json(response, 200);
  }

  const suffix = body.force ? `-${Date.now().toString(36)}` : "";
  const jobId = `scan-${stableHash(`${datasetVersion}|${kind}|${normalizedQuery}|${maxMb}`).slice(0, 24)}${suffix}`;
  if (!isScanJobId(jobId)) {
    return c.json({ error: { code: "invalid_request" as const, message: "The derived scan id is invalid." } }, 400);
  }

  // A scan for the same query/version that is still live is reused, not duplicated.
  const existing = await readJson<RealDataScanStatus>(store, realDataKeys.scanStatus(jobId));
  if (isFresh(existing)) {
    const response: RealDataScanStartResponse = {
      jobId,
      state: existing?.state ?? "queued",
      cacheHit: false,
      cached: null,
      message: "A scan for this query is already running; poll the existing job.",
    };
    return c.json(response, 202);
  }

  // One live scan per identity: an accidental second tab cannot double the spend.
  const lockKey = realDataKeys.activeScan(emailHash(identity.email));
  const lock = await readJson<ActiveScanPointer>(store, lockKey);
  if (lock && lock.jobId !== jobId) {
    const other = await readJson<RealDataScanStatus>(store, realDataKeys.scanStatus(lock.jobId));
    if (isFresh(other)) {
      return c.json(
        {
          error: {
            code: "scan_already_running" as const,
            message: `A source scan is already running for this account (${lock.jobId}). Cancel it before starting another.`,
          },
          jobId: lock.jobId,
        },
        409,
      );
    }
  }

  const limit = Math.min(REALDATA_LIMITS.defaultLimit, REALDATA_LIMITS.maxLimit);
  const request: ScanRequestRecord = {
    jobId,
    query: body.q.trim(),
    kind,
    maxMb,
    limit,
    datasetVersion,
    email: identity.email,
    createdAt: new Date().toISOString(),
  };
  await store.putJson(realDataKeys.scanRequest(jobId), request);
  await store.putJson(lockKey, { jobId, email: identity.email, startedAt: request.createdAt } satisfies ActiveScanPointer);

  const container = c.env.INDEXER_CONTAINER;
  if (!container) {
    return c.json(
      {
        error: {
          code: "scan_unavailable" as const,
          message:
            "The scanning container is not bound to this deployment. Indexed search still works; a direct source scan needs the INDEXER_CONTAINER binding.",
        },
        jobId,
        maxMb,
      },
      503,
    );
  }
  const args = [
    "scan",
    "--version",
    jobId,
    "--query",
    request.query,
    "--kind",
    kind,
    "--max-mb",
    String(maxMb),
    "--limit",
    String(limit),
    "--dataset-version",
    datasetVersion,
  ];
  const stub = container.get(container.idFromName("indexer"));
  try {
    const response = await stub.fetch("http://container/job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args, detach: true }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { started?: boolean; completed?: boolean; error?: { code?: string; message?: string; detail?: string } }
      | null;
    if (!response.ok) {
      const code = payload?.error?.code ?? "container_rejected";
      const message = payload?.error?.message ?? `The scan container rejected the job (HTTP ${response.status}).`;
      const status = response.status === 409 ? 409 : response.status === 503 ? 503 : 502;
      return c.json({ error: { code, message }, jobId }, status as 409 | 502 | 503);
    }
    const started = payload?.started !== false;
    const result: RealDataScanStartResponse = {
      jobId,
      state: started ? "queued" : "complete",
      cacheHit: false,
      cached: null,
      message: started
        ? `Scanning the original source files, up to ${maxMb} MB per source. Poll this job for progressive results.`
        : "The scan completed before it could be detached; read its status for results.",
    };
    return c.json(result, started ? 202 : 200);
  } catch (error) {
    return c.json(
      {
        error: {
          code: "container_unreachable" as const,
          message: `The scan container did not accept the job: ${error instanceof Error ? error.message : String(error)}`,
        },
        jobId,
      },
      502,
    );
  }
});

/* ---------------------------------- poll --------------------------------- */

realdataRoutes.get("/api/realdata/scan/:jobId", async (c) => {
  const store = c.get("store");
  const identity = c.get("identity");
  const jobId = c.req.param("jobId");
  if (!isScanJobId(jobId)) {
    return c.json({ error: { code: "invalid_request" as const, message: "Invalid scan job id." } }, 400);
  }
  const started = Date.now();
  const request = await readJson<ScanRequestRecord>(store, realDataKeys.scanRequest(jobId));
  if (!request) {
    return c.json({ error: { code: "not_found" as const, message: `Scan ${jobId} was not found.` } }, 404);
  }
  if (request.email.toLowerCase() !== identity.email.toLowerCase()) {
    return c.json({ error: { code: "forbidden" as const, message: "This scan belongs to another account." } }, 403);
  }
  const [status, results, cancel] = await Promise.all([
    readJson<RealDataScanStatus>(store, realDataKeys.scanStatus(jobId)),
    readJson<RealDataScanResults>(store, realDataKeys.scanResults(jobId)),
    readJson<unknown>(store, realDataKeys.scanCancel(jobId)),
  ]);
  const effective: RealDataScanStatus = status ?? {
    format: 1,
    jobId,
    query: request.query,
    normalizedQuery: normalizeQuery(request.query),
    kind: request.kind,
    state: "queued",
    startedAt: request.createdAt,
    updatedAt: request.createdAt,
    sources: [],
    totals: { bytesScanned: 0, bytesTotal: 0, coveragePercent: 0, recordsScanned: 0, companies: 0, contacts: 0, dropped: 0 },
    limit: request.limit,
    maxMbPerSource: request.maxMb,
    datasetVersion: request.datasetVersion,
    complete: false,
    reason: cancel ? "Cancellation requested; the scan stops at its next window." : "Queued for the scanning container.",
  };

  // A completed job is cached once, keyed by the dataset version and query, so a
  // repeated search costs no source reads and is invalidated by the next activation.
  if (effective.state === "complete" && results) {
    const key = realDataKeys.cache(
      request.datasetVersion,
      cacheKeyFor(request.kind, normalizeQuery(request.query), request.maxMb),
    );
    const existing = await readJson<unknown>(store, key);
    if (!existing) {
      const entry: RealDataScanCacheEntry = {
        format: 1,
        jobId,
        datasetVersion: request.datasetVersion,
        query: request.query,
        normalizedQuery: normalizeQuery(request.query),
        kind: request.kind,
        createdAt: new Date().toISOString(),
        status: effective,
        results,
      };
      await store.putJson(key, entry).catch(() => {
        // A cache write failure must not hide a completed scan from its caller.
      });
    }
  }

  const response: RealDataScanResponse = {
    jobId,
    status: effective,
    results: results ?? null,
    cacheHit: false,
    datasetVersion: request.datasetVersion,
    tookMs: Date.now() - started,
  };
  return c.json(response);
});

/* --------------------------------- cancel -------------------------------- */

realdataRoutes.post("/api/realdata/scan/:jobId/cancel", async (c) => {
  const store = c.get("store");
  const identity = c.get("identity");
  const jobId = c.req.param("jobId");
  if (!isScanJobId(jobId)) {
    return c.json({ error: { code: "invalid_request" as const, message: "Invalid scan job id." } }, 400);
  }
  const request = await readJson<ScanRequestRecord>(store, realDataKeys.scanRequest(jobId));
  if (!request) {
    return c.json({ error: { code: "not_found" as const, message: `Scan ${jobId} was not found.` } }, 404);
  }
  if (request.email.toLowerCase() !== identity.email.toLowerCase()) {
    return c.json({ error: { code: "forbidden" as const, message: "This scan belongs to another account." } }, 403);
  }
  const status = await readJson<RealDataScanStatus>(store, realDataKeys.scanStatus(jobId));
  if (status?.state === "complete") {
    return c.json({ cancelled: false, alreadyComplete: true, jobId });
  }
  await store.putJson(realDataKeys.scanCancel(jobId), { at: new Date().toISOString(), by: identity.email });
  return c.json({ cancelled: true, jobId, message: "The scan stops at its next window and keeps what it already found." });
});

/** Exposed for the coverage tests: a cache key must be a safe path component. */
export function isValidScanCacheKey(value: string): boolean {
  return isCacheKey(value);
}
