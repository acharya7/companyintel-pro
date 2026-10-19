#!/usr/bin/env bun
/**
 * Write a non-destructive archive of the CURRENT source tree.
 *
 * Why this exists: this workspace is the authoritative copy of the cloud indexing
 * implementation, and the environment blocks `git`, so the changes cannot be
 * pushed from here. This produces one file that can be uploaded to the GitHub
 * repository (or handed to any other build environment) without a git client on
 * this side.
 *
 * It NEVER touches the working tree: it only reads. Excluded, deliberately:
 *   node_modules, dist, .git, .wrangler        — build/VCS state, reproducible
 *   .indexer-*, .raw-samples, index-reports/   — spool/output/sample data
 *   .r2-credentials*.json, .env                — SECRETS and private data
 *   local model/AI config and any *.tgz        — never source
 *
 * Usage:
 *   bun scripts/source-archive.mjs                       # index-reports/companyintel-source-<date>.tar.gz
 *   bun scripts/source-archive.mjs --out /tmp/src.tgz
 *   bun scripts/source-archive.mjs --list                # print the file list only, write nothing
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");
const outIndex = argv.indexOf("--out");
const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

const stamp = new Date().toISOString().slice(0, 10);
const out = resolve(root, outIndex !== -1 ? String(argv[outIndex + 1]) : `index-reports/companyintel-source-${stamp}.tar.gz`);

/** Anything matching one of these is never archived (secrets and derived data). */
const EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  ".wrangler",
  ".indexer*",
  ".raw-samples",
  "index-reports",
  ".r2-credentials*",
  ".env",
  ".env.local",
  "*.tgz",
  "*.tar.gz",
  "*.log",
];

const args = ["-czf", out, ...EXCLUDES.flatMap((pattern) => ["--exclude", pattern]), "."];

if (listOnly) {
  // List what would go in, without writing anything: `tar -czf` to a discarded
  // stream is not portable, so this uses the same exclusions with `find` instead.
  const findPattern = EXCLUDES.filter((pattern) => !pattern.includes("*"))
    .flatMap((name) => ["-not", "-path", `./${name}/*`]);
  const files = spawnSync("find", [".", "-type", "f", ...findPattern], { cwd: root, encoding: "utf8" });
  const list = (files.stdout ?? "")
    .split("\n")
    .filter((file) => file && !/\.log$|\.tgz$/.test(file) && !file.includes(".indexer") && !file.includes("index-reports") && !file.includes(".raw-samples") && !/\.r2-credentials/.test(file))
    .sort();
  for (const file of list) console.log(file);
  console.log(`\n${list.length.toLocaleString()} file(s) would be archived. Nothing was written.`);
  process.exit(0);
}

mkdirSync(dirname(out), { recursive: true });
const result = spawnSync("tar", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stderr || "tar failed");
  process.exit(result.status ?? 1);
}

const bytes = statSync(out).size;
const sha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
const counted = spawnSync("tar", ["-tzf", out], { encoding: "utf8" });
const entries = (counted.stdout ?? "").split("\n").filter(Boolean).length;

console.log(`\nSource archive written (the working tree was not modified):`);
console.log(`  path      ${out}`);
console.log(`  entries   ${entries.toLocaleString()}`);
console.log(`  size      ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  sha256    ${sha256}`);
console.log(`\n  Contains: tools/cloud, tools/indexer, cloud/, worker/, src/, tests/, docs/,`);
console.log(`            scripts/, package.json, bun.lock, Dockerfile, wrangler.toml, wrangler.staging.toml`);
console.log(`  Excludes: node_modules, dist, .git, secrets (.env, .r2-credentials*.json),`);
console.log(`            indexing spools/outputs, index-reports, raw samples, logs`);
console.log(`\n  Find any secret that slipped in with:`);
console.log(`    tar -tzf ${out} | grep -Ei "credential|secret|\\.env$" || echo "none"`);
