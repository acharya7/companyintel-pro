/**
 * Cloud indexing control plane (deployed).
 *
 * This is the Worker-side equivalent of the dev server's `/api/cloud/…` routes, and
 * it exists so the `/indexing` panel works against a real deployment instead of only
 * in the preview. Everything it promises follows from three rules:
 *
 *   1. **Authorisation is server-side.** Every route runs behind the same
 *      `verifyAccess` middleware as the rest of `/api/*` (Cloudflare Access JWT
 *      verified against the team's JWKS and the audience), plus an email allowlist
 *      for the admin surface itself (`INDEXING_ADMIN_EMAILS`). The route path is not
 *      the control: an unauthenticated request is 401 before any handler runs.
 *   2. **Durable state lives in R2, not in the Worker.** Reads are the same
 *      `cloud/jobs/<version>/state.json` and `control.json` objects the container
 *      writes; controls write the same flags the engine checks between chunks.
 *      Nothing is held in isolate memory, so a redeploy or an eviction changes
 *      nothing an operator sees.
 *   3. **Credentials never reach the browser.** The Worker never returns an R2 key,
 *      nor any container environment variable. The container gets its R2
 *      credentials from the platform's secret store.
 *
 * The polling endpoint never sees a raw S3 secret: the Worker has no S3 client at all.
 * Activation uses the R2 binding (`publishVersion` with a `R2Bucket`-backed client).
 *
 * The router is mounted with `basePath("/api/cloud")`, which is the prefix the Worker
 * entrypoint dispatches on. Without it every route below would be registered one level
 * too shallow and answer 404 — `tests/staging-isolation.test.ts` drives these routes
 * with their real URLs, so that cannot regress silently.
 */

import type { Context } from "hono";
import { Hono } from "hono";

import {
  CLOUD_CONTROL_VERSION,
  cloudKeys,
  type CloudControl,
  type CloudJobState,
} from "../../src/shared/cloud/types";
import { verifyAccess, AccessError } from "./access";
import type { AccessIdentity } from "./env";
import type { EnvWithContainer } from "./indexer-container";

type AdminContext = Context<{ Bindings: EnvWithContainer; Variables: { identity: AccessIdentity } }>;

export const indexingAdmin = new Hono<{ Bindings: EnvWithContainer; Variables: { identity: AccessIdentity } }>().basePath(
  "/api/cloud",
);

/* ------------------------------- access ---------------------------------- */

indexingAdmin.use("*", async (c, next) => {
  // Same cross-origin rule as the rest of the API: an Access cookie is not a
  // licence for another origin to drive indexing controls.
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: { code: "forbidden" as const, message: "Cross-origin requests are not allowed on this API" } }, 403);
  }
  let identity: AccessIdentity;
  try {
    identity = await verifyAccess(c.req.raw, c.env);
  } catch (error) {
    const status = error instanceof AccessError ? error.status : 401;
    return c.json({ error: { code: "unauthorized" as const, message: "Cloudflare Access verification failed" } }, status as 401 | 403);
  }
  // Admin surface: the Access application must also allow THIS identity to operate
  // indexing. Unset means "the Access allowlist is the allowlist" (single-user
  // deployments), which is why it is not a silent bypass in production.
  const allowed = (c.env.INDEXING_ADMIN_EMAILS ?? c.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(identity.email.toLowerCase())) {
    return c.json({ error: { code: "forbidden" as const, message: "This identity may not operate indexing" } }, 403);
  }
  c.set("identity", identity);
  await next();
});

/* ------------------------------ helpers ---------------------------------- */

/**
 * Staging isolation is enforced here, not in configuration review.
 *
 * The staging Worker shares the R2 bucket (it must, to benchmark the real
 * sources), so it is kept away from production state by three rules that are
 * checked on every relevant request:
 *
 *   1. every version id starts with `stg-`, so its outputs live under
 *      `indexes/stg-…`, `companies/stg-…`, `manifests/stg-…` and no production
 *      versioned object can be overwritten;
 *   2. a full-corpus start is refused (only bounded benchmarks);
 *   3. activation writes `staging/active.json` (`ACTIVE_MANIFEST_KEY`), never
 *      `manifests/active.json`.
 */
