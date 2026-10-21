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

import type { Env } from "./env";

/** The port `cloud/runner.mjs` listens on (see Dockerfile / cloud/Dockerfile). */
export const CONTAINER_PORT = 8080;

/** How long a cold start may take before the request is answered with 503. */
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;

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
}

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
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return this.forward(request);
    if (url.pathname === "/job" && request.method === "POST") return this.forward(request);
    return failure(404, "not_found", `No container route for ${request.method} ${url.pathname}.`);
  }

  /**
   * Start the container if needed, wait until it is ready, then proxy the request.
   *
   * The indexing CLI writes its own progress to R2, so a streaming response is not
   * required for correctness; the caller (admin route) waits for the run to finish
   * or returns as soon as the container accepted the job, depending on the route.
   */
  private async forward(request: Request): Promise<Response> {
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
      return await container.getTcpPort(CONTAINER_PORT).fetch(request);
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
