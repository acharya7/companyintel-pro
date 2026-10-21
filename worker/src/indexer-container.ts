/**
 * Durable Object that owns one indexing container instance.
 *
 * Cloudflare Containers expose a container to a Worker through a Durable Object:
 * the DO instance is the container's identity, starts it on demand and proxies
 * HTTP to it. This class is that DO. It deliberately contains almost no logic:
 *
 *   - the container runs `cloud/runner.mjs`, which exposes `/health` and `POST /job`;
 *   - this DO forwards those two routes and refuses everything else;
 *   - credentials are NEVER accepted from a request. The container's environment
 *     comes from the platform's secret store, so a caller cannot supply a token.
 *
 * Cold starts
 *   `container.start()` returns immediately; the port is not listening until the
 *   image has pulled, booted and the runner has bound :8080. Proxying a request in
 *   that window produced a bare 502. The DO now waits for the runner's own
 *   `/health` to answer 200 (bounded by `CONTAINER_READY_TIMEOUT_MS`, default 60 s)
 *   and, if it never does, answers 503 with a stable code and the reason instead
 *   of a transport-level 502.
 *
 * The worker-side orchestration (admin routes, Access checks, approval gates) lives
 * in `indexer-admin.ts`; keeping it out of the DO means the container instance can
 * restart without losing any control state, which lives in R2.
 */

import { cloudKeys, type CloudControl, type CloudJobState, type CloudRunStatus } from "../../src/shared/cloud/types";
import type { Env } from "./env";

/** The port `cloud/runner.mjs` listens on (see Dockerfile / cloud/Dockerfile). */
export const CONTAINER_PORT = 8080;

/** How long a cold start may take before the request is answered with 503. */
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;

/**
 * Keeping a detached job alive.
 *
 * A Cloudflare Container is stopped once the Durable Object that owns it has been
 * inactive for the inactivity timeout; without one, the platform may stop the
 * instance shortly after the DO's last request. That is exactly what happened to
 * staging: the Worker answered 202, the DO went idle, and the CLI was killed after
 * its first checkpoint — no error, no heartbeat, `stage: pass1` forever.
 *
 * `setInactivityTimeout` is the documented keep-alive (max 6h per call). An alarm
 * renews it while `/health` reports a running job, so the DO is active, and the
 * timeout is extended, for as long as the job actually runs. When the job ends the
 * renewal stops and the container sleeps normally.
 */
const DEFAULT_JOB_INACTIVITY_MS = 60 * 60 * 1000;
const DEFAULT_KEEPALIVE_MS = 10 * 60 * 1000;
/**
 * When a heartbeat is old enough to mean "the process is gone".
 *
 * This must exceed one chunk's duration: a full-run chunk is 128 MiB and the
 * measured staging rate is under 1 MB/s, so 15 minutes is one slow chunk, not a
 * stall. The panel's 3-minute warning is an observation; this is the recovery.
 */
