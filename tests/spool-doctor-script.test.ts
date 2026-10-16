/**
 * Behavioural tests for `scripts/spool-doctor.mjs`.
 *
 * The doctor exists because a real benchmark failure left a multi-gigabyte spool
 * and no way to tell what was in it. It is therefore tested as a real child
 * process (the way an operator runs it), on a real spool produced by the real
 * indexer, with the three properties that matter:
 *
 *   1. it is READ-ONLY — file names, bytes and mtimes are unchanged, and nothing
 *      is created, except when `--repair-manifest` is asked for explicitly;
 *   2. it never prints record content (no company names, no emails), so its output
 *      can be pasted into a report;
 *   3. it reports the exact POSITION of damage (partition, line, byte offset) and
 *      exits non-zero, instead of summarising "something went wrong".
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runIndex, type IndexerConfig } from "../tools/indexer/src/build";
import { spoolManifestPathFor } from "../tools/indexer/src/spool";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "spool-doctor.mjs");

/** A company name and an email that must never appear in the doctor's output. */
const SECRET_COMPANY = "Zetaquorum Holdings";
const SECRET_EMAIL = "secret.person@zetaquorum.example";

const HEADERS = ["Company Name", "Company Domain", "Industry", "Country", "City", "Full Name", "Job Title", "Email", "LinkedIn URL"];

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(path, `${statSync(path).size}:${statSync(path).mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

function doctor(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [script, ...args], { cwd: root, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Build a real spool with the real indexer, then remove its manifest. */
async function buildSpool(dir: string): Promise<IndexerConfig> {
  const source = join(dir, "source.csv");
  writeFileSync(
    source,
    [
      HEADERS.join(","),
      `"${SECRET_COMPANY}","zetaquorum.example","Software","United States","Austin","Ada Lovelace","CTO","${SECRET_EMAIL}",""`,
      `"Acme, Inc.","acme.example","Manufacturing","United States","Detroit","John O'Neil","Plant Manager","john@acme.example",""`,
    ].join("\n") + "\n",
    "utf8",
  );
  const config: IndexerConfig = {
    datasetVersion: "doctor-v1",
    sources: [{ id: "csv1", path: source }],
    workDir: join(dir, "work"),
    outputDir: join(dir, "out"),
    partitions: 4,
    shards: { exact: 4, prefix: 4, token: 4, trigram: 4, ids: 4 },
  };
  await runIndex(config, {});
  rmSync(spoolManifestPathFor(config.workDir), { force: true });
  return config;
}

describe("scripts/spool-doctor.mjs", () => {
  test("reports a complete spool as clean, read-only, and never prints a record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-doctor-clean-"));
    try {
      const config = await buildSpool(dir);
      // Give the spool a manifest again so the state is "complete".
      const repair = doctor(["--work-dir", config.workDir, "--repair-manifest"]);
      expect(repair.status).toBe(0);

      const before = snapshot(config.workDir);
      const clean = doctor(["--work-dir", config.workDir]);
      expect(clean.status).toBe(0);
      expect(clean.stdout).toContain("CLEAN");
      expect(clean.stdout).toContain("Pass 1 can be reused");
      expect(clean.stdout).not.toContain(SECRET_COMPANY);
      expect(clean.stdout).not.toContain(SECRET_EMAIL);
      expect(clean.stdout).not.toContain("@");
      expect(clean.stdout).toContain("No record content was printed");

      // Read-only: byte sizes and mtimes are identical, and nothing was added.
      expect(snapshot(config.workDir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports damage with its exact position and exits 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-doctor-damaged-"));
    try {
      const config = await buildSpool(dir);
      const files = readdirSync(join(config.workDir, "spool")).filter((name) => name.endsWith(".jsonl"));
      const target = join(config.workDir, "spool", files[0]);
      const original = readFileSync(target, "utf8");
      writeFileSync(target, `${original}{ "keys": ["n:zetaquorum"`, "utf8");

      const before = snapshot(config.workDir);
      const result = doctor(["--work-dir", config.workDir]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("DAMAGED");
      expect(result.stdout).toContain(files[0]);
      expect(result.stdout).toContain(`byte offset ${original.length}`);
      expect(result.stdout).toContain("truncated");
      expect(result.stdout).not.toContain(SECRET_COMPANY);
      expect(snapshot(config.workDir)).toEqual(before);

      // …and the manifest is not written over a damaged spool, even when asked.
      const refused = doctor(["--work-dir", config.workDir, "--repair-manifest"]);
      expect(refused.status).toBe(1);
      expect(refused.stdout).not.toContain("Recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--json emits the same findings in one parseable object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-doctor-json-"));
    try {
      const config = await buildSpool(dir);
      const result = doctor(["--work-dir", config.workDir, "--json"]);
      expect(result.status).toBe(1); // no manifest yet
      const report = JSON.parse(result.stdout);
      expect(report.verdict).toBe("incomplete");
      expect(report.checkpoint.stage).toBe("pass2-merge");
      expect(report.totals.records).toBe(2);
      expect(result.stdout).not.toContain(SECRET_COMPANY);
      expect(result.stdout).not.toContain(SECRET_EMAIL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits 2 with no spool at all, and never invents one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-doctor-missing-"));
    try {
      const result = doctor(["--work-dir", join(dir, "nothing-here")]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Nothing to inspect");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
