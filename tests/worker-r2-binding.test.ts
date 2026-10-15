/**
 * Architecture guard: production Worker → R2 goes through the binding only.
 *
 * The deployment must reach the bucket with the native `COMPANY_DATA` R2 binding
 * (no keys at all), while the S3-compatible client — which needs
 * `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — stays confined
 * to the local indexer and the verification scripts on your machine.
 *
 * These assertions read the real config and source files, so they fail if someone
 * later wires an S3 secret into the Worker, publishes the bucket, or renames the
 * binding away from what `wrangler.toml` declares.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

/** Config lines only: comments explain the rules and must not satisfy (or trip) a check. */
const wranglerConfig = readFileSync(join(root, "wrangler.toml"), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
const envTypes = readFileSync(join(root, "worker/src/env.d.ts"), "utf8");
const workerFiles = walk(join(root, "worker")).filter((path) => path.endsWith(".ts"));
const workerSource = workerFiles.map((path) => readFileSync(path, "utf8")).join("\n");

describe("wrangler.toml declares a private R2 binding", () => {
  test("the COMPANY_DATA binding points at company-intel-data", () => {
    expect(wranglerConfig).toContain("[[r2_buckets]]");
    expect(wranglerConfig).toMatch(/binding\s*=\s*"COMPANY_DATA"/);
    expect(wranglerConfig).toMatch(/bucket_name\s*=\s*"company-intel-data"/);
  });

  test("the bucket is not made public", () => {
    expect(wranglerConfig).not.toContain("r2.dev");
    expect(wranglerConfig).not.toMatch(/public_bucket/);
    expect(wranglerConfig).not.toMatch(/custom_domain/);
    expect(wranglerConfig).not.toMatch(/preview_urls/);
  });
});

describe("the Worker code never uses S3 credentials", () => {
  test("no worker source file reads an R2 S3 secret", () => {
    expect(workerSource).not.toContain("R2_ACCESS_KEY_ID");
    expect(workerSource).not.toContain("R2_SECRET_ACCESS_KEY");
    expect(workerSource).not.toContain("R2_ACCOUNT_ID");
    expect(workerSource).not.toContain("cloudflarestorage.com");
  });

  test("the Worker uses the binding and declares it in its Env type", () => {
    expect(envTypes).toMatch(/COMPANY_DATA:\s*R2Bucket/);
    expect(workerSource).toMatch(/env\.COMPANY_DATA/);
  });

  test("the S3 client exists only outside worker/ (local indexer + scripts)", () => {
    const s3Client = readFileSync(join(root, "tools/indexer/src/r2.ts"), "utf8");
    expect(s3Client).toContain("process.env.R2_ACCESS_KEY_ID");
    expect(s3Client).toContain("cloudflarestorage.com");
    // Imported by the local scripts, never by the Worker.
    expect(workerSource).not.toMatch(/from\s+["'].*tools\/indexer/);
  });
});

/* -------------------------------------------------------------------------- */
/* The isolated read-only probe                                               */
/* -------------------------------------------------------------------------- */

function configLines(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const probeConfig = configLines(join(root, "probe/wrangler.toml"));
const probeFiles = walk(join(root, "probe")).filter((path) => path.endsWith(".ts"));
const probeSource = probeFiles.map((path) => readFileSync(path, "utf8")).join("\n");
const sharedR2Source = walk(join(root, "src/shared/r2"))
  .filter((path) => path.endsWith(".ts"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

/** Any of the calls that would change a bucket. */
const WRITE_CALLS = /\b(put|delete|upload|copy|createMultipartUpload|restore)\s*\(/;

describe("the read-only probe is isolated from the deployment", () => {
  test("the probe config binds the real bucket remotely and cannot be deployed as a site", () => {
    expect(probeConfig).toMatch(/binding\s*=\s*"COMPANY_DATA"/);
    expect(probeConfig).toMatch(/bucket_name\s*=\s*"company-intel-data"/);
    // Remote binding: Worker code runs locally, the binding talks to the real bucket.
    expect(probeConfig).toMatch(/remote\s*=\s*true/);
    // Nothing to serve publicly, and nothing to route to.
    expect(probeConfig).toMatch(/workers_dev\s*=\s*false/);
    expect(probeConfig).not.toMatch(/\[assets\]/);
    expect(probeConfig).not.toMatch(/\[\[routes\]\]/);
    expect(probeConfig).not.toMatch(/custom_domain|r2\.dev/);
    expect(probeConfig).toMatch(/main\s*=\s*"src\/index\.ts"/);
  });

  test("the production config is untouched and never points at the probe", () => {
    expect(wranglerConfig).toMatch(/main\s*=\s*"worker\/src\/index\.ts"/);
    expect(wranglerConfig).not.toContain("probe/");
    // The production binding must NOT be a remote binding: the deployed Worker uses
    // the real binding, and `remote` is a local-development-only concept.
    expect(wranglerConfig).not.toMatch(/remote\s*=\s*true/);
  });

  test("no probe or shared R2 source can write, delete or upload", () => {
    for (const [name, source] of [
      ["probe", probeSource],
      ["src/shared/r2", sharedR2Source],
    ] as const) {
      expect(`${name}:${WRITE_CALLS.test(source)}`).toBe(`${name}:false`);
    }
  });

  test("the probe reads the bucket only through list/head/get", () => {
    const surface = /interface ReadOnlyBucket \{([\s\S]*?)\n\}/.exec(sharedR2Source)?.[1] ?? "";
    expect(surface).toContain("list(");
    expect(surface).toContain("head(");
    expect(surface).toContain("get(");
    expect(surface).not.toMatch(WRITE_CALLS);
    // The probe's own bucket reference is the shared read-only interface, with no
    // cast that could hide an incompatible (writable) shape.
    expect(probeSource).toMatch(/const bucket: ReadOnlyBucket = env\.COMPANY_DATA/);
  });

  test("no probe source reads an S3 secret or the environment", () => {
    expect(probeSource).not.toContain("R2_ACCESS_KEY_ID");
    expect(probeSource).not.toContain("R2_SECRET_ACCESS_KEY");
    expect(probeSource).not.toContain("R2_ACCOUNT_ID");
    expect(probeSource).not.toContain("cloudflarestorage.com");
    expect(probeSource).not.toContain("process.env");
  });

  test("the probe never imports the production worker or its business endpoints", () => {
    expect(probeSource).not.toContain("worker/src");
    expect(probeSource).not.toMatch(/saved-lead|savedLead|\/api\/leads|\/api\/exports|\/api\/settings/);
  });
});
