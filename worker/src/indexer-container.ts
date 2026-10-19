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
 * The worker-side orchestration (admin routes, Access checks, approval gates) lives
 * in `indexer-admin.ts`; keeping it out of the DO means the container instance can
 * restart without losing any control state, which lives in R2.
 */

import type { Env } from "./env";

/** The port `cloud/runner.mjs` listens on (see cloud/Dockerfile). */
export const CONTAINER_PORT = 8080;

export interface EnvWithContainer extends Env {
  /**
   * Durable Object namespace bound to `IndexerContainer`. Optional on purpose: a
   * deployment without the Containers binding still serves the application, and the
   * admin routes answer `503 indexing_container_unavailable` instead of pretending.
   */
  INDEXER_CONTAINER?: DurableObjectNamespace;
}

export class IndexerContainer implements DurableObject {
  /**
   * `start()` is idempotent in the Containers runtime: calling it on a running
   * instance is a no-op, so it is safe on every request.
   */
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return this.forward(request);
    if (url.pathname === "/job" && request.method === "POST") return this.forward(request);
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Start the container, then proxy the request to it.
   *
   * The indexing CLI writes its own progress to R2, so a streaming response is not
   * required for correctness; the caller (admin route) waits for the run to finish
   * or returns as soon as the container accepted the job, depending on the route.
   */
  private async forward(request: Request): Promise<Response> {
    const container = this.container();
    if (!container) {
      return new Response(JSON.stringify({ error: "INDEXER_CONTAINER binding is not configured" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    await this.state.blockConcurrencyWhile(async () => {
      const running = await container.inspect().catch(() => null);
      if (!running) await container.start({ enableInternet: true });
    });
    // `getTcpPort` is the typed way to reach the port the container listens on.
    return container.getTcpPort(CONTAINER_PORT).fetch(request);
  }

  private container(): Container | null {
    // `ctx.container` is present only when the class is declared in `containers`.
    const candidate = (this.state as unknown as { container?: Container }).container;
    return candidate ?? null;
  }
}