function isStaging(env: EnvWithContainer): boolean {
  return (env.STAGING_MODE ?? "").toLowerCase() === "true";
}

function stagingVersionError(env: EnvWithContainer, version: string): Response | null {
  if (!isStaging(env)) return null;
  if (version.startsWith("stg-")) return null;
  return new Response(
    JSON.stringify({
      error: {
        code: "staging_version_prefix_required" as const,
        message: 'The staging deployment only accepts version ids that start with "stg-".',
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** The mutable dataset pointer for this deployment. */
function activeKeyFor(env: EnvWithContainer): string {
  const key = env.ACTIVE_MANIFEST_KEY;
  return key && key.trim() ? key : "manifests/active.json";
}

async function readState(env: EnvWithContainer, version: string): Promise<CloudJobState | null> {
  const object = await env.COMPANY_DATA.get(cloudKeys.state(version));
  return object ? ((await object.json()) as CloudJobState) : null;
}

async function readControl(env: EnvWithContainer, version: string): Promise<CloudControl | null> {
  const object = await env.COMPANY_DATA.get(cloudKeys.control(version));
  return object ? ((await object.json()) as CloudControl) : null;
}

async function writeControl(env: EnvWithContainer, version: string, control: CloudControl): Promise<void> {
  await env.COMPANY_DATA.put(cloudKeys.control(version), JSON.stringify(control), {
    httpMetadata: { contentType: "application/json" },
  });
}

const STATE_PREFIX = `${cloudKeys.jobRoot("")}`.replace(/\/$/, "");

/** Every job's durable state, newest first. Listing `cloud/jobs/` is one Class A op. */
async function listJobs(env: EnvWithContainer): Promise<{ state: CloudJobState; control: CloudControl | null }[]> {
  const listed = await env.COMPANY_DATA.list({ prefix: `${STATE_PREFIX}/`, limit: 200 });
  const keys = listed.objects
    .map((object) => object.key)
    .filter((key) => key.endsWith("/state.json"))
    // Staging shows its own jobs only: a production job id has no `stg-` prefix.
    .filter((key) => !isStaging(env) || key.startsWith(`${STATE_PREFIX}/stg-`));
  const jobs = await Promise.all(
    keys.map(async (key) => {
      const object = await env.COMPANY_DATA.get(key);
      if (!object) return null;
      const state = (await object.json()) as CloudJobState;
      return { state, control: await readControl(env, state.version) };
    }),
  );
  return jobs.filter((job): job is { state: CloudJobState; control: CloudControl | null } => job !== null)
    .sort((a, b) => (b.state.updatedAt ?? "").localeCompare(a.state.updatedAt ?? ""));
}

/**
 * Activation checks against R2, using the binding only.
 *
 * This mirrors the local indexer's `publishVersion`, but deliberately does not
 * import it: `worker/` must never depend on `tools/` (the S3 client and its
 * credentials live there), and the binding needs no credentials at all. The
 * version is activatable only when R2 itself holds a manifest that names this
 * version and a validation report that passed.
 */
async function verifyVersionInR2(bucket: R2Bucket, version: string): Promise<void> {
  const manifestObject = await bucket.get(`manifests/${version}/manifest.json`);
  if (!manifestObject) {
    throw new Error(
      `Version ${version} is not complete in R2: manifests/${version}/manifest.json is missing. Nothing was activated.`,
    );
  }
  const manifest = (await manifestObject.json()) as { version?: string; validationPassed?: boolean };
  if (manifest.version && manifest.version !== version) {
    throw new Error(`manifests/${version}/manifest.json describes version ${manifest.version}. Nothing was activated.`);
  }
  if (manifest.validationPassed === false) {
    throw new Error(`Version ${version} recorded a FAILED validation in R2 and cannot be activated.`);
  }
  const validationObject = await bucket.get(`manifests/${version}/validation.json`);
  if (!validationObject) {
    throw new Error(`Version ${version} has no uploaded validation report. Nothing was activated.`);
  }
  const validation = (await validationObject.json()) as { passed?: boolean };
  if (validation.passed !== true) {
    throw new Error(`Version ${version} did not pass the validation report stored in R2. Nothing was activated.`);
  }
}

/** Flip `manifests/active.json`, preserving the current version as the rollback target. */
async function activateVersion(bucket: R2Bucket, activeKey: string, version: string, actor: string): Promise<string | null> {
  let previousVersion: string | null = null;
  const current = await bucket.get(activeKey);
  if (current) {
    const pointer = (await current.json()) as { version?: string; previousVersion?: string | null };
    if (pointer.version && pointer.version !== version) previousVersion = pointer.version;
    else if (pointer.previousVersion && pointer.previousVersion !== version) previousVersion = pointer.previousVersion;
  }
  await bucket.put(
    activeKey,
    JSON.stringify({ version, previousVersion, activatedAt: new Date().toISOString(), activatedBy: actor }),
    { httpMetadata: { contentType: "application/json" } },
  );
  return previousVersion;
}

/* ------------------------------- routes ---------------------------------- */

/** All jobs, plus the bucket the panel is reading. */
indexingAdmin.get("/jobs", async (c) => {
  const jobs = await listJobs(c.env);
  return c.json({
    jobs,
    containerBound: Boolean(c.env.INDEXER_CONTAINER),
    // The panel shows the isolation rules when this is a staging deployment, so an
    // operator is never unsure whether they are looking at production state.
    staging: isStaging(c.env),
  });
});

/**
 * Preflight: the plan and the measured source sizes, read from R2 (HEAD only).
 * Nothing is written and nothing is scanned.
 */
indexingAdmin.post("/preflight", async (c) => {
  const sources: { id: string; bytes: number | null; etag: string | null }[] = [];
  let total = 0;
  for (const [id, key] of Object.entries(SOURCE_OBJECTS)) {
    const head = await c.env.COMPANY_DATA.head(key);
    if (head) total += head.size;
    sources.push({ id, bytes: head ? head.size : null, etag: head?.etag ?? null });
  }
  const ready = sources.every((source) => source.bytes !== null);
  return c.json({
    ok: ready,
    bucket: BUCKET,
    sources,
    totalBytes: total,
    containerBound: Boolean(c.env.INDEXER_CONTAINER),
    output: ready
      ? [
          `${BUCKET}: both sources present (${(total / 1e9).toFixed(2)} GB).`,
          "Pass 1 reads them in bounded ranged chunks; Pass 2 merges one partition at a time.",
        ].join("\n")
      : "One or more source objects are missing; nothing can run.",
  });
});

/**
 * Start or resume a cloud stage inside the container.
 *
 * `stage=pass1` runs the chunker and segment writer; `stage=pass2` merges the
 * verified segments. A full run requires `control.approvedFullRun`, which only the
 * `approve` route can set — a browser cannot start the 64 GB job by accident.
 */
indexingAdmin.post("/jobs/:version/start", async (c) => {
  const version = sanitiseVersion(c.req.param("version"));
  if (!version) return badRequest(c, "invalid_version", "A version id is required (letters, digits, . _ -).");
  const stagingError = stagingVersionError(c.env, version);
  if (stagingError) return stagingError;
  const body = (await c.req.json().catch(() => ({}))) as { stage?: string; confirm?: string; maxSourceMb?: number; partitions?: number };
  if (body.confirm !== "START") return badRequest(c, "confirmation_required", 'Send confirm: "START".');

  const stage = body.stage === "pass2" ? "pass2" : body.stage === "pass1" ? "pass1" : null;
  if (!stage) return badRequest(c, "invalid_stage", "stage must be pass1 or pass2.");

  // Policy checks come before the capability check: a staging deployment must answer
  // "this deployment never runs the full corpus" whether or not a container is bound.
  if (!body.maxSourceMb && isStaging(c.env)) {
    return c.json(
      {
        error: {
          code: "staging_bounded_only" as const,
          message: "The staging deployment runs bounded benchmarks only; full-corpus indexing is refused.",
        },
      },
      403,
    );
  }

  const container = c.env.INDEXER_CONTAINER;
  if (!container) return unavailable(c);

  const state = await readState(c.env, version);
  const control = (await readControl(c.env, version)) ?? defaultControl();
  const mode = body.maxSourceMb ? "benchmark" : (state?.mode ?? "full");
  if (!body.maxSourceMb && !control.approvedFullRun) {
    return c.json(
      {
        error: {
          code: "approval_required" as const,
          message:
            "A full-corpus run needs an approved forecast (the Approve button records it). Send maxSourceMb for a bounded benchmark instead.",
        },
      },
      403,
    );
  }

  const partitions = Number(body.partitions ?? state?.partitions ?? 256);
  if (!Number.isInteger(partitions) || partitions < 1 || partitions > 256) {
    return badRequest(c, "invalid_partitions", "partitions must be 1..256.");
  }

  if (stage === "pass2") {
    if (!state) return notFound(c, version);
    if (!["pass1-complete", "pass2", "paused"].includes(state.stage) && !(mode === "benchmark" && state.stage === "pass1")) {
      return c.json({ error: { code: "wrong_stage" as const, message: `Pass 2 needs pass1-complete; the job is ${state.stage}.` } }, 409);
    }
  }

  const args =
    stage === "pass1"
      ? [
          "run",
          "--version",
          version,
          "--partitions",
          String(partitions),
          ...(body.maxSourceMb ? ["--max-source-mb", String(body.maxSourceMb)] : ["--approve-full"]),
        ]
      : ["pass2", "--version", version, "--partitions", String(partitions), ...(mode === "benchmark" ? ["--allow-bounded"] : [])];

  return startInContainer(c, args, { version, stage, partitions });
});

/**
 * Start a stage inside the container and return immediately.
 *
 * A full run lasts hours, so the container is asked for `detach: true`: it spawns
 * the CLI and answers 202. The panel follows the job through `state.json` in R2, not
 * through a held-open HTTP response (which a Worker or the client would cut off).
 * The instance name is stable per deployment, so a second start reaches the same
 * container and the CLI resumes from its durable checkpoint.
 */
async function startInContainer(
  c: AdminContext,
  args: string[],
  summary: { version: string; stage: "pass1" | "pass2"; partitions: number },
): Promise<Response> {
  const container = c.env.INDEXER_CONTAINER;
  if (!container) return unavailable(c);
  const stub = container.get(container.idFromName(JOB_INSTANCE));
  try {
    const response = await stub.fetch("http://container/job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args, detach: true }),
    });
    if (!response.ok) {
      return c.json(
        { error: { code: "container_rejected" as const, message: (await response.text()).slice(0, 500) } },
        502,
      );
    }
    return c.json({ started: true, ...summary }, 202);
  } catch (error) {
    return c.json(
      {
        error: {
          code: "container_unreachable" as const,
          message: `The indexing container did not accept the job: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
      502,
    );
  }
}

/** Panel alias: Cloud Pass 2 (`POST /api/cloud/jobs/<v>/pass2`). */
indexingAdmin.post("/jobs/:version/pass2", async (c) => {
  const version = sanitiseVersion(c.req.param("version"));
  if (!version) return badRequest(c, "invalid_version", "Invalid version id.");
  const stagingError = stagingVersionError(c.env, version);
  if (stagingError) return stagingError;
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: string; partitions?: number };
  if (body.confirm !== "PASS2") return badRequest(c, "confirmation_required", 'Send confirm: "PASS2".');
  const state = await readState(c.env, version);
  if (!state) return notFound(c, version);
  const control = (await readControl(c.env, version)) ?? defaultControl();
  if (state.mode === "full" && isStaging(c.env)) {
    return c.json({ error: { code: "staging_bounded_only" as const, message: "The staging deployment never merges a full-corpus job." } }, 403);
  }
  if (state.mode === "full" && !control.approvedFullRun) {
    return c.json({ error: { code: "approval_required" as const, message: "A full-corpus Pass 2 requires approvedFullRun." } }, 403);
  }
  if (!["pass1-complete", "pass2", "paused"].includes(state.stage) && !(state.mode === "benchmark" && state.stage === "pass1")) {
    return c.json({ error: { code: "wrong_stage" as const, message: `Pass 2 needs pass1-complete; the job is ${state.stage}.` } }, 409);
  }
  const partitions = Number(body.partitions ?? state.partitions ?? 256);
  if (!Number.isInteger(partitions) || partitions < 1 || partitions > 256) {
    return badRequest(c, "invalid_partitions", "partitions must be 1..256.");
  }
  const args = ["pass2", "--version", version, "--partitions", String(partitions), ...(state.mode === "benchmark" ? ["--allow-bounded"] : [])];
  return startInContainer(c, args, { version, stage: "pass2", partitions });
});

/** Panel alias: bounded benchmark (`POST /api/cloud/jobs/benchmark`). */
indexingAdmin.post("/jobs/benchmark", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    confirm?: string;
    version?: string;
    maxSourceMb?: number;
    partitions?: number;
  };
  if (body.confirm !== "BENCHMARK") return badRequest(c, "confirmation_required", 'Send confirm: "BENCHMARK".');
  const version = sanitiseVersion(body.version);
  if (!version) return badRequest(c, "invalid_version", "A version id is required (letters, digits, . _ -).");
  const stagingError = stagingVersionError(c.env, version);
  if (stagingError) return stagingError;
  const maxSourceMb = Number(body.maxSourceMb ?? 16);
  const partitions = Number(body.partitions ?? 16);
  if (!Number.isFinite(maxSourceMb) || maxSourceMb <= 0 || maxSourceMb > 256) {
    return badRequest(c, "invalid_size", "maxSourceMb must be between 1 and 256 for a bounded benchmark.");
  }
  if (!Number.isInteger(partitions) || partitions < 1 || partitions > 256) {
    return badRequest(c, "invalid_partitions", "partitions must be 1..256.");
  }
  // The container's `benchmark` command exists so the forecast is measured through
  // the same chunker and segment writer a full run uses.
  const args = [
    "benchmark",
    "--version",
    version,
    "--max-source-mb",
    String(maxSourceMb),
    "--partitions",
    String(partitions),
  ];
  return startInContainer(c, args, { version, stage: "pass1", partitions });
});

/** Pause / resume / abort / approve — the same flags the engine checks. */
indexingAdmin.post("/jobs/:version/control", async (c) => {
  const version = sanitiseVersion(c.req.param("version"));
  if (!version) return badRequest(c, "invalid_version", "Invalid version id.");
  const stagingError = stagingVersionError(c.env, version);
  if (stagingError) return stagingError;
  const body = (await c.req.json().catch(() => ({}))) as { action?: string };
  const action = String(body.action ?? "");
  if (!["pause", "resume", "abort", "approve"].includes(action)) {
    return badRequest(c, "invalid_action", "action must be pause, resume, abort or approve.");
  }
  const existing = (await readControl(c.env, version)) ?? defaultControl();
  const next: CloudControl = { ...existing, updatedAt: new Date().toISOString() };
  if (action === "pause") next.pause = true;
  if (action === "resume") {
    next.pause = false;
    next.abort = false;
  }
  if (action === "abort") next.abort = true;
  if (action === "approve") next.approvedFullRun = true;
  await writeControl(c.env, version, next);
  return c.json({ ok: true, version, action, control: next });
});

/** Independent segment verification (Pass 1 output), summarised for the panel. */
indexingAdmin.post("/jobs/:version/verify", async (c) => {
  const version = sanitiseVersion(c.req.param("version"));
  if (!version) return badRequest(c, "invalid_version", "Invalid version id.");
  const stagingError = stagingVersionError(c.env, version);
  if (stagingError) return stagingError;
  const problems: string[] = [];
  let chunks = 0;
  let rows = 0;
  let segments = 0;
  const manifestKeys = (
    await c.env.COMPANY_DATA.list({ prefix: `${cloudKeys.jobRoot(version)}/chunks/`, limit: 1000 })
  ).objects.filter((object) => object.key.endsWith(".json"));
  for (const object of manifestKeys) {
    const body = await c.env.COMPANY_DATA.get(object.key);
    if (!body) {
      problems.push(`${object.key}: unreadable`);
      continue;
    }
    const manifest = (await body.json()) as {
      chunk: number;
      rows: number;
      segments: { key: string; bytes: number; rows: number }[];
    };
    chunks += 1;
    rows += manifest.rows;
    let segmentRows = 0;
    for (const segment of manifest.segments) {
      const head = await c.env.COMPANY_DATA.head(segment.key);
      if (!head || head.size !== segment.bytes) {
        problems.push(`${segment.key}: ${head ? `size ${head.size} != ${segment.bytes}` : "missing"}`);
        continue;
      }
      segments += 1;
      segmentRows += segment.rows;
    }
    if (segmentRows !== manifest.rows) problems.push(`${object.key}: rows ${manifest.rows} vs segments ${segmentRows}`);
  }
  const ok = problems.length === 0 && chunks > 0;
  return c.json(
    {
      ok,
      output: [
        `chunks ${chunks.toLocaleString()} · rows ${rows.toLocaleString()} · segments ${segments.toLocaleString()}`,
        ok ? "PASS — every segment exists with the recorded size and row count." : `FAIL: ${problems.slice(0, 20).join("; ") || "no chunk manifests"}`,
      ].join("\n"),
    },
    ok ? 200 : 422,
  );
});

/**
 * Activate a completed version.
 *
 * Three gates, all re-checked here rather than trusted from the browser: the job is
 * a full run, its state is `complete`, and R2 actually holds a passed validation
 * report for this version (`verifyRemoteVersion`). The previous version stays in R2
 * as the rollback target.
 */
indexingAdmin.post("/jobs/:version/activate", async (c) => {
  const version = sanitiseVersion(c.req.param("version"));
  if (!version) return badRequest(c, "invalid_version", "Invalid version id.");
  const stagingError = stagingVersionError(c.env, version);
  if (stagingError) return stagingError;
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== version) return badRequest(c, "confirmation_required", `Send confirm: "${version}".`);
  const state = await readState(c.env, version);
  if (!state) return notFound(c, version);
  if (state.mode !== "full") {
    return c.json({ error: { code: "not_activatable" as const, message: "A bounded benchmark can never be activated." } }, 409);
  }
  if (state.stage !== "complete") {
    return c.json({ error: { code: "wrong_stage" as const, message: `Version is ${state.stage}, not complete.` } }, 409);
  }
  try {
    await verifyVersionInR2(c.env.COMPANY_DATA, version);
    // Staging flips `staging/active.json`; production keeps `manifests/active.json`.
    const previousVersion = await activateVersion(c.env.COMPANY_DATA, activeKeyFor(c.env), version, c.get("identity").email);
    return c.json({
      ok: true,
      version,
      previousVersion,
      output: `Activated ${version}.${previousVersion ? ` ${previousVersion} remains the rollback target.` : ""}`,
    });
  } catch (error) {
    return c.json(
      { error: { code: "activation_failed" as const, message: error instanceof Error ? error.message : String(error) } },
      422,
    );
  }
});

/* ------------------------------ small helpers ---------------------------- */

const BUCKET = "company-intel-data";
/** The two source objects the indexer config names; HEAD only, never read here. */
const SOURCE_OBJECTS: Record<string, string> = { csv1: "raw/file1.csv", csv2: "raw/file2.csv" };
/** One container instance per job; the instance name is the job id. */
const JOB_INSTANCE = "indexer";

function sanitiseVersion(value: string | undefined): string | null {
  if (!value) return null;
  return /^[a-z0-9][a-z0-9._-]{2,60}$/i.test(value) ? value : null;
}

function defaultControl(): CloudControl {
  return { version: CLOUD_CONTROL_VERSION, pause: false, abort: false, approvedFullRun: false, updatedAt: new Date().toISOString() };
}

function badRequest(c: AdminContext, code: string, message: string) {
  return c.json({ error: { code, message } }, 400);
}

function notFound(c: AdminContext, version: string) {
  return c.json({ error: { code: "no_such_job" as const, message: `No cloud job ${version}.` } }, 404);
}

function unavailable(c: AdminContext) {
  return c.json(
    {
      error: {
        code: "indexing_container_unavailable" as const,
        message: "No INDEXER_CONTAINER binding is deployed; the control plane can read state but not start a run.",
      },
    },
    503,
  );
}
