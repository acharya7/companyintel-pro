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
/**
 * The two container bridges are the deliberate exception: a Cloudflare Container has
 * no R2 binding, so it receives the S3 credentials through `container.start({ env })`.
 * `indexer-container.ts` owns the single-job container and the direct R2 scan;
 * `indexer-worker.ts` owns one swarm worker container. Everything else in `worker/`
 * must stay free of them — asserted below.
 */
const containerBridge = readFileSync(join(root, "worker/src/indexer-container.ts"), "utf8");
const workerBridge = readFileSync(join(root, "worker/src/indexer-worker.ts"), "utf8");
const BRIDGE_FILES = ["indexer-container.ts", "indexer-worker.ts"];
const workerSourceExceptContainer = workerFiles
  // `env.d.ts` only declares the container-only secret names; runtime source is
  // what must never read them.
  .filter((path) => !BRIDGE_FILES.some((name) => path.endsWith(name)) && !path.endsWith("env.d.ts"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

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
    expect(workerSourceExceptContainer).not.toContain("R2_ACCESS_KEY_ID");
    expect(workerSourceExceptContainer).not.toContain("R2_SECRET_ACCESS_KEY");
    expect(workerSourceExceptContainer).not.toContain("R2_ACCOUNT_ID");
    expect(workerSourceExceptContainer).not.toContain("cloudflarestorage.com");
  });

  test("both container bridges forward credentials but never read or expose them", () => {
    // The names may appear only as `env.X = this.env.X` on the start call.
    for (const bridge of [containerBridge, workerBridge]) {
      expect(bridge).not.toContain("cloudflarestorage.com");
      expect(bridge).not.toContain("R2Client");
      expect(bridge).not.toContain("console.log");
      for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
        const occurrences = bridge.split(name).length - 1;
        expect(occurrences).toBe(3); // `if (this.env.X) env.X = this.env.X;`
      }
      expect(bridge).toContain("container.start({ enableInternet: true, env");
    }
  });

  test("the Worker uses the binding and declares it in its Env type", () => {
    expect(envTypes).toMatch(/COMPANY_DATA:\s*R2Bucket/);
    expect(workerSource).toMatch(/env\.COMPANY_DATA/);
  });

  test("the S3 client and its credential resolver exist only outside worker/", () => {
    // Signing lives in r2.ts; the credential *resolution* (environment first, then
    // the private git-ignored file) lives in credentials.ts. Both are local-only.
    const s3Client = readFileSync(join(root, "tools/indexer/src/r2.ts"), "utf8");
    expect(s3Client).toContain("cloudflarestorage.com");
    const resolver = readFileSync(join(root, "tools/indexer/src/credentials.ts"), "utf8");
    expect(resolver).toContain('envValue("R2_ACCESS_KEY_ID")');
    expect(resolver).toContain('envValue("R2_SECRET_ACCESS_KEY")');
    expect(resolver).toContain("DEFAULT_CREDENTIAL_FILE_NAME");
    // The loader must never read a build-time (Vite) variable: a secret that way
    // would end up in the browser bundle.
    expect(resolver).not.toContain("import.meta.env");
    expect(resolver).not.toMatch(/from\s+["'].*src\//);
    // Imported by the local scripts, never by the Worker or the browser bundle.
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

/* -------------------------------------------------------------------------- */
/* Fixed server-side credentials stay server-side                             */
/* -------------------------------------------------------------------------- */

const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
const clientSource = walk(join(root, "src"))
  .filter((path) => /\.(ts|tsx)$/.test(path))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const credentialResolver = readFileSync(join(root, "tools/indexer/src/credentials.ts"), "utf8");

describe("the fixed R2 credentials cannot reach a browser or a deployment", () => {
  test("production has no workers.dev alias, while development keeps one", () => {
    // Split on the development environment: the top-level settings apply to the
    // deployed worker, so *that* half must have the alias switched off.
    const [production, development = ""] = wranglerConfig.split("[env.development]");
    expect(production).toMatch(/workers_dev\s*=\s*false/);
    expect(production).not.toMatch(/workers_dev\s*=\s*true/);
    expect(development).toMatch(/workers_dev\s*=\s*true/);
  });

  test("the private credential file and the real data it feeds are git-ignored", () => {
    expect(gitignore).toMatch(/\.r2-credentials\*?\.json/);
    expect(gitignore).toContain(".indexer-output/");
    expect(gitignore).toContain(".indexer-work/");
    expect(gitignore).toContain(".indexer-raw-cache/");
    expect(gitignore).toContain(".raw-samples/");
  });

  test("no browser-bundle file can reach the credential resolver", () => {
    expect(clientSource).not.toContain("r2-credentials");
    expect(clientSource).not.toContain("R2_SECRET_ACCESS_KEY");
    expect(clientSource).not.toContain("R2_ACCESS_KEY_ID");
    expect(clientSource).not.toMatch(/tools\/indexer\/src\/credentials/);
  });

  test("the resolver reports presence, never a value", () => {
    // It has no console output at all, and its status object exposes booleans.
    expect(credentialResolver).not.toContain("console.log");
    expect(credentialResolver).toMatch(/hasSecretAccessKey: boolean/);
    expect(credentialResolver).toMatch(/hasAccessKeyId: boolean/);
  });
});
