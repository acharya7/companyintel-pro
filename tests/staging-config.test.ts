/**
 * Configuration guards for the staging deployment.
 *
 * The isolation rules are enforced in code (`tests/staging-isolation.test.ts`), but they
 * only apply if the deployment actually carries the variables that turn them on. These
 * checks read the real Wrangler configs, so a later edit cannot quietly produce a staging
 * Worker that shares production's pointer, or a config with a secret pasted into it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** Config lines only: the comments explain the rules and must not satisfy them. */
function configLines(path: string): string {
  return readFileSync(join(root, path), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const staging = configLines("wrangler.staging.toml");
const production = configLines("wrangler.toml");
const envTypes = readFileSync(join(root, "worker/src/env.d.ts"), "utf8");
const container = readFileSync(join(root, "worker/src/indexer-container.ts"), "utf8");

describe("staging Worker configuration", () => {
  test("is a separate Worker with its own container migration", () => {
    expect(staging).toMatch(/name\s*=\s*"companyintel-staging"/);
    expect(staging).toMatch(/main\s*=\s*"worker\/src\/index\.ts"/);
    expect(staging).toMatch(/class_name\s*=\s*"IndexerContainer"/);
    expect(staging).toMatch(/max_instances\s*=\s*1/);
    expect(staging).toMatch(/instance_type\s*=\s*"standard-1"/);
    // A distinct migration tag per Worker script, so the histories cannot mix.
    const stagingTag = /tag\s*=\s*"([^"]+)"/.exec(staging)?.[1];
    const productionTag = /tag\s*=\s*"([^"]+)"/.exec(production)?.[1];
    expect(stagingTag).toBeTruthy();
    expect(productionTag).toBeTruthy();
    expect(stagingTag).not.toBe(productionTag);
    expect(staging).toMatch(/new_sqlite_classes\s*=\s*\["IndexerContainer"\]/);
  });

  test("turns on the isolation switches the code reads", () => {
    expect(staging).toMatch(/STAGING_MODE\s*=\s*"true"/);
    expect(staging).toMatch(/ACTIVE_MANIFEST_KEY\s*=\s*"staging\/active\.json"/);
    expect(staging).toMatch(/CLOUD_JOB_BUDGET_USD\s*=\s*"\d+"/);
    // Production keeps the production pointer: the variable must be absent there.
    expect(production).not.toContain("ACTIVE_MANIFEST_KEY");
    expect(production).not.toContain("STAGING_MODE");
    expect(envTypes).toMatch(/ACTIVE_MANIFEST_KEY\?: string/);
    expect(envTypes).toMatch(/STAGING_MODE\?: string/);
  });

  test("keeps the bucket private and adds no public surface", () => {
    for (const config of [staging, production]) {
      expect(config).not.toContain("r2.dev");
      expect(config).not.toMatch(/public_bucket/);
      expect(config).not.toMatch(/custom_domain/);
      expect(config).not.toMatch(/\[\[routes\]\]/);
      expect(config).toMatch(/binding\s*=\s*"COMPANY_DATA"/);
      expect(config).toMatch(/bucket_name\s*=\s*"company-intel-data"/);
    }
  });

  test("carries no secret value, only variable names", () => {
    const secretNames = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "ALLOWED_EMAILS", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID"];
    for (const name of secretNames) {
      expect(staging).not.toContain(name);
      expect(production).not.toContain(name);
    }
    // The one budget variable is a number, and the container forwards it by name.
    expect(container).toContain("CLOUD_JOB_BUDGET_USD");
    expect(container).not.toMatch(/CLOUD_JOB_BUDGET_USD\s*=\s*"sk/i);
  });
});

describe("the combined job budget is wired through every layer", () => {
  test("one variable name, no per-stage allowance left behind", () => {
    expect(production).toContain('CLOUD_JOB_BUDGET_USD = "30"');
    expect(production).not.toMatch(/^\s*CLOUD_BUDGET_USD\s*=/m);
    expect(staging).not.toMatch(/^\s*CLOUD_BUDGET_USD\s*=/m);
    expect(envTypes).toMatch(/CLOUD_JOB_BUDGET_USD\?: string/);
  });

  test("the deprecated alias is still read, so an existing deployment keeps its guard", () => {
    const pass1 = readFileSync(join(root, "tools/cloud/pass1.ts"), "utf8");
    expect(pass1).toContain("process.env.CLOUD_JOB_BUDGET_USD ?? process.env.CLOUD_BUDGET_USD");
  });

  test("both stages check the same budget", () => {
    const pass1 = readFileSync(join(root, "tools/cloud/pass1.ts"), "utf8");
    const pass2 = readFileSync(join(root, "tools/cloud/pass2.ts"), "utf8");
    expect(pass1).toContain("cloudJobBudgetUsd()");
    expect(pass2).toContain("cloudJobBudgetUsd()");
    // Both compare R2 requests AND container time against it.
    expect(pass1).toContain("state.accounting.estimatedUsd + state.accounting.containerUsd");
    expect(pass2).toContain("current.accounting.estimatedUsd + current.accounting.containerUsd");
  });
});
