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
const stripComments = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
const config = stripComments(join(root, "wrangler.toml"));
const stagingConfig = stripComments(join(root, "wrangler.staging.toml"));
const deployScript = readFileSync(join(root, "scripts/deploy.mjs"), "utf8");
const adminHealth = readFileSync(join(root, "worker/src/app.ts"), "utf8");
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

  test("the runner resolves the image root (the parent directory), not its own", () => {
    // The staging bug: `resolve(import.meta.url, "..")` produced `/app/cloud`, so
    // `bun tools/cloud/cli.ts` looked under `/app/cloud/tools/...` and died instantly.
    expect(runner).toContain('dirname(fileURLToPath(import.meta.url)), ".."');
    expect(runner).toContain('join(root, "tools", "cloud", "cli.ts")');
    expect(runner).toContain("cwd: root");
    expect(runner).toContain("[cliPath, ...args]");
    expect(runner).not.toMatch(/resolve\(new URL\(import\.meta\.url\)/);
  });

  test("a detached start reports an immediate failure instead of a false success", () => {
    expect(runner).toContain("job_failed_to_start");
    expect(runner).toContain("START_SETTLE_MS");
    expect(runner).toContain("stderr");
    expect(runner).toContain("cli_missing");
    expect(runner).toContain("job_already_running");
  });

  test("the Durable Object waits for readiness and answers JSON 503s", () => {
    expect(container).toContain("container_not_ready");
    expect(container).toContain("container.running");
    expect(container).toContain("CONTAINER_READY_TIMEOUT_MS");
    expect(container).toContain("http://container/health");
    expect(container).not.toContain(".inspect()");
  });

  test("a detached job keeps the container alive while it runs", () => {
    // Without an inactivity timeout the platform may stop the instance as soon as the
    // DO that owns it goes idle after the 202. The alarm renews it only while the
    // runner reports a running job.
    expect(container).toContain("setInactivityTimeout");
    expect(container).toContain("async alarm()");
    expect(container).toContain("CONTAINER_KEEPALIVE_MS");
    expect(container).toContain("job?.running");
  });

  test("the runner forwards a stop to the child and records it in R2", () => {
    expect(runner).toContain("recordInterruption");
    expect(runner).toContain('child.kill("SIGTERM")');
    expect(runner).toContain('"interrupt"');
    expect(runner).toContain("JOB_STOP_GRACE_MS");
    // /health must expose whether a detached child is alive, or the keep-alive alarm
    // has nothing to read.
    expect(runner).toContain("running: true");
  });

  test("the job listing uses a delimited, paginated directory scan", () => {
    // The staging bug: one 200-key page of `cloud/jobs/` was filled by `segments/…`, so
    // `state.json` was never in it and the job never appeared.
    expect(admin).toContain('delimiter: "/"');
    expect(admin).toContain("delimitedPrefixes");
    expect(admin).toContain("listed.truncated");
    expect(admin).toContain("runStatus");
    expect(admin).toContain("warningFor");
  });
});

/**
 * The seven runtime settings are Worker secrets, never config values. A deploy that
 * targets a renamed or recreated script comes up without them; the guard below and
 * `/api/health` exist so that cannot be discovered only when a job fails.
 */
const RUNTIME_SETTINGS = [
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "ALLOWED_EMAILS",
  "INDEXING_ADMIN_EMAILS",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

describe("the seven runtime settings survive a deployment", () => {
  test("neither Wrangler config declares them as a var or secret", () => {
    for (const [name, text] of [
      ["wrangler.toml", config],
      ["wrangler.staging.toml", stagingConfig],
    ] as const) {
      for (const setting of RUNTIME_SETTINGS) {
        // Absent from the config entirely: a name there would be a `[vars]` entry and
        // replace the secret with a plain-text value (or fail the deploy).
        expect(`${name}:${setting}:${text.includes(setting)}`).toBe(`${name}:${setting}:false`);
      }
    }
  });

  test("the deploy wrapper checks all seven names before deploying", () => {
    for (const setting of RUNTIME_SETTINGS) expect(deployScript).toContain(`"${setting}"`);
    expect(deployScript).toContain('"secret", "list"');
    // Missing names abort the deploy and print the exact recovery commands.
    expect(deployScript).toContain("REFUSING to deploy");
    expect(deployScript).toContain("secret put");
  });

  test("both deploy scripts go through the guard, not straight to wrangler", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["deploy:staging"]).toBe("bun scripts/deploy.mjs staging");
    expect(pkg.scripts["deploy:production"]).toBe("bun scripts/deploy.mjs production");
  });

  test("every deploy keeps the dashboard-managed vars", () => {
    // The configured staging command is `wrangler deploy -c wrangler.staging.toml
    // --keep-vars`. Dropping the flag lets a deploy built from an older commit clear
    // STAGING_MODE / ACTIVE_MANIFEST_KEY / the budget, which silently removes staging
    // isolation. The wrapper must pass it, and the docs must show it.
    expect(deployScript).toContain('"deploy", "-c", configPath, "--keep-vars"');
    expect(readFileSync(join(root, "wrangler.staging.toml"), "utf8")).toContain(
      "bunx wrangler deploy -c wrangler.staging.toml --keep-vars",
    );
  });

  test("health reports presence only, by count, and never a value", () => {
    expect(adminHealth).toContain("containerCredentials");
    expect(adminHealth).toContain("indexingAdmins: Boolean(c.env.INDEXING_ADMIN_EMAILS)");
    // The R2 names are matched as a pattern so no Worker file but the bridge names them.
    expect(adminHealth).toContain("/^R2_(ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY)$/");
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
