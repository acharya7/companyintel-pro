/**
 * Admin start-route error propagation.
 *
 * Observed on staging: `POST /api/cloud/jobs/benchmark` returned 202 while the
 * container's CLI had already died and no state object was written. These tests
 * pin the contract between the Durable Object and the admin route:
 *
 *   - 503 `container_not_ready` / `cli_missing` from the DO stays a 503;
 *   - 500 `job_failed_to_start` (child died inside the settle window) becomes a
 *     502 that carries the same code and stderr detail, never a 202;
 *   - a command that finished before it could be detached is 200 `{started:false}`;
 *   - a container that accepted the job is the only path that answers 202.
 */

import { describe, expect, test } from "bun:test";

import { indexingAdmin } from "../worker/src/indexer-admin";
import type { Env } from "../worker/src/env";
import { FakeR2Bucket } from "./helpers/fake-r2";

interface Captured {
  url: string;
  body: unknown;
}

function envWithContainer(respond: () => Response | Promise<Response>, captured: Captured[]): Env {
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
        return respond();
      },
    }),
  };
  return {
    COMPANY_DATA: new FakeR2Bucket() as unknown as R2Bucket,
    ENVIRONMENT: "development",
    DEV_ALLOW_UNAUTHENTICATED: "true",
    INDEXER_CONTAINER: namespace,
    CLOUD_JOB_BUDGET_USD: "5",
  } as unknown as Env;
}

async function benchmark(env: Env): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await indexingAdmin.fetch(
    new Request("https://app.example/api/cloud/jobs/benchmark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "BENCHMARK", version: "stg-errors", maxSourceMb: 16, partitions: 8 }),
    }),
    env,
    {} as ExecutionContext,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const jsonResponse = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("admin start routes report container failures honestly", () => {
  test("a cold-start timeout is a 503 with the DO's code and message", async () => {
    const captured: Captured[] = [];
    const response = await benchmark(
      envWithContainer(
        () =>
          jsonResponse(503, {
            error: {
              code: "container_not_ready",
              message: "The indexing container did not become ready within 60s, so no job was started.",
              detail: "connect ECONNREFUSED 127.0.0.1:8080",
            },
            container: { running: true, ready: false, waitedMs: 60_000 },
          }),
        captured,
      ),
    );

    expect(response.status).toBe(503);
    const error = response.body.error as { code: string; message: string; detail?: string };
    expect(error.code).toBe("container_not_ready");
    expect(error.message).toContain("did not become ready");
    expect(error.detail).toContain("ECONNREFUSED");
    // The start is still a detached benchmark request, sent once.
    expect(captured).toHaveLength(1);
    expect((captured[0]!.body as { detach: boolean }).detach).toBe(true);
    expect((captured[0]!.body as { args: string[] }).args.slice(0, 2)).toEqual(["benchmark", "--version"]);
  });

  test("an immediate subprocess failure is a 502 carrying its stderr — never a 202", async () => {
    const response = await benchmark(
      envWithContainer(
        () =>
          jsonResponse(500, {
            error: {
              code: "job_failed_to_start",
              message: "The indexing command benchmark --version stg-errors failed to start: exit code 1.",
              detail: "No R2 credentials. Set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.",
            },
          }),
        [],
      ),
    );

    expect(response.status).toBe(502);
    const error = response.body.error as { code: string; message: string; detail?: string };
    expect(error.code).toBe("job_failed_to_start");
    expect(error.detail).toContain("No R2 credentials");
    expect(response.body.started).toBeUndefined();
  });

  test("a container whose image lost its CLI stays a 503 with the reason", async () => {
    const response = await benchmark(
      envWithContainer(
        () => jsonResponse(503, { error: { code: "cli_missing", message: "The indexing CLI is missing at /app/tools/cloud/cli.ts (root /app)." } }),
        [],
      ),
    );
    expect(response.status).toBe(503);
    expect((response.body.error as { code: string }).code).toBe("cli_missing");
    expect((response.body.error as { message: string }).message).toContain("/app/tools/cloud/cli.ts");
  });

  test("a command that ended before detaching is 200 {started:false}, not 202", async () => {
    const response = await benchmark(
      envWithContainer(() => jsonResponse(200, { started: false, completed: true, exitCode: 0, output: "completed quickly" }), []),
    );
    expect(response.status).toBe(200);
    expect(response.body.started).toBe(false);
    expect(response.body.completed).toBe(true);
    expect(response.body.exitCode).toBe(0);
    expect(response.body.version).toBe("stg-errors");
  });

  test("only an accepted job is a 202", async () => {
    const response = await benchmark(envWithContainer(() => jsonResponse(202, { started: true, pid: 42 }), []));
    expect(response.status).toBe(202);
    expect(response.body.started).toBe(true);
    expect(response.body.stage).toBe("pass1");
  });

  test("an unreachable container is a JSON 502, not an unhandled error", async () => {
    const response = await benchmark(
      envWithContainer(() => {
        throw new Error("container connection closed");
      }, []),
    );
    expect(response.status).toBe(502);
    expect((response.body.error as { code: string }).code).toBe("container_unreachable");
  });
});
