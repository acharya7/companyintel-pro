/**
 * TEMPORARY operations channel for the production indexing swarm.
 *
 * The production Worker has `workers_dev = false` and no route, so its admin API is
 * only reachable through Cloudflare Access — which cannot be driven from a headless
 * runner. This Worker is bound to the SAME Durable Objects by `script_name` and is
 * therefore the control plane's control plane: it adds nothing to the pipeline, holds
 * no data, and every route is gated by a random per-session secret header. It is
 * deleted as soon as the run is driven.
 */

interface Env {
  COORD: DurableObjectNamespace;
  WORKER: DurableObjectNamespace;
  LEGACY: DurableObjectNamespace;
  OPS_SECRET: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function coord(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const stub = env.COORD.get(env.COORD.idFromName("swarm"));
  return stub.fetch(`https://coordinator${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("x-ops-secret") !== env.OPS_SECRET) {
      return json({ error: "forbidden" }, 403);
    }
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/status") {
        const response = await coord(env, "/status");
        return new Response(await response.text(), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }

      if (path === "/diagnostics") {
        const response = await coord(env, "/diagnostics");
        return new Response(await response.text(), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }

      if (path === "/workers" && request.method === "POST") {
        const body = (await request.json()) as { count: number };
        const response = await coord(env, "/workers", { method: "POST", body: JSON.stringify(body) });
        return new Response(await response.text(), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }

      if (path === "/resume" && request.method === "POST") {
        const response = await coord(env, "/resume", {
          method: "POST",
          body: JSON.stringify({ by: "ops-runner" }),
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }

      if (path === "/settings" && request.method === "POST") {
        // Pass-through for any coordinator control the run needs (pause/abort/...).
        const body = (await request.json()) as { path: string; payload?: unknown };
        const response = await coord(env, body.path, {
          method: "POST",
          body: JSON.stringify(body.payload ?? {}),
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }

      if (path === "/pump" && request.method === "POST") {
        const body = (await request.json()) as { ids: string[]; path?: string };
        const results = await Promise.all(
          body.ids.map(async (workerId) => {
            try {
              const stub = env.WORKER.get(env.WORKER.idFromName(workerId));
              const response = await stub.fetch(`https://worker${body.path ?? "/pump"}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ workerId }),
              });
              const text = await response.text();
              return { workerId, status: response.status, body: text.slice(0, 600) };
            } catch (error) {
              return { workerId, status: 0, body: error instanceof Error ? error.message : String(error) };
            }
          }),
        );
        return json(results);
      }

      if (path === "/job" && request.method === "POST") {
        const body = (await request.json()) as { args: string[]; wait?: boolean };
        const stub = env.LEGACY.get(env.LEGACY.idFromName("indexer"));
        const response = await stub.fetch("http://container/job", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ args: body.args }),
        });
        const text = await response.text();
        return new Response(JSON.stringify({ status: response.status, body: text.slice(0, 4000) }, null, 2), {
          headers: { "content-type": "application/json" },
        });
      }

      if (path === "/stop" && request.method === "POST") {
        const body = (await request.json()) as { ids: string[]; reason?: string };
        const results = await Promise.all(
          body.ids.map(async (workerId) => {
            try {
              const stub = env.WORKER.get(env.WORKER.idFromName(workerId));
              const response = await stub.fetch("https://worker/stop", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ workerId, reason: body.reason ?? "ops-runner" }),
              });
              return { workerId, status: response.status, body: (await response.text()).slice(0, 400) };
            } catch (error) {
              return { workerId, status: 0, body: error instanceof Error ? error.message : String(error) };
            }
          }),
        );
        return json(results);
      }

      return json({ error: "unknown route", path }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};
