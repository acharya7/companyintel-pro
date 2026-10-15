/**
 * CompanyIntel Worker entrypoint.
 *
 * Exports the Hono app as the module Worker's fetch handler. Static assets are
 * served through the `ASSETS` binding (Workers Static Assets) with an SPA
 * fallback, and `/api/*` is handled by the application router.
 *
 * Security posture (see docs/security.md):
 *  - every /api route requires a verified Cloudflare Access JWT,
 *  - cross-origin requests are rejected,
 *  - the R2 bucket is private and only reachable through the binding,
 *  - no secret is ever echoed to the client.
 */

import { app } from "./app";
import type { Env } from "./env";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
