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
  type CloudRunStatus,
} from "../../src/shared/cloud/types";
import { verifyAccess, AccessError } from "./access";
import type { AccessIdentity } from "./env";
import type { EnvWithContainer } from "./indexer-container";
import { swarmRoutes } from "./swarm-admin";

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

/**
 * Parallel indexing (16 containers). Mounted here so it inherits this router's
 * Access verification and admin allowlist — a separate Hono app would need a second
 * copy of the authorisation code, and a second copy is a second place to get it wrong.
 */
indexingAdmin.route("/swarm", swarmRoutes);

/**
 * Unmatched `/api/cloud/…` paths are JSON errors too.
 *
 * Hono's default 404 is a plain-text body. A control-plane client parses JSON, so
 * an unknown route must look like a control-plane error — and, like every route
 * above, it must never be answered by the SPA shell.
 */
indexingAdmin.notFound((c) =>
  c.json(
    { error: { code: "not_found" as const, message: `No cloud indexing route for ${c.req.method} ${new URL(c.req.url).pathname}.` } },
    404,
  ),
);

indexingAdmin.onError((error, c) => {
  if (error instanceof AccessError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 401);
  }
  // No internal message, no binding value, no credential: the operator sees a
  // stable code and the detail stays in the platform logs.
  return c.json(
    { error: { code: "internal" as const, message: "The indexing control plane failed to handle this request." } },
    500,
  );
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
/** A job directory listing page is one Class A op; 5 pages is 5,000 version dirs. */
const MAX_JOB_PAGES = 5;
/** Most recent jobs the panel renders (each is 2 small GETs: state + control). */
const MAX_JOBS = 25;
/** A live job writes `state.json` (or a heartbeat) at every chunk; 3 min is well past that. */
const STALE_AFTER_MS = 180_000;
const IN_FLIGHT_STAGES = new Set<CloudJobState["stage"]>(["preflight", "pass1", "pass2", "assembling", "verify"]);

export interface JobWarning {
  kind: "failed" | "interrupted" | "terminated" | "stale";
  since: string;
  reason: string;
}

export interface JobListing {
  state: CloudJobState;
  control: CloudControl | null;
  /** Last attempt (run.json). Null for a job written before heartbeats existed. */
  run: CloudRunStatus | null;
  /** Non-null when this job is not running and the reason is known (or overdue). */
  warning: JobWarning | null;
}

/**
 * List job version directories, never their contents.
 *
 * The previous version listed `cloud/jobs/` with a single 200-key page and kept only
 * `…/state.json`. A real job writes hundreds of chunk manifests and thousands of
 * segments under the same prefix, and those keys sort BEFORE `state.json`, so the one
 * page was full of segments and the job never appeared: staging reported
 * `{"jobs":[]}` while `state.json` existed. Using the `/` delimiter returns only the
 * version directories (one entry per job), so the listing is complete regardless of
 * how many objects a job has, and it never reads a segment.
 */
async function listJobVersions(env: EnvWithContainer): Promise<{ versions: string[]; truncated: boolean }> {
  const versions: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_JOB_PAGES; page += 1) {
    const options: R2ListOptions = { prefix: `${STATE_PREFIX}/`, delimiter: "/", limit: 1000 };
    if (cursor) options.cursor = cursor;
    const listed = await env.COMPANY_DATA.list(options);
    for (const prefix of listed.delimitedPrefixes ?? []) {
      const version = prefix.slice(STATE_PREFIX.length + 1).replace(/\/$/, "");
      if (!version) continue;
      // Staging shows its own jobs only: a production job id has no `stg-` prefix.
      if (isStaging(env) && !version.startsWith("stg-")) continue;
      versions.push(version);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
    if (!cursor) break;
  }
  // Version ids are date-stamped by convention, so the newest directory first; the
  // final order is by `updatedAt` once each state object has been read.
  versions.sort((a, b) => b.localeCompare(a));
  return { versions: versions.slice(0, MAX_JOBS), truncated: Boolean(cursor) || versions.length > MAX_JOBS };
}

/**
 * Why a job is not advancing.
 *
 * A detached job's only proof of life is its heartbeat, so a job whose stage is in
 * flight and whose last heartbeat is old is reported as stopped — never as "still
 * running". An explicit interruption (written by the CLI on failure or by the
 * container runner when a stop killed it) takes precedence.
 */
export function warningFor(state: CloudJobState, run: CloudRunStatus | null, nowMs: number): JobWarning | null {
  if (!IN_FLIGHT_STAGES.has(state.stage)) return null;
  const terminalRun = run && run.outcome !== "running" ? run : null;
  if (terminalRun) {
    return {
      kind: terminalRun.outcome as JobWarning["kind"],
      since: terminalRun.heartbeatAt,
      reason: terminalRun.reason ?? `The run ended (${terminalRun.outcome}) without a recorded reason.`,
    };
  }
  if (state.interruption) {
    return { kind: state.interruption.outcome, since: state.interruption.at, reason: state.interruption.reason };
  }
  const heartbeat = run?.heartbeatAt ?? state.updatedAt;
  const age = nowMs - Date.parse(heartbeat);
  if (!Number.isFinite(age) || age <= STALE_AFTER_MS) return null;
  return {
    kind: "stale",
    since: heartbeat,
    reason:
      `No progress for ${Math.round(age / 60_000)} min. The run stopped without recording a reason ` +
      `(the container was probably stopped). Every committed chunk is in R2; start the same version to resume.`,
  };
}

/** Every job's durable state, newest first. One delimited listing, then small GETs. */
async function listJobs(env: EnvWithContainer): Promise<{ jobs: JobListing[]; truncated: boolean }> {
  const { versions, truncated } = await listJobVersions(env);
  const nowMs = Date.now();
  const jobs = await Promise.all(
    versions.map(async (version): Promise<JobListing | null> => {
      const object = await env.COMPANY_DATA.get(cloudKeys.state(version));
      if (!object) return null;
      const state = (await object.json()) as CloudJobState;
      const [control, run] = await Promise.all([readControl(env, version), readRunStatus(env, version)]);
      return { state, control, run, warning: warningFor(state, run, nowMs) };
    }),
  );
  return {
    jobs: jobs
      .filter((job): job is JobListing => job !== null)
      .sort((a, b) => (b.state.updatedAt ?? "").localeCompare(a.state.updatedAt ?? "")),
    truncated,
  };
}

async function readRunStatus(env: EnvWithContainer, version: string): Promise<CloudRunStatus | null> {
  const object = await env.COMPANY_DATA.get(cloudKeys.runStatus(version));
  return object ? ((await object.json()) as CloudRunStatus) : null;
}

/** The subset of a Pass 1 checkpoint the control plane needs to rebuild a command. */
interface WorkerCheckpoint {
  sourceId: string;
  sourceSize: number;
  sourceEtag: string | null;
  chunkBytes: number;
  nextOffset: number;
  nextLine: number;
  chunks: number;
  rows: number;
  rejected: number;
  segments: number;
  segmentBytes: number;
  complete: boolean;
}

const MIB = 1024 * 1024;
/** A `running` heartbeat younger than this means a process is still working. */
const RUN_LIVE_MS = 2 * 60_000;

async function readCheckpoint(env: EnvWithContainer, version: string, sourceId: string): Promise<WorkerCheckpoint | null> {
  const object = await env.COMPANY_DATA.get(cloudKeys.checkpoint(version, sourceId));
  return object ? ((await object.json()) as WorkerCheckpoint) : null;
}

/** The checkpoints for the sources the state names, in state order. */
async function readCheckpoints(env: EnvWithContainer, state: CloudJobState): Promise<WorkerCheckpoint[]> {
  const checkpoints = await Promise.all(state.sources.map((source) => readCheckpoint(env, state.version, source.id)));
  return checkpoints.filter((entry): entry is WorkerCheckpoint => entry !== null);
}

/**
 * The bounded limit of a job started before `config` existed, or null when R2 does
 * not prove it.
 *
 * A signal, a pause or a crash is honoured only at a **chunk boundary**, so such a
 * run always leaves `nextOffset === chunks * chunkBytes`. A run that stopped at its
 * bounded limit leaves a PARTIAL chunk instead: the chunker stops at the first record
 * boundary at or after `maxSourceMb * MiB`, so its offset is that limit plus at most
 * one row. Therefore a partial last chunk is proof the run ended on its bound, and
 * rounding the offset DOWN to the nearest MiB recovers the bound (16 MiB here) — it
 * can only ever be smaller than the original, never larger.
 *
 * Both sources must agree, and a chunk-boundary stop returns null: the limit of a
 * job that was interrupted below it is unknown, and guessing would either truncate
 * the benchmark or widen it. `resumeExecution` refuses such a job and names the
 * existing action that resumes it at an explicit limit.
 */
export function inferredMaxSourceMb(checkpoints: WorkerCheckpoint[]): number | null {
  if (!checkpoints.length) return null;
  const candidates = new Set<number>();
  for (const entry of checkpoints) {
    if (!Number.isFinite(entry.nextOffset) || entry.nextOffset <= 0) return null;
    if (Number.isFinite(entry.chunkBytes) && entry.chunkBytes > 0 && entry.nextOffset === entry.chunks * entry.chunkBytes) {
      // Not a bound stop: an operator stop or a crash left a whole chunk boundary.
      return null;
    }
    candidates.add(Math.floor(entry.nextOffset / MIB));
  }
  if (candidates.size !== 1) return null;
  const [bound] = [...candidates];
  return bound !== undefined && bound >= 1 ? bound : null;
}

/** True when every source's checkpoint is at its bounded limit. */
function boundedLimitReached(checkpoints: WorkerCheckpoint[], maxSourceMb: number): boolean {
  return checkpoints.length > 0 && checkpoints.every((entry) => entry.nextOffset >= Math.min(entry.sourceSize, maxSourceMb * MIB));
}

/**
 * Publish the checkpoints' progress into the state (forward only).
 *
 * The same rule as `syncStateFromCheckpoints` in `tools/cloud/pass1.ts`: a job whose
 * process died between its checkpoint PUT and its state PUT must not display — or
 * resume from — less progress than R2 durably holds.
 */
function mergeCheckpoints(state: CloudJobState, checkpoints: WorkerCheckpoint[]): boolean {
  let changed = false;
  for (const [index, source] of state.sources.entries()) {
    const checkpoint = checkpoints.find((entry) => entry.sourceId === source.id);
    if (!checkpoint) continue;
    if (checkpoint.chunks <= source.chunks && checkpoint.nextOffset <= source.sourceBytes) {
      if (source.size === checkpoint.sourceSize && source.etag === checkpoint.sourceEtag) continue;
      state.sources[index] = { ...source, size: checkpoint.sourceSize, etag: checkpoint.sourceEtag };
      changed = true;
      continue;
    }
    state.sources[index] = {
      ...source,
      size: checkpoint.sourceSize,
      etag: checkpoint.sourceEtag,
      nextOffset: checkpoint.nextOffset,
      nextLine: checkpoint.nextLine,
      chunks: checkpoint.chunks,
      rows: checkpoint.rows,
      rejected: checkpoint.rejected,
      sourceBytes: checkpoint.nextOffset,
      segments: checkpoint.segments,
      segmentBytes: checkpoint.segmentBytes,
      complete: checkpoint.complete,
    };
    changed = true;
  }
  if (!changed) return false;
  const sum = (pick: (source: CloudJobState["sources"][number]) => number) => state.sources.reduce((total, source) => total + pick(source), 0);
  state.totals = {
    rowsRead: sum((source) => source.rows + source.rejected),
    rowsRejected: sum((source) => source.rejected),
    rowsIndexed: sum((source) => source.rows),
    segments: sum((source) => source.segments),
    segmentBytes: sum((source) => source.segmentBytes),
    sourceBytesRead: sum((source) => source.sourceBytes),
  };
  return true;
}

/** A live attempt for this version, or null. Detached work is not tied to a request. */
async function liveRun(env: EnvWithContainer, version: string): Promise<CloudRunStatus | null> {
  const run = await readRunStatus(env, version);
  if (!run || run.outcome !== "running") return null;
  const age = Date.now() - Date.parse(run.heartbeatAt);
  return Number.isFinite(age) && age <= RUN_LIVE_MS ? run : null;
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
  const { jobs, truncated } = await listJobs(c.env);
  return c.json({
    jobs,
    // True when the deployment holds more job directories than one panel page shows;
    // the panel says so instead of silently looking complete.
    truncated,
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

  // One runner per version: a detached attempt is not tied to this request, so the
  // only reliable duplicate check is the heartbeat it writes.
  const active = await liveRun(c.env, version);
  if (active) return alreadyRunning(c, version, active);

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
  summary: { version: string; stage: "pass1" | "pass2"; partitions: number; maxSourceMb?: number; message?: string },
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
    // The DO answers JSON for every failure: `container_not_ready` while a cold
    // start is still in progress, `cli_missing` when the image is broken, or
    // `job_failed_to_start` with the child's stderr when the command died
    // immediately. None of those may read as a successful start.
    const payload = (await response.json().catch(() => null)) as
      | { started?: boolean; completed?: boolean; exitCode?: number | null; output?: string; error?: { code?: string; message?: string; detail?: string } }
      | null;
    if (!response.ok) {
      const code = payload?.error?.code ?? "container_rejected";
      const message = payload?.error?.message ?? `The indexing container rejected the job (HTTP ${response.status}).`;
      // 409 is the runner refusing because another job is already running. Passing
      // that through (rather than a generic 502) makes a duplicate start visible as
      // a duplicate instead of looking like a broken container.
      const status = response.status === 503 ? 503 : response.status === 409 ? 409 : 502;
      return c.json(
        { error: { code, message, ...(payload?.error?.detail ? { detail: payload.error.detail } : {}) } },
        status,
      );
    }
    if (payload?.started === false) {
      // The command finished inside the runner's settle window (exit 0). Reporting
      // 202 here would be the same lie as before, only in the other direction.
      return c.json(
        {
          started: false,
          completed: Boolean(payload.completed),
          exitCode: payload.exitCode ?? 0,
          output: payload.output ?? "The command completed before it could be detached.",
          ...summary,
        },
        200,
      );
    }
    return c.json({ ok: true, started: true, ...summary }, 202);
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
  const active = await liveRun(c.env, version);
  if (active) return alreadyRunning(c, version, active);
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
  const active = await liveRun(c.env, version);
  if (active) return alreadyRunning(c, version, active);
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
  const body = (await c.req.json().catch(() => ({}))) as { action?: string; maxSourceMb?: number };
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

  // Resume is an ACTION, not just a flag: clearing `pause` only helps a process that
  // is still alive, and a detached job has no process once its container stopped.
  // The panel's Resume button therefore restarts the job from its durable state.
  if (action === "resume") {
    const state = await readState(c.env, version);
    if (!state) return notFound(c, version);
    // An explicit limit is only accepted for a bounded job, and it is recorded in
    // state.json so this job is never ambiguous again. It cannot turn a benchmark
    // into a full-corpus run; staging still refuses a full job outright.
    const explicit = body.maxSourceMb === undefined ? undefined : Number(body.maxSourceMb);
    if (explicit !== undefined) {
      if (state.mode !== "benchmark") {
        return badRequest(c, "not_a_benchmark", "A bounded limit can only be recorded for a benchmark job.");
      }
      if (!Number.isInteger(explicit) || explicit < 1 || explicit > 256) {
        return badRequest(c, "invalid_size", "maxSourceMb must be an integer between 1 and 256.");
      }
    }
    return resumeExecution(c, state, next, explicit);
  }
  return c.json({ ok: true, version, action, control: next });
});

/**
 * Restart a job from its durable state after a pause or an interruption.
 *
 * The command is rebuilt, never inferred from a browser request: `config` records
 * the original stage, partitions, bounded limit and chunk size, and a job started
 * before `config` existed recovers the same values from its checkpoints. A bounded
 * benchmark can therefore be resumed — and completed — but never widened into a
 * full-corpus run.
 *
 * Order of work:
 *   1. a live attempt is left alone (no duplicate start);
 *   2. a benchmark whose checkpoints are already at their limit is reconciled and
 *      marked bounded Pass 1 complete instead of being restarted;
 *   3. Pass 1 is (re)started only while it is unfinished; otherwise Pass 2 starts,
 *      so one Resume click advances a finished Pass 1 benchmark into its merge.
 */
async function resumeExecution(
  c: AdminContext,
  state: CloudJobState,
  control: CloudControl,
  explicitMaxSourceMb?: number,
): Promise<Response> {
  const version = state.version;
  const container = c.env.INDEXER_CONTAINER;
  if (!container) return unavailable(c);

  const running = await liveRun(c.env, version);
  if (running) {
    return c.json(
      {
        ok: true,
        started: false,
        alreadyRunning: true,
        stage: state.stage,
        attempt: running.attempt,
        message: `A run is already active for ${version} (attempt ${running.attempt}, pid ${running.pid ?? "?"}). Nothing was started twice.`,
      },
      200,
    );
  }
  if (state.stage === "complete") {
    return c.json({ ok: true, started: false, stage: "complete", message: "This version is already complete; nothing to resume." }, 200);
  }

  const checkpoints = await readCheckpoints(c.env, state);
  const bounded = state.mode === "benchmark";
  const partitions = state.config?.partitions ?? state.partitions ?? 256;
  const chunkMb = state.config?.chunkMb ?? (checkpoints[0] ? checkpoints[0].chunkBytes / MIB : undefined);
  const recordedMb = state.config?.maxSourceMb;
  // Recorded config first, then proof from R2, then an explicit operator limit. Never
  // a guess: a bound that cannot be recovered is reported, not invented.
  const maxSourceMb: number | undefined =
    (typeof recordedMb === "number" ? recordedMb : undefined) ??
    explicitMaxSourceMb ??
    (bounded ? inferredMaxSourceMb(checkpoints) ?? undefined : undefined);
  if (!Number.isInteger(partitions) || partitions < 1 || partitions > 256) {
    return badRequest(c, "invalid_partitions", `The recorded partition count (${partitions}) is not valid for a resume.`);
  }
  if (bounded && maxSourceMb !== undefined && explicitMaxSourceMb !== undefined && state.config?.maxSourceMb !== explicitMaxSourceMb) {
    // Remember it, so the next resume does not need the operator to repeat it.
    state.config = {
      stage: "pass1",
      mode: state.mode,
      partitions,
      maxSourceMb: explicitMaxSourceMb,
      ...(chunkMb ? { chunkMb } : {}),
      requestedAt: new Date().toISOString(),
    };
    await c.env.COMPANY_DATA.put(cloudKeys.state(version), JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
  }

  // A benchmark that reached its limit has no chunk left to read. Publish the
  // checkpoints' progress, mark Pass 1 complete and fall through to Pass 2 instead
  // of restarting a command that would immediately stop again.
  let reconciled = false;
  if (bounded && maxSourceMb !== undefined && boundedLimitReached(checkpoints, maxSourceMb)) {
    reconciled = mergeCheckpoints(state, checkpoints) || reconciled;
    if (state.stage !== "pass1-complete") {
      state.stage = "pass1-complete";
      reconciled = true;
    }
    state.coverage = "bounded";
    if (!state.config) {
      state.config = {
        stage: "pass1",
        mode: state.mode,
        partitions,
        maxSourceMb,
        ...(chunkMb ? { chunkMb } : {}),
        requestedAt: new Date().toISOString(),
      };
      reconciled = true;
    }
    state.note = `Bounded benchmark complete: ${maxSourceMb} MB per source, reconciled from R2 checkpoints. Pass 2 merges that prefix; activation stays disabled for a benchmark.`;
    state.updatedAt = new Date().toISOString();
  }
  if (reconciled) await c.env.COMPANY_DATA.put(cloudKeys.state(version), JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });

  const pass2Started = state.stage === "pass2" || (state.pass2?.partitionsDone ?? 0) > 0;
  const pass1Done = state.stage === "pass1-complete" || pass2Started;

  if (!pass1Done) {
    if (bounded) {
      if (maxSourceMb === undefined) {
        return c.json(
          {
            error: {
              code: "benchmark_limit_unknown" as const,
              message:
                "This benchmark predates durable configuration and R2 does not prove its per-source limit (its last chunk is a whole chunk boundary, so it stopped below the limit). " +
                "Send { action: \"resume\", maxSourceMb: <the original limit> } to record it, or start a bounded benchmark for this version with that limit — both resume from the verified checkpoints. It is never resumed as a full run.",
              detail: `partitions ${partitions}${chunkMb ? `, chunk ${chunkMb} MiB` : ""}; progress is intact in R2.`,
            },
          },
          400,
        );
      }
      const args = [
        "benchmark",
        "--version",
        version,
        "--max-source-mb",
        String(maxSourceMb),
        "--partitions",
        String(partitions),
        ...(chunkMb ? ["--chunk-mb", String(chunkMb)] : []),
      ];
      return startOrReport(c, args, { version, stage: "pass1", partitions, maxSourceMb }, {
        message: `Resumed bounded Pass 1 at ${maxSourceMb} MB/source, ${partitions} partitions, from the recorded checkpoints.`,
      });
    }
    if (isStaging(c.env)) {
      return c.json({ error: { code: "staging_bounded_only" as const, message: "The staging deployment runs bounded benchmarks only; full-corpus indexing is refused." } }, 403);
    }
    if (!control.approvedFullRun) {
      return c.json({ error: { code: "approval_required" as const, message: "This is a full-corpus job; record approval before resuming it." } }, 403);
    }
    const args = ["run", "--version", version, "--partitions", String(partitions), "--approve-full", ...(chunkMb ? ["--chunk-mb", String(chunkMb)] : [])];
    return startOrReport(c, args, { version, stage: "pass1", partitions }, {
      message: `Resumed full Pass 1 for ${version} from the recorded checkpoints.`,
    });
  }

  if (state.mode === "full" && isStaging(c.env)) {
    return c.json({ error: { code: "staging_bounded_only" as const, message: "The staging deployment never merges a full-corpus job." } }, 403);
  }
  if (state.mode === "full" && !control.approvedFullRun) {
    return c.json({ error: { code: "approval_required" as const, message: "A full-corpus Pass 2 requires approvedFullRun." } }, 403);
  }
  const pass2Args = ["pass2", "--version", version, "--partitions", String(partitions), ...(bounded ? ["--allow-bounded"] : [])];
  // A job whose merge already completed resumes at finalization; the driver verifies
  // the posting shards in R2 and never repeats the merge. Saying "Pass 2 started" for
  // that case reads as if the whole merge were about to run again.
  const resumePhase = state.pass2?.phase === "finalize" || state.pass2?.phase === "validate" ? state.pass2.phase : null;
  return startOrReport(c, pass2Args, { version, stage: "pass2", partitions, maxSourceMb }, {
    message: resumePhase
      ? `The merge is already complete; resumed ${resumePhase === "validate" ? "validation" : "finalization"} for ${version} from its durable checkpoint.`
      : `Pass 1 is complete; started Cloud Pass 2 for ${version} (${partitions} partitions).`,
  });
}

/** Start, turning the runner's "already running" into a benign answer. */
async function startOrReport(
  c: AdminContext,
  args: string[],
  summary: { version: string; stage: "pass1" | "pass2"; partitions: number; maxSourceMb?: number },
  extra: { message?: string } = {},
): Promise<Response> {
  const response = await startInContainer(c, args, { ...summary, message: extra.message });
  if (response.status !== 409) return response;
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return c.json(
    {
      ok: true,
      started: false,
      alreadyRunning: true,
      stage: summary.stage,
      partitions: summary.partitions,
      ...(summary.maxSourceMb ? { maxSourceMb: summary.maxSourceMb } : {}),
      message: body?.error?.message ?? "A job is already running in the container; nothing was started twice.",
    },
    200,
  );
}

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

function alreadyRunning(c: AdminContext, version: string, run: CloudRunStatus): Response {
  return c.json(
    {
      error: {
        code: "job_already_running" as const,
        message: `A run is already active for ${version} (attempt ${run.attempt}, pid ${run.pid ?? "?"}); start it again only after it stops.`,
      },
    },
    409,
  );
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