const DEFAULT_STALL_MS = 15 * 60 * 1000;
/** Resumes attempted before the job is left for the operator, with its reason. */
const DEFAULT_MAX_RESUMES = 5;
/** Backoff before attempt N (index 0 is unused); the keep-alive interval floors it. */
const RESUME_BACKOFF_MS = [0, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

/** The job this DO is responsible for keeping alive, persisted across restarts. */
interface RememberedJob {
  version: string;
  stage: "pass1" | "pass2";
  args: string[];
  attempts: number;
  lastStartAt: string;
}

export interface EnvWithContainer extends Env {
  /**
   * Durable Object namespace bound to `IndexerContainer`. Optional on purpose: a
   * deployment without the Containers binding still serves the application, and the
   * admin routes answer `503 indexing_container_unavailable` instead of pretending.
   */
  INDEXER_CONTAINER?: DurableObjectNamespace;
  /**
   * Overrides the cold-start wait (milliseconds). Not a secret: it exists so the
   * readiness path can be tested without waiting a minute.
   */
  CONTAINER_READY_TIMEOUT_MS?: string;
  /**
   * Inactivity timeout renewed while a job runs (milliseconds, default 1h, max 6h).
   * Also not a secret; it exists so the keep-alive can be tested quickly.
   */
  CONTAINER_JOB_INACTIVITY_MS?: string;
  /** How often the keep-alive alarm re-checks `/health` (milliseconds, default 10m). */
  CONTAINER_KEEPALIVE_MS?: string;
  /** Heartbeat age that counts as a stalled run (milliseconds, default 15m). */
  CONTAINER_STALL_MS?: string;
  /** Automatic resumes before leaving the job stopped (default 5). */
  CONTAINER_MAX_RESUMES?: string;
  /** Set to "false" to keep the container alive without ever resuming a stopped job. */
  CONTAINER_AUTO_RESUME?: string;
}

/** What the alarm decided to do after reading the durable job state. */
type JobDecision =
  | { kind: "done"; why: string }
  | { kind: "operator-stop" }
  | { kind: "budget" }
  | { kind: "running" }
  | { kind: "stopped"; why: string };

export interface ContainerErrorBody {
  error: { code: string; message: string; detail?: string };
  container?: { running: boolean; ready: boolean; waitedMs: number };
}

export class IndexerContainer implements DurableObject {
  /**
   * `start()` is idempotent in the Containers runtime: calling it on a running
   * instance is a no-op, so it is safe on every request.
   */
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: EnvWithContainer,
  ) {
    // A redeploy restarts the DO, not necessarily the container. Restoring the
    // inactivity timeout here keeps an already-running job from being stopped just
    // because this instance forgot the setting, and re-arming the alarm from the
    // persisted job record keeps automatic recovery alive across a rollout.
    const container = this.container();
    void this.state.blockConcurrencyWhile(async () => {
      try {
        const pending = await this.state.storage.get<RememberedJob>(JOB_KEY);
        if (pending) await this.state.storage.setAlarm(Date.now() + this.keepAliveMs());
        if (container?.running) await this.renew(container);
      } catch {
        // Neither is fatal: the job keeps running until the platform's own limit, and
        // `/health` still reports it.
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return this.forward(request);
    if (url.pathname === "/job" && request.method === "POST") return this.forward(request);
    return failure(404, "not_found", `No container route for ${request.method} ${url.pathname}.`);
  }

  /**
   * Keep-alive alarm.
   *
   * Each firing is Durable Object activity, which both renews the container's
   * inactivity window and lets the alarm re-arm itself. A job that has ended (or a
   * container that is gone) is not renewed, so a finished benchmark stops costing
   * container time.
   */
  async alarm(): Promise<void> {
    const container = this.container();
    const job = await this.state.storage.get<RememberedJob>(JOB_KEY);
    if (!container || !job) return;

    const decision = await this.inspect(job);
    if (decision.kind === "done" || decision.kind === "operator-stop" || decision.kind === "budget") {
      // No live work to protect: a finished stage, an operator pause/abort, or the
      // job budget. Forget the record so this DO stops waking for it. The durable
      // state keeps the reason for the panel either way.
      await this.state.storage.delete(JOB_KEY);
      return;
    }

    if (decision.kind === "running") {
      try {
        await this.renew(container);
      } catch {
        return;
      }
      await this.state.storage.setAlarm(Date.now() + this.keepAliveMs());
      return;
    }

    // The run stopped without finishing. Resume from its durable checkpoint, with a
    // bounded number of attempts and a backoff, so a transient platform stop does
    // not need a browser tab or a human pressing Resume.
    if (!this.autoResumeEnabled()) return;
    if (job.attempts >= this.maxResumes()) {
      await this.state.storage.delete(JOB_KEY);
      return;
    }
    const backoff = RESUME_BACKOFF_MS[Math.min(job.attempts + 1, RESUME_BACKOFF_MS.length - 1)] ?? 0;
    const wait = Math.max(backoff, this.keepAliveMs());
    // Set the next alarm before the attempt, so a DO restart mid-resume still wakes
    // up; the attempt overrides it with a shorter interval when it succeeds.
    await this.state.storage.setAlarm(Date.now() + wait);
    const started = await this.resume(container, job);
    if (started) await this.state.storage.setAlarm(Date.now() + this.keepAliveMs());
  }

  /**
   * Resume in place after an alarm decided the run stopped.
   *
   * The attempt is recorded in DO storage *before* the start, so a DO restart in the
   * middle cannot reset the attempt counter and loop forever. A 409 means the CLI is
   * already running — the alarm simply re-arms; the next one will read its heartbeat.
   */
  private async resume(container: Container, job: RememberedJob): Promise<boolean> {
    job.attempts += 1;
    job.lastStartAt = new Date().toISOString();
    await this.state.storage.put(JOB_KEY, job);
    try {
      await this.startOnce(container);
      const readiness = await this.waitForReady(container);
      if (readiness !== null) return false;
      const response = await container.getTcpPort(CONTAINER_PORT).fetch(
        new Request("http://container/job", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ args: job.args, detach: true }),
        }),
      );
      // 409 means the CLI is already working; either way the run is live again.
      if (response.status === 202 || response.status === 409) {
        await this.renew(container);
        return true;
      }
      return false;
    } catch {
      // The next alarm retries with a longer backoff (bounded by max resumes).
      return false;
    }
  }

  /**
   * Read the durable truth for this job and decide whether it is alive.
   *
   * R2, not the container, is authoritative: the whole point is to recover when the
   * container is gone. `run.json` is the heartbeat, `control.json` is the operator's
   * intent, and `state.json` says which stage is in flight.
   */
  private async inspect(job: RememberedJob): Promise<JobDecision> {
    const bucket = this.env.COMPANY_DATA;
    if (!bucket) return { kind: "done", why: "no R2 binding" };
    const [state, control, run] = await Promise.all([
      readJson<CloudJobState>(bucket, cloudKeys.state(job.version)),
      readJson<CloudControl>(bucket, cloudKeys.control(job.version)),
      readJson<CloudRunStatus>(bucket, cloudKeys.runStatus(job.version)),
    ]);
    if (!state) return { kind: "done", why: "no job state" };
    // An operator's pause/abort is never overridden by an automatic resume.
    if (control?.pause || control?.abort) return { kind: "operator-stop" };
    if (state.stage === "aborted") return { kind: "operator-stop" };
    if (job.stage === "pass1" && (state.stage === "pass1-complete" || state.stage === "complete")) {
      return { kind: "done", why: "pass 1 finished" };
    }
    if (job.stage === "pass2" && state.stage === "complete") return { kind: "done", why: "pass 2 finished" };
    const budget = Number(this.env.CLOUD_JOB_BUDGET_USD ?? 0);
    if (state.mode === "full" && Number.isFinite(budget) && budget > 0) {
      const spent = (state.accounting?.estimatedUsd ?? 0) + (state.accounting?.containerUsd ?? 0);
      if (spent >= budget) return { kind: "budget" };
    }
    // A completed attempt did what it was asked (a bounded benchmark stops at its
    // limit); resuming it would just repeat the same bounded no-op.
    if (run?.outcome === "completed") return { kind: "done", why: "last run completed" };
    const heartbeat = run?.heartbeatAt ?? state.updatedAt;
    const age = Date.now() - Date.parse(heartbeat);
    if (run?.outcome === "running" && Number.isFinite(age) && age < this.stallMs()) return { kind: "running" };
    if (run?.outcome === "running") return { kind: "stopped", why: "heartbeat went stale" };
    if (IN_FLIGHT_STAGES.has(state.stage)) return { kind: "stopped", why: `run ended (${run?.outcome ?? "no run.json"})` };
    // `failed` is recoverable (transient R2/network errors, a stopped container); the
    // retry budget and backoff bound how often it is tried. `paused` with an
    // interruption is a stop, not an operator pause (that is `control.pause`).
    if (state.stage === "failed") return { kind: "stopped", why: state.interruption?.reason ?? "the previous attempt failed" };
    // `paused` here is never an operator pause: that is `control.pause`, checked above.
    // It means the attempt was interrupted (a stop, the budget, or an operator pause
    // whose control flag was later cleared). The reason comes from the interruption
    // record, the run, or the note.
    if (state.stage === "paused") {
      return { kind: "stopped", why: state.interruption?.reason ?? run?.reason ?? state.note ?? "the run was interrupted" };
    }
    return { kind: "done", why: `stage ${state.stage} needs an operator` };
  }

  private stallMs(): number {
    const configured = Number(this.env.CONTAINER_STALL_MS ?? DEFAULT_STALL_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALL_MS;
  }

  private maxResumes(): number {
    const configured = Number(this.env.CONTAINER_MAX_RESUMES ?? DEFAULT_MAX_RESUMES);
    return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_MAX_RESUMES;
  }

  private autoResumeEnabled(): boolean {
    return (this.env.CONTAINER_AUTO_RESUME ?? "true").toLowerCase() !== "false";
  }

  /** Extend the inactivity timeout, then arm the next check if one is not pending. */
  private async keepAlive(container: Container): Promise<void> {
    try {
      await this.renew(container);
      await this.state.storage.setAlarm(Date.now() + this.keepAliveMs());
    } catch {
      // Keep-alive is a best effort: if the platform rejects it, the start itself
      // must still be reported honestly (and the job resumes from its checkpoint).
    }
  }

  private keepAliveMs(): number {
    const configured = Number(this.env.CONTAINER_KEEPALIVE_MS ?? DEFAULT_KEEPALIVE_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_KEEPALIVE_MS;
  }

  private async renew(container: Container): Promise<void> {
    if (typeof container.setInactivityTimeout !== "function") return;
    const configured = Number(this.env.CONTAINER_JOB_INACTIVITY_MS ?? DEFAULT_JOB_INACTIVITY_MS);
    const timeout = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 6 * 60 * 60 * 1000) : DEFAULT_JOB_INACTIVITY_MS;
    await container.setInactivityTimeout(timeout);
  }

  /**
   * Start the container if needed, wait until it is ready, then proxy the request.
   *
   * The indexing CLI writes its own progress to R2, so a streaming response is not
   * required for correctness; the caller (admin route) waits for the run to finish
   * or returns as soon as the container accepted the job, depending on the route.
   */
  private async forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Read the job specification before proxying: the body is consumed by the
    // forward, and the alarm needs the exact arguments to resume it later.
    const requested = url.pathname === "/job" && request.method === "POST" ? await readJobSpec(request) : null;
    const container = this.container();
    if (!container) {
      return failure(
        503,
        "indexing_container_unavailable",
        "The INDEXER_CONTAINER binding is not configured for this deployment.",
      );
    }

    const startedAt = Date.now();
    try {
      await this.startOnce(container);
    } catch (error) {
      return failure(
        503,
        "container_start_failed",
        "The indexing container could not be started.",
        error instanceof Error ? error.message : String(error),
        { running: container.running, ready: false, waitedMs: Date.now() - startedAt },
      );
    }

    const readiness = await this.waitForReady(container);
    if (readiness !== null) {
      return failure(503, "container_not_ready", readiness.message, readiness.detail, {
        running: container.running,
        ready: false,
        waitedMs: Date.now() - startedAt,
      });
    }

    try {
      // `getTcpPort` is the typed way to reach the port the container listens on.
      const response = await container.getTcpPort(CONTAINER_PORT).fetch(request);
      // A `/job` request that was accepted detached a long-running child. The DO
      // may now go idle, so the container needs an inactivity window and a reason to
      // wake up again — otherwise the platform stops it mid-run.
      if (url.pathname === "/job" && (response.status === 202 || response.status === 200)) {
        // Only an accepted job is remembered; an early exit (200 {started:false}) or a
        // rejection must not make the alarm believe there is work to recover. This is
        // bookkeeping, not part of the answer: a storage error must never turn an
        // accepted start into a failure.
        try {
          const accepted = response.status === 202 ? true : await startedDetached(response);
          if (accepted && requested) await this.rememberJob(requested);
          else await this.state.storage.delete(JOB_KEY);
        } catch {
          // The job is running; only its automatic recovery record is missing.
        }
        await this.keepAlive(container);
      }
      return response;
    } catch (error) {
      return failure(
        503,
        "container_request_failed",
        "The indexing container accepted the connection but the request failed.",
        error instanceof Error ? error.message : String(error),
        { running: container.running, ready: true, waitedMs: Date.now() - startedAt },
      );
    }
  }

  /** Persist what this DO is responsible for, across restarts. */
  private async rememberJob(spec: { args: string[]; version: string; stage: "pass1" | "pass2" }): Promise<void> {
    await this.state.storage.put(JOB_KEY, {
      version: spec.version,
      stage: spec.stage,
      args: spec.args,
      // A new operator start resets the automatic-resume budget; only automatic
      // attempts by this DO consume it.
      attempts: 0,
      lastStartAt: new Date().toISOString(),
    } satisfies RememberedJob);
  }

  /**
   * Start the instance exactly when it is not already running.
   *
   * Credentials are passed from the Worker's secret store into the container
   * environment at start time. They are never returned to a caller, never logged,
   * and never stored in this repository. The container uses them only for the S3
   * API to the private bucket.
   */
  private async startOnce(container: Container): Promise<void> {
    if (container.running) return;
    await this.state.blockConcurrencyWhile(async () => {
      if (container.running) return;
      const env: Record<string, string> = {};
      if (this.env.R2_ACCOUNT_ID) env.R2_ACCOUNT_ID = this.env.R2_ACCOUNT_ID;
      if (this.env.R2_ACCESS_KEY_ID) env.R2_ACCESS_KEY_ID = this.env.R2_ACCESS_KEY_ID;
      if (this.env.R2_SECRET_ACCESS_KEY) env.R2_SECRET_ACCESS_KEY = this.env.R2_SECRET_ACCESS_KEY;
      // One budget for Pass 1 and Pass 2 together (see docs/cloud.md).
      if (this.env.CLOUD_JOB_BUDGET_USD) env.CLOUD_JOB_BUDGET_USD = this.env.CLOUD_JOB_BUDGET_USD;
      container.start({ enableInternet: true, env: Object.keys(env).length ? env : undefined });
    });
  }
  /**
   * Poll the container's `/health` until it answers 200.
   *
   * Returns `null` when ready, or a message describing the last failure. A 503
   * from the runner is NOT retried: the runner is up but reports that it cannot
   * run jobs (for example its CLI is missing), which no amount of waiting fixes.
   */
  private async waitForReady(
    container: Container,
  ): Promise<{ message: string; detail?: string } | null> {
    const configured = Number(this.env.CONTAINER_READY_TIMEOUT_MS ?? DEFAULT_READY_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let detail = "no response yet";

    while (Date.now() < deadline) {
      try {
        const response = await container.getTcpPort(CONTAINER_PORT).fetch("http://container/health");
        if (response.ok) return null;
        const body = await response.text().catch(() => "");
        if (response.status === 503) {
          return {
            message: "The indexing container is running but is not usable, so no job was started.",
            detail: body.slice(0, 800),
          };
        }
        detail = `health responded ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`;
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }

    return {
      message: `The indexing container did not become ready within ${Math.round(timeoutMs / 1000)}s, so no job was started. A cold start can take longer than one request; retry once it reports running.`,
      detail,
    };
  }

  private container(): Container | null {
    // `ctx.container` is present only when the class is declared in `containers`.
    const candidate = (this.state as unknown as { container?: Container }).container;
    return candidate ?? null;
  }
}

const JOB_KEY = "job";
/** Stages where a missing heartbeat means work was in flight. */
const IN_FLIGHT_STAGES = new Set<string>(["preflight", "pass1", "pass2", "assembling", "verify"]);

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? ((await object.json()) as T) : null;
}

/** The parts of a `/job` body the keep-alive needs, read from a clone of the request. */
async function readJobSpec(request: Request): Promise<{ args: string[]; version: string; stage: "pass1" | "pass2" } | null> {
  try {
    const body = (await request.clone().json()) as { args?: unknown };
    const args = Array.isArray(body?.args) ? body.args.map(String) : [];
    const index = args.indexOf("--version");
    const version = index === -1 ? "" : (args[index + 1] ?? "");
    if (!version || version.startsWith("--")) return null;
    return { args, version, stage: args[0] === "pass2" ? "pass2" : "pass1" };
  } catch {
    return null;
  }
}

async function startedDetached(response: Response): Promise<boolean> {
  const body = (await response.clone().json().catch(() => null)) as { started?: boolean } | null;
  return body?.started === true;
}

function failure(
  status: number,
  code: string,
  message: string,
  detail?: string,
  container?: ContainerErrorBody["container"],
): Response {
  const body: ContainerErrorBody = { error: { code, message, ...(detail ? { detail } : {}) }, ...(container ? { container } : {}) };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
