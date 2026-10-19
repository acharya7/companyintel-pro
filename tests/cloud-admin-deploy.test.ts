/**
 * Deployment guards for the cloud indexing control plane.
 *
 * These do not prove a Cloudflare deployment (that needs Docker, a token and an
 * account), but they fail if the pieces that make one possible are removed or
 * weakened: the container binding and its migration, the exported Durable Object,
 * the Access check on every admin route, the approval gate for the full corpus, and
 * the activation gates.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const config = readFileSync(join(root, "wrangler.toml"), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
const entry = readFileSync(join(root, "worker/src/index.ts"), "utf8");
const admin = readFileSync(join(root, "worker/src/indexer-admin.ts"), "utf8");
const container = readFileSync(join(root, "worker/src/indexer-container.ts"), "utf8");
const runner = readFileSync(join(root, "cloud/runner.mjs"), "utf8");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const cloudDockerfile = readFileSync(join(root, "cloud", "Dockerfile"), "utf8");

describe("Cloudflare Containers deployment config", () => {
  test("declares the container, its Durable Object and the migration", () => {
    expect(config).toContain("[[containers]]");
    expect(config).toMatch(/class_name\s*=\s*"IndexerContainer"/);
    expect(config).toMatch(/image\s*=\s*"\.\/Dockerfile"/);
    expect(config).toMatch(/instance_type\s*=\s*"standard-1"/);
    expect(config).toMatch(/max_instances\s*=\s*1/);
    expect(config).toMatch(/name\s*=\s*"INDEXER_CONTAINER"/);
    expect(config).toMatch(/new_sqlite_classes\s*=\s*\["IndexerContainer"\]/);
  });

  test("the Worker exports the container class and routes the admin API", () => {
    expect(entry).toContain("export { IndexerContainer }");
    expect(entry).toContain('path.startsWith("/api/cloud/")');
    expect(entry).toContain("indexingAdmin.fetch");
    expect(container).toContain("implements DurableObject");
    expect(container).toContain("getTcpPort(CONTAINER_PORT)");
  });

  test("the image builds the indexing entrypoint only", () => {
    expect(dockerfile).toContain("oven/bun");
    expect(dockerfile).toContain('CMD ["bun", "cloud/runner.mjs"]');
    expect(dockerfile).toContain("COPY tools ./tools");
    expect(dockerfile).not.toContain("vite build");
  });

  test("both images pin a Bun that can read this lockfile, and install frozen", () => {
    // `bun.lock` is lockfile format 2. Bun 1.2.x cannot parse it ("Unknown
    // lockfile version"), which failed the Container image build; a floating or
    // older tag would reintroduce that failure silently.
    for (const image of [dockerfile, cloudDockerfile]) {
      expect(image).toContain("FROM oven/bun:1.4.3-slim");
      expect(image).not.toMatch(/FROM oven\/bun:1\.[0-3](\.|-)/);
      expect(image).toContain("bun install --frozen-lockfile --production");
    }
  });

  test("the container runner accepts Cloud Pass 2 and detached starts", () => {
    expect(runner).toContain('"pass2"');
    expect(runner).toContain("detach");
    expect(runner).toContain("202");
  });
});

describe("admin control plane is authorised server-side", () => {
  test("every route verifies Access and applies the admin allowlist", () => {
    expect(admin).toContain("verifyAccess(c.req.raw, c.env)");
    expect(admin).toContain("INDEXING_ADMIN_EMAILS");
    expect(admin).toContain('indexingAdmin.use("*"');
    expect(admin).toContain("Cross-origin requests are not allowed");
  });

  test("a full run requires recorded approval, not a browser confirmation", () => {
    expect(admin).toContain("approvedFullRun");
    expect(admin).toContain('action === "approve"');
    expect(admin).toContain("approval_required");
  });

  test("activation refuses benchmarks and unfinished versions, and re-checks R2", () => {
    expect(admin).toContain('state.mode !== "full"');
    expect(admin).toContain('state.stage !== "complete"');
    expect(admin).toContain("verifyVersionInR2");
    expect(admin).toContain("validationPassed");
    expect(admin).toContain("manifests/active.json");
  });

  test("no admin route returns a credential", () => {
    expect(admin).not.toContain("R2_SECRET_ACCESS_KEY");
    expect(admin).not.toContain("R2_ACCESS_KEY_ID");
    expect(admin).not.toContain("cloudflarestorage.com");
  });
});
