/**
 * Container Durable Object readiness tests.
 *
 * `container.start()` returns before the port is listening, so the DO used to
 * proxy the request into a half-started instance and the caller saw a bare 502.
 * These tests drive the real DO class with a fake container and require:
 *
 *   - `start()` is called exactly once, with the R2 credentials and the budget;
 *   - the DO polls the runner's `/health` until it is ready, then forwards;
 *   - a container that never becomes ready answers 503 `container_not_ready`
 *     (JSON, with the wait duration) instead of a transport error;
 *   - a runner that is up but reports 503 (missing CLI) fails immediately rather
 *     than waiting out the timeout;
 *   - a missing binding or a throwing `start()` is a JSON 503, never a crash.
 */

import { describe, expect, test } from "bun:test";

import { CONTAINER_PORT, IndexerContainer } from "../worker/src/indexer-container";
import type { EnvWithContainer } from "../worker/src/indexer-container";

interface FakeCall {
  port: number;
  request: Request | string;
}

function fakeContainer(options: {
  health?: () => { status: number; body?: string } | "throw";
  forwards?: (request: Request | string) => Response;
}) {
  let running = false;
  const starts: Record<string, string>[] = [];
  const calls: FakeCall[] = [];
  let healthAttempts = 0;

  const container = {
    get running() {
      return running;
    },
    start(startOptions?: { env?: Record<string, string> }) {
      starts.push(startOptions?.env ?? {});
      running = true;
    },
    getTcpPort(port: number) {
      return {
        fetch: async (request: Request | string): Promise<Response> => {
          const url = typeof request === "string" ? new URL(request) : new URL(request.url);
          if (url.pathname === "/health") {
            healthAttempts += 1;
            const health = options.health?.() ?? { status: 200, body: JSON.stringify({ ok: true }) };
            if (health === "throw") throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
            return new Response(health.body ?? "", {
              status: health.status,
              headers: { "content-type": "application/json" },
            });
          }
          calls.push({ port, request });
          return (
            options.forwards?.(request) ??
            new Response(JSON.stringify({ started: true, pid: 123 }), {
              status: 202,
              headers: { "content-type": "application/json" },
            })
          );
        },
      };
    },
  };

  return {
    container,
    starts,
    calls,
    healthAttempts: () => healthAttempts,
    setRunning(value: boolean) {
      running = value;
    },
  };
}

function stateWith(container: unknown): DurableObjectState {
  return {
    container,
    blockConcurrencyWhile: async (callback: () => Promise<void>) => {
      await callback();
    },
  } as unknown as DurableObjectState;
}

function env(overrides: Partial<EnvWithContainer> = {}): EnvWithContainer {
  return {
    COMPANY_DATA: {} as R2Bucket,
    R2_ACCOUNT_ID: "acct-123",
    R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
    R2_SECRET_ACCESS_KEY: "super-secret-value",
    CLOUD_JOB_BUDGET_USD: "5",
    ...overrides,
  };
}

function jobRequest(): Request {
  return new Request("http://container/job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args: ["benchmark", "--version", "stg-x", "--max-source-mb", "16"], detach: true }),
  });
}

describe("IndexerContainer cold starts", () => {
  test("starts once with the container environment, waits for readiness and forwards", async () => {
    const fake = fakeContainer({
      health: () => (fake.healthAttempts() < 3 ? "throw" : { status: 200, body: JSON.stringify({ ok: true }) }),
    });
    const object = new IndexerContainer(stateWith(fake.container), env({ CONTAINER_READY_TIMEOUT_MS: "5000" }));

    const response = await object.fetch(jobRequest());
    const text = await response.text();

    expect(response.status).toBe(202);
    expect(JSON.parse(text)).toEqual({ started: true, pid: 123 });
    expect(text).not.toContain("super-secret-value");
    expect(fake.starts).toHaveLength(1);
    // Credentials are forwarded to the container, never into the response.
    expect(fake.starts[0]).toEqual({
      R2_ACCOUNT_ID: "acct-123",
      R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
      R2_SECRET_ACCESS_KEY: "super-secret-value",
      CLOUD_JOB_BUDGET_USD: "5",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.port).toBe(CONTAINER_PORT);
  }, 20_000);

  test("does not restart a running container", async () => {
    const fake = fakeContainer({
      forwards: (request) => {
        const url = typeof request === "string" ? new URL(request) : new URL(request.url);
        return url.pathname === "/health"
          ? new Response(JSON.stringify({ ok: true, root: "/app" }), { status: 200, headers: { "content-type": "application/json" } })
          : new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
      },
    });
    fake.setRunning(true);
    const object = new IndexerContainer(stateWith(fake.container), env({ CONTAINER_READY_TIMEOUT_MS: "1000" }));

    const response = await object.fetch(new Request("http://container/health"));
    expect(response.status).toBe(200);
    expect(fake.starts).toHaveLength(0);
  }, 20_000);

  test("a container that never becomes ready answers JSON 503 with the wait, not a 502", async () => {
    const fake = fakeContainer({ health: () => "throw" });
    const object = new IndexerContainer(stateWith(fake.container), env({ CONTAINER_READY_TIMEOUT_MS: "300" }));

    const startedAt = Date.now();
    const response = await object.fetch(jobRequest());
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      error: { code: string; message: string; detail?: string };
      container: { running: boolean; ready: boolean; waitedMs: number };
    };
    expect(body.error.code).toBe("container_not_ready");
    expect(body.error.message).toContain("did not become ready");
    expect(body.error.detail).toContain("ECONNREFUSED");
    expect(body.container.ready).toBe(false);
    expect(body.container.running).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(fake.calls).toHaveLength(0);
  }, 20_000);

  test("a runner that is up but unusable is reported immediately, not retried", async () => {
    const fake = fakeContainer({
      health: () => ({ status: 503, body: JSON.stringify({ ok: false, cliPresent: false, error: "The indexing CLI is missing at /app/tools/cloud/cli.ts." }) }),
    });
    const object = new IndexerContainer(stateWith(fake.container), env({ CONTAINER_READY_TIMEOUT_MS: "30000" }));

    const response = await object.fetch(jobRequest());

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string; detail?: string } };
    expect(body.error.code).toBe("container_not_ready");
    expect(body.error.message).toContain("not usable");
    expect(body.error.detail).toContain("tools/cloud/cli.ts");
    // Exactly one probe: waiting out a 30 s timeout would be pointless.
    expect(fake.healthAttempts()).toBe(1);
    expect(fake.calls).toHaveLength(0);
  }, 20_000);

  test("a missing binding and a failing start are JSON 503s", async () => {
    const unbound = new IndexerContainer(stateWith(undefined), env({}));
    const unboundResponse = await unbound.fetch(jobRequest());
    expect(unboundResponse.status).toBe(503);
    expect(((await unboundResponse.json()) as { error: { code: string } }).error.code).toBe("indexing_container_unavailable");

    const broken = fakeContainer({});
    broken.container.start = () => {
      throw new Error("container quota exceeded");
    };
    const failing = new IndexerContainer(stateWith(broken.container), env({ CONTAINER_READY_TIMEOUT_MS: "1000" }));
    const failingResponse = await failing.fetch(jobRequest());
    expect(failingResponse.status).toBe(503);
    const body = (await failingResponse.json()) as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe("container_start_failed");
    expect(body.error.detail).toContain("quota");
  }, 20_000);

  test("unknown container paths are JSON 404s", async () => {
    const fake = fakeContainer({});
    const object = new IndexerContainer(stateWith(fake.container), env({}));
    const response = await object.fetch(new Request("http://container/exec"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});
