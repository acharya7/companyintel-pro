/**
 * Container entrypoint test — the image's real files, the real CLI, a fake R2.
 *
 * This is the regression test for the staging failure: `cloud/runner.mjs` resolved
 * its project root to its own directory (`/app/cloud`) and then spawned
 * `bun tools/cloud/cli.ts` with that root as cwd. The CLI lives at
 * `/app/tools/cloud/cli.ts`, so the child died instantly with "Could not find
 * module" while the runner still answered `202 {started:true}` and no checkpoint
 * was ever written to R2.
 *
 * The test builds the same directory shape the Dockerfile produces (repository
 * root → `cloud/`, `tools/`, `src/shared/`), starts the real runner from it with an
 * HTTP stub that speaks the small S3 subset the indexer uses, and requires:
 *
 *   - `/health` reports the repository root (not `cloud/`) and that the CLI exists;
 *   - a detached bounded benchmark answers 202 only while the child runs;
 *   - Pass 1 actually writes `cloud/jobs/<version>/state.json` and the per-source
 *     checkpoints to R2, with rows and segments recorded;
 *   - an immediate child failure is a 500 carrying its stderr, never a 202;
 *   - a missing CLI is a 503 on both routes, not a misleading success.
 *
 * It does not prove a Cloudflare Container runs; that needs a deploy. It proves the
 * entrypoint, paths and R2 writes the deployed image depends on.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");

/* ------------------------------- fake R2 --------------------------------- */

interface FakeR2 {
  endpoint: string;
  objects: Map<string, Buffer>;
  close(): Promise<void>;
}

async function startFakeR2(seed: Record<string, string>): Promise<FakeR2> {
  const objects = new Map<string, Buffer>(Object.entries(seed).map(([key, value]) => [key, Buffer.from(value, "utf8")]));
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    // /<bucket>/<key...>
    const parts = url.pathname.split("/").filter(Boolean);
    const key = decodeURIComponent(parts.slice(1).join("/"));

    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        response.writeHead(200, { etag: `"${key.length}"` });
        response.end();
      });
      return;
    }

    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const entries = [...objects.entries()]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([objectKey, body]) =>
            `<Contents><Key>${objectKey}</Key><Size>${body.length}</Size><LastModified>2026-10-21T00:00:00.000Z</LastModified><ETag>"x"</ETag></Contents>`,
        );
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${entries.join("")}</ListBucketResult>`;
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(xml);
      return;
    }

    const body = objects.get(key);
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.method === "HEAD") {
      response.writeHead(200, { "content-length": String(body.length), etag: `"${key.length}"` });
      response.end();
      return;
    }

    const range = /bytes=(\d+)-(\d+)/.exec(request.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]) + 1, body.length);
      const slice = body.subarray(start, end);
      response.writeHead(206, { "content-length": String(slice.length), "content-range": `bytes ${start}-${end - 1}/${body.length}` });
      response.end(slice);
      return;
    }
    response.writeHead(200, { "content-length": String(body.length), etag: `"${key.length}"` });
    response.end(body);
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/* ----------------------------- image layout ------------------------------ */

const roots: string[] = [];

/** The directories the Dockerfile copies, at the same relative paths. */
function makeImageRoot(options: { withTools?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "companyintel-image-"));
  roots.push(root);
  cpSync(join(repo, "package.json"), join(root, "package.json"));
  cpSync(join(repo, "cloud"), join(root, "cloud"), { recursive: true });
  cpSync(join(repo, "src", "shared"), join(root, "src", "shared"), { recursive: true });
  if (options.withTools !== false) {
    cpSync(join(repo, "tools"), join(root, "tools"), { recursive: true });
    mkdirSync(join(root, "tools", "indexer"), { recursive: true });
    writeFileSync(
      join(root, "tools", "indexer", "indexer.runner-test.json"),
      `${JSON.stringify(
        {
          datasetVersion: "runner-test",
          sources: [
            {
              id: "csv1",
              path: "r2://company-intel-data/raw/file1.csv",
              encoding: "utf-8",
              delimiter: "\t",
              columns: { companyname: "organization_name", companydomain: "organization_domain" },
            },
            {
              id: "csv2",
              path: "r2://company-intel-data/raw/file2.csv",
              encoding: "utf-8",
              delimiter: "\t",
              columns: { contactname: "person_name", companyname: "organization_name" },
            },
          ],
          partitions: 2,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return root;
}

function seedSources(): Record<string, string> {
  const companies = ["organization_id\torganization_name\torganization_domain"];
  const people = ["person_name\torganization_name\tperson_title"];
  for (let index = 0; index < 40; index += 1) {
    companies.push(`c${index}\tAcme ${index}\tacme${index}.example`);
    people.push(`Person ${index}\tAcme ${index}\tEngineer`);
  }
  return {
    "raw/file1.csv": `${companies.join("\n")}\n`,
    "raw/file2.csv": `${people.join("\n")}\n`,
  };
}

/* -------------------------------- runner --------------------------------- */

interface Runner {
  port: number;
  root: string;
  child: ChildProcess;
  stderr(): string;
  stop(): Promise<void>;
}

function cleanEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT_URL", "R2_BUCKET_NAME", "CLOUDFLARE_ACCOUNT_ID"]) {
    delete env[name];
  }
  // Point the file lookup at a path that cannot exist, so this test never picks up
  // the developer's real credentials.
  env.COMPANYINTEL_R2_CREDENTIALS = join(tmpdir(), "companyintel-no-such-credentials.json");
  return { ...env, ...overrides };
}

