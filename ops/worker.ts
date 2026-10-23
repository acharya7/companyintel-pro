/**
 * TEMPORARY operations channel for the production indexing swarm.
 *
 * Bound to the production Durable Objects by `script_name`, gated by a per-session
 * secret header. Holds no data; deleted when the run reaches activation.
 */

interface Env {
  COORD: DurableObjectNamespace;
  WORKER: DurableObjectNamespace;
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

async function relay(response: Response): Promise<Response> {
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("x-ops-secret") !== env.OPS_SECRET) return json({ error: "forbidden" }, 403);
    const path = new URL(request.url).pathname;
    try {
      if (path === "/status" || path === "/diagnostics") return relay(await coord(env, path));
      if (path === "/workers" || path === "/resume") {
        return relay(await coord(env, path, { method: "POST", body: JSON.stringify(await request.json()) }));
      }
      if (path === "/settings") {
        const body = (await request.json()) as { path: string; payload?: unknown };
        return relay(await coord(env, body.path, { method: "POST", body: JSON.stringify(body.payload ?? {}) }));
      }
      if (path === "/state") {
        const ids = ((await request.json()) as { ids: string[] }).ids;
        const states = await Promise.all(
          ids.map(async (workerId) => {
            const stub = env.WORKER.get(env.WORKER.idFromName(workerId));
            return { workerId, state: await (await stub.fetch("https://worker/state")).text() };
          }),
        );
        return json(states);
      }
      if (path === "/pump" || path === "/stop") {
        const body = (await request.json()) as { ids: string[]; reason?: string };
        const results = await Promise.all(
          body.ids.map(async (workerId) => {
            try {
              const stub = env.WORKER.get(env.WORKER.idFromName(workerId));
              const response = await stub.fetch(`https://worker${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ workerId, reason: body.reason }),
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
