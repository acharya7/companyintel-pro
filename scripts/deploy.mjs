#!/usr/bin/env node
/**
 * CompanyIntel deploy wrapper: verify runtime settings, then deploy.
 *
 *   bun scripts/deploy.mjs staging            # wrangler deploy -c wrangler.staging.toml --keep-vars
 *   bun scripts/deploy.mjs production         # wrangler deploy -c wrangler.toml --keep-vars
 *   bun scripts/deploy.mjs staging --check    # settings only, no deploy
 *
 * Why this exists
 *   The seven runtime settings are Worker *secrets*, not `[vars]`: four for
 *   Cloudflare Access and three R2 credentials for the container. They are
 *   deliberately absent from both Wrangler configs (asserted by
 *   `tests/staging-config.test.ts` and `tests/worker-r2-binding.test.ts`), so
 *   `wrangler deploy` cannot recreate them. A deployment that targets a renamed
 *   script — or a Worker that was deleted and recreated — silently comes up
 *   without them, which is how a previous staging deploy lost them.
 *
 *   This wrapper lists the deployed secret NAMES (never values) before deploying
 *   and aborts if any of the seven is missing, printing the exact `secret put`
 *   commands needed. `/api/health` reports the same presence as booleans, so the
 *   live deployment can be checked after the fact with one request.
 *
 * It never prints, reads or writes a secret value.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const bunBin = process.versions.bun ? process.execPath : "bun";

/** Four Access settings + three container-only R2 secrets. */
const REQUIRED_SECRETS = [
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "ALLOWED_EMAILS",
  "INDEXING_ADMIN_EMAILS",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

const TARGETS = {
  staging: "wrangler.staging.toml",
  production: "wrangler.toml",
};

const [, , target, ...flags] = process.argv;
const checkOnly = flags.includes("--check") || flags.includes("--check-only");

if (!target || !(target in TARGETS)) {
  console.error("Usage: bun scripts/deploy.mjs <staging|production> [--check]");
  process.exit(1);
}

const configPath = TARGETS[target];
const config = readFileSync(resolve(root, configPath), "utf8");
const nameMatch = /^name\s*=\s*"([^"]+)"/m.exec(config);
const workerName = nameMatch?.[1] ?? "(unknown)";

console.log(`[deploy] target ${target} · Worker ${workerName} · config ${configPath}`);

/** Names only: `wrangler secret list --format json` returns `{ name, type }`. */
function listSecretNames() {
  const result = spawnSync(bunBin, ["x", "wrangler", "secret", "list", "-c", configPath, "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) {
    const message = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-4).join(" ");
    return { ok: false, reason: message || `wrangler exited ${result.status}` };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]");
    const names = Array.isArray(parsed)
      ? parsed.map((entry) => (typeof entry === "string" ? entry : entry?.name)).filter((entry) => typeof entry === "string")
      : [];
    return { ok: true, names };
  } catch (error) {
    return { ok: false, reason: `could not parse wrangler output: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const listing = listSecretNames();

if (!listing.ok) {
  // Fail open ONLY when the names cannot be read at all (no authenticated
  // wrangler, or a build token without Workers Scripts: Read). Aborting here would
  // block the deploy that is meant to fix things, so this is a loud warning plus
  // the exact post-deploy check. Missing names that CAN be read are fatal below.
  console.warn(`[deploy] WARNING: could not verify Worker secrets: ${listing.reason}`);
  console.warn("[deploy] After deploying, check https://<host>/api/health → settings.containerCredentials must be 3.");
} else {
  const present = new Set(listing.names);
  const missing = REQUIRED_SECRETS.filter((name) => !present.has(name));
  if (missing.length) {
    console.error(`[deploy] REFUSING to deploy ${workerName}: ${missing.length} runtime setting(s) missing: ${missing.join(", ")}`);
    console.error("[deploy] Re-add them (values are typed at the hidden prompt, never in a file):");
    for (const name of missing) console.error(`  bunx wrangler secret put ${name} -c ${configPath}`);
    console.error("[deploy] Nothing was deployed.");
    process.exit(1);
  }
  console.log(`[deploy] all ${REQUIRED_SECRETS.length} runtime settings present on ${workerName}`);
}

if (checkOnly) {
  console.log("[deploy] --check requested: settings verified, nothing deployed.");
  process.exit(0);
}

// `--keep-vars` keeps the dashboard-managed `[vars]` on the deployed Worker. Without
// it, a deploy built from a commit that lags the dashboard can clear them, and the
// deployed Worker comes up missing STAGING_MODE / ACTIVE_MANIFEST_KEY / the budget —
// silently losing staging isolation. It is part of the configured deploy command.
const deploy = spawnSync(bunBin, ["x", "wrangler", "deploy", "-c", configPath, "--keep-vars"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
if (deploy.error) {
  console.error(`[deploy] could not run wrangler: ${deploy.error.message}`);
  process.exit(1);
}
process.exit(deploy.status ?? 1);