async function startRunner(root: string, env: Record<string, string>): Promise<Runner> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, "cloud", "runner.mjs")], {
    cwd: tmpdir(),
    env: { ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.resume();

  const runner: Runner = {
    port,
    root,
    child,
    stderr: () => stderr,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once("exit", () => done());
        child.kill("SIGKILL");
      }),
  };

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200 || response.status === 503) return runner;
    } catch {
      // not listening yet
    }
    await new Promise((sleep) => setTimeout(sleep, 100));
  }
  await runner.stop();
  throw new Error(`runner did not start. stderr:\n${stderr}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function postJob(runner: Runner, args: string[]): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${runner.port}/job`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args, detach: true }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function waitFor<T>(check: () => Promise<T | null> | T | null, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((sleep) => setTimeout(sleep, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms${last ? `: ${String(last)}` : ""}`);
}

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/* --------------------------------- tests --------------------------------- */

describe("cloud/runner.mjs (image layout, real CLI, stub R2)", () => {
  test("resolves the repository root and can run Pass 1, writing state and checkpoints", async () => {
    const fake = await startFakeR2(seedSources());
    const root = makeImageRoot();
    const runner = await startRunner(
      root,
      cleanEnv({
        R2_ACCOUNT_ID: "test-account",
        R2_ACCESS_KEY_ID: "AKIDTEST",
        R2_SECRET_ACCESS_KEY: "secret-test",
        R2_ENDPOINT_URL: fake.endpoint,
        R2_BUCKET_NAME: "company-intel-data",
      }),
    );

    try {
      const health = await fetch(`http://127.0.0.1:${runner.port}/health`);
      const healthBody = (await health.json()) as { ok: boolean; root: string; cliPresent: boolean };
      expect(health.status).toBe(200);
      expect(healthBody.ok).toBe(true);
      // The regression: this used to be `<root>/cloud`.
      expect(healthBody.root).toBe(root);
      expect(healthBody.cliPresent).toBe(true);

      const version = "stg-runner-test";
      const started = await postJob(runner, [
        "benchmark",
        "--version",
        version,
        "--config",
        "tools/indexer/indexer.runner-test.json",
        "--max-source-mb",
        "1",
        "--partitions",
        "2",
        "--chunk-mb",
        "1",
      ]);
      // A tiny in-memory job can legitimately finish inside the settle window; both
      // answers are honest, a false 202 for a dead child is not (tested below).
      expect([200, 202]).toContain(started.status);
      if (started.status === 202) expect(started.body.started).toBe(true);
      else expect(started.body.completed).toBe(true);

      // The first write happens before any source byte is read (stage pass1, zero
      // rows); the checkpointed progress is a later write to the same object.
      const state = await waitFor(() => {
        const body = fake.objects.get(`cloud/jobs/${version}/state.json`);
        if (!body) return null;
        const parsed = JSON.parse(body.toString("utf8")) as { version: string; stage: string; totals: { rowsRead: number } };
        return parsed.totals.rowsRead > 0 ? parsed : null;
      });
      expect(state.version).toBe(version);
      // `pass1` while chunks are being written, `pass1-complete` once both bounded
      // prefixes are done — both are Pass 1 having actually started.
      expect(state.stage.startsWith("pass1")).toBe(true);
      expect(state.totals.rowsRead).toBeGreaterThan(0);

      // The per-source checkpoint is what a restart resumes from: written after the
      // chunk's segments are uploaded and verified.
      for (const source of ["csv1", "csv2"]) {
        const checkpointBody = await waitFor(() => fake.objects.get(`cloud/jobs/${version}/checkpoints/${source}.json`) ?? null);
        const checkpoint = JSON.parse(checkpointBody.toString("utf8")) as {
          chunks: number;
          rows: number;
          nextOffset: number;
          complete: boolean;
        };
        expect(checkpoint.chunks).toBeGreaterThanOrEqual(1);
        expect(checkpoint.rows).toBeGreaterThan(0);
        expect(checkpoint.nextOffset).toBeGreaterThan(0);
        expect(checkpoint.complete).toBe(true);
      }

      // A segment object exists exactly where the Worker-side verifier looks.
      const segmentKeys = [...fake.objects.keys()].filter((key) => key.startsWith(`cloud/jobs/${version}/segments/`));
      expect(segmentKeys.length).toBeGreaterThan(0);
      expect(segmentKeys.every((key) => key.endsWith(".jsonl.gz"))).toBe(true);
    } finally {
      await runner.stop();
      await fake.close();
    }
  }, 60_000);

  test("a detached job that dies immediately is reported as a failure, not a 202", async () => {
    // Same image, no credentials: the CLI exits within milliseconds. Before the fix
    // this answered 202 and the panel waited forever for a state object.
    const root = makeImageRoot();
    const runner = await startRunner(root, cleanEnv({}));
    try {
      const failed = await postJob(runner, ["benchmark", "--version", "stg-no-creds", "--max-source-mb", "1", "--partitions", "2"]);
      expect(failed.status).toBe(500);
      const error = failed.body.error as { code: string; message: string; detail?: string };
      expect(error.code).toBe("job_failed_to_start");
      expect(`${error.message} ${error.detail ?? ""}`).toContain("R2 credentials");
      expect(failed.body.started).toBeUndefined();
    } finally {
      await runner.stop();
    }
  }, 30_000);

  test("a container whose image lost tools/ reports 503 instead of accepting jobs", async () => {
    const root = makeImageRoot({ withTools: false });
    const runner = await startRunner(root, cleanEnv({}));
    try {
      const health = await fetch(`http://127.0.0.1:${runner.port}/health`);
      expect(health.status).toBe(503);
      const body = (await health.json()) as { ok: boolean; cliPresent: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.cliPresent).toBe(false);
      expect(body.error).toContain("tools/cloud/cli.ts");

      const job = await postJob(runner, ["benchmark", "--version", "stg-missing-cli", "--max-source-mb", "1", "--partitions", "2"]);
      expect(job.status).toBe(503);
      expect((job.body.error as { code: string }).code).toBe("cli_missing");
    } finally {
      await runner.stop();
    }
  }, 30_000);
});
