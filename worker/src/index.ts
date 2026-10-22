/**
 * CompanyIntel Worker entrypoint.
 *
 * Exports the Hono app as the module Worker's fetch handler. Static assets are
 * served through the `ASSETS` binding (Workers Static Assets) with an SPA
 * fallback, and `/api/*` is handled by the application router.
 *
 * Routing order matters. Workers Static Assets answers a request from `./dist`
 * before this script runs, and with `not_found_handling = "single-page-application"`
 * an unmatched path becomes the SPA shell (or an asset 404) — so an API path that
 * is not listed in `assets.run_worker_first` never reaches this file at all. Both
 * `wrangler.toml` and `wrangler.staging.toml` therefore declare
 * `run_worker_first = ["/api", "/api/*"]`, and `tests/worker-entry-routing.test.ts` checks
 * the config and this dispatch together, because the failure mode is silent: the
 * browser gets HTML where it expected JSON.
 *
 * `/api/cloud/*` is the indexing control plane. It is routed separately because it
 * is not part of the search API: it verifies Access itself, checks the admin
 * allowlist, and is the only place that can start the indexing container.
 *
 * `IndexerContainer` is exported because a Durable Object class must be exported by
 * the Worker that declares it. Without the `[[containers]]` block in `wrangler.toml`
 * the class is inert and the admin routes report that the container is unavailable;
 * the application keeps serving normally.
 *
 * Security posture (see docs/security.md):
 *  - every /api route requires a verified Cloudflare Access JWT,
 *  - cross-origin requests are rejected,
 *  - the R2 bucket is private and only reachable through the binding,
 *  - no secret is ever echoed to the client.
 */

import { app } from "./app";
import { indexingAdmin } from "./indexer-admin";
import { IndexerContainer, type EnvWithContainer } from "./indexer-container";
import { IndexerWorker, type WorkerEnv } from "./indexer-worker";
import { IndexingCoordinator } from "./indexing-coordinator";
import { swarmActiveWorkerIds } from "../../src/shared/cloud/swarm";

/*
 * Durable Object classes must be exported by the Worker that declares them.
 *
 *   IndexerContainer    the single-job container (legacy path and direct R2 scans)
 *   IndexerWorker       one container per swarm worker (16 identities)
 *   IndexingCoordinator the swarm's task table, leases, phases and budget
 */
export { IndexerContainer, IndexerWorker, IndexingCoordinator };

type AppEnv = EnvWithContainer & WorkerEnv;

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Response | Promise<Response> {
    const path = new URL(request.url).pathname;
    // The indexing control plane (mounted with basePath `/api/cloud`).
    if (path === "/api/cloud" || path.startsWith("/api/cloud/")) {
      return indexingAdmin.fetch(request, env, ctx);
    }
    // Everything else — including every other `/api/*` path — goes through the
    // Hono app, which answers unknown API paths with JSON 404 and only falls back
    // to the SPA shell for non-API paths.
    return app.fetch(request, env, ctx);
  },

  /**
   * Swarm maintenance (cron).
   *
   * A full-corpus run lasts hours, and two things silently end it: every container
   * in the fleet is gone (so nothing claims the next task), and tasks parked by an
   * environmental failure (R2 502, "no container instance", a ready timeout) are
   * terminal even though the work was never given a fair attempt. This pass fixes
   * both, without touching paused/aborted/finished runs and without retrying a
   * task whose error is deterministic.
   */
  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    const namespace = env.INDEXING_COORDINATOR;
    if (!namespace) return;
    const coordinator = namespace.get(namespace.idFromName("swarm"));
    ctx.waitUntil(
      (async () => {
        const statusResponse = await coordinator.fetch("https://coordinator/status", { method: "GET" });
        if (!statusResponse.ok) return;
        const status = (await statusResponse.json()) as {
          stage?: string;
          workersAuthorised?: number;
          tasks?: { failed?: number };
        };
        if (!status.stage || ["paused", "aborted", "complete", "failed", "planned"].includes(status.stage)) return;

        await coordinator
          .fetch("https://coordinator/retry-parked", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ limit: 32, transientOnly: true }),
          })
          .catch(() => null);

        const workers = env.INDEXER_WORKER;
        if (!workers) return;
        const ids = swarmActiveWorkerIds(status.workersAuthorised ?? 1);
        await Promise.all(
          ids.map((workerId: string) =>
            workers
              .get(workers.idFromName(workerId))
              .fetch("https://worker/pump", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ workerId }),
              })
              .catch(() => null),
          ),
        );
      })(),
    );
  },
} satisfies ExportedHandler<AppEnv>;
