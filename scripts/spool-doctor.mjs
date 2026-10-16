#!/usr/bin/env node
/**
 * CompanyIntel — spool doctor (READ-ONLY).
 *
 *   bun run index:spool-doctor                     # inspect .indexer-work
 *   bun run index:spool-doctor --config tools/indexer/indexer.config.json
 *   bun run index:spool-doctor --work-dir D:/companyintel/.indexer-work
 *   bun run index:spool-doctor --json              # one machine-readable report
 *   bun run index:spool-doctor --repair-manifest   # explicit, see below
 *
 * WHY IT EXISTS
 * -------------
 * The 1,000,000-record benchmark died in pass 2 with `JSON Parse error:
 * Unterminated string`. Finding out what the spool actually contained meant
 * reading multi-gigabyte `part-*.jsonl` files by hand. This command answers the
 * questions an operator actually has:
 *
 *   1. which partitions exist, how big they are, how many records each holds;
 *   2. is any partition truncated, malformed, or shorter than pass 1 recorded;
 *   3. which partition, which line, which byte offset — the exact position;
 *   4. does the checkpoint describe this same run, and did pass 1 record it;
 *   5. are the Pass 1 results reusable, or must they be rebuilt.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 *   - it never prints record content: no company names, no emails, no phone
 *     numbers, no credentials — only file names, counts, sizes and offsets, so
 *     the report can be pasted into a chat or an issue;
 *   - it does not open a network connection at all (no R2, no Cloudflare);
 *   - it modifies nothing. `--repair-manifest` is the single exception, it must be
 *     typed explicitly, and it only ever writes `spool-manifest.json`, and only
 *     when EVERY partition verifies as complete.
 *
 * Exit codes: 0 = spool complete and consistent; 1 = damaged or incomplete;
 *             2 = no spool found at all.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { adoptSpool, inspectSpool, spoolManifestPathFor } from "../tools/indexer/src/spool.ts";

const argv = process.argv.slice(2);

function flag(name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : true;
}

const has = (name) => argv.includes(`--${name}`);

function formatBytes(bytes) {
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** Work directory: explicit flag, then the config, then the default. */
async function resolveWorkDir() {
  const explicit = flag("work-dir");
  if (typeof explicit === "string") return resolve(explicit);
  const configPath = flag("config");
  if (typeof configPath === "string") {
    const config = JSON.parse(await readFile(resolve(configPath), "utf8"));
    if (config?.workDir) return resolve(config.workDir);
  }
  return resolve(".indexer-work");
}

function printReport(inspection) {
  console.log("");
  console.log(`CompanyIntel spool doctor — ${inspection.workDir}`);
  console.log("");
  console.log(`  verdict            ${inspection.verdict.toUpperCase()}`);
  console.log(`  partition files    ${inspection.totals.files}`);
  console.log(`  spool size         ${formatBytes(inspection.totals.bytes)}`);
  console.log(`  records            ${inspection.totals.records.toLocaleString()} (${inspection.totals.parsed.toLocaleString()} parsed as JSON)`);
  const checkpoint = inspection.checkpoint;
  console.log(
    `  checkpoint         ${checkpoint.present ? `stage=${checkpoint.stage}${checkpoint.hasIdentity ? "" : " (NO run identity)"}` : "absent"}`,
  );
  if (checkpoint.identity) {
    console.log(`    version          ${checkpoint.identity.version}`);
    console.log(`    sample limit     ${checkpoint.identity.sampleLimit ?? "none (full run)"}`);
    console.log(`    partitions       ${checkpoint.identity.partitions}`);
    console.log(`    sources          ${checkpoint.identity.sources.map((source) => `${source.id}=${source.path}`).join(", ")}`);
  }
  const manifest = inspection.manifest;
  console.log(
    `  spool manifest     ${manifest ? `${manifest.complete ? "complete" : "INCOMPLETE"}, ${manifest.files} file(s)${manifest.matches ? ", matches the files on disk" : `, ${manifest.mismatches.length} mismatch(es)`}` : "absent"}`,
  );
  console.log("");
  console.log("  per partition (positions only — no record content):");
  for (const entry of inspection.partitions) {
    const problem = entry.problems[0];
    const state = problem
      ? `${problem.kind} at line ${problem.line}, byte offset ${problem.byteOffset.toLocaleString()}${problem.reason ? ` (${problem.reason})` : ""}`
      : entry.terminated
        ? "ok"
        : "TRUNCATED: last record is not terminated";
    console.log(
      `    ${entry.file}  partition=${entry.partition ?? "?"}  records=${entry.records}  bytes=${entry.bytes}  sha256=${entry.sha256?.slice(0, 16) ?? "-"}  ${state}`,
    );
  }
  if (inspection.findings.length) {
    console.log("");
    console.log("  findings");
    for (const finding of inspection.findings) console.log(`    - ${finding}`);
  } else {
    console.log("");
    console.log("  findings           none");
  }
  console.log("");
}

function printGuidance(inspection, { repaired }) {
  if (inspection.verdict === "clean") {
    console.log("This spool is complete and consistent: Pass 1 can be reused. Re-run the same indexer command");
    console.log("(without --no-resume) and pass 2 will merge it without reading the sources again.");
    return;
  }
  if (inspection.verdict === "empty") {
    console.log("No spool partitions were found, so there is nothing to reuse. Re-run the indexer; pass 1 will");
    console.log("stream the sources again.");
    return;
  }
  if (inspection.verdict === "incomplete") {
    if (repaired) return;
    const adoptable = Boolean(inspection.checkpoint.identity);
    console.log("The partitions look intact but pass 1 never recorded them (no spool-manifest.json), so the");
    console.log("indexer will refuse to merge them.");
    console.log("");
    if (adoptable && inspection.partitions.every((entry) => entry.problems.length === 0 && entry.terminated)) {
      console.log("The checkpoint names the run these partitions belong to and every partition above reads `ok`,");
      console.log("so Pass 1 can be reused — this records ONLY spool-manifest.json, after re-verifying everything:");
      console.log("");
      console.log("    bun run index:spool-doctor --repair-manifest");
      console.log("");
      console.log("If you would rather not adopt it: re-run the indexer with --no-resume.");
    } else {
      // No checkpoint (or no run identity in it): there is nothing that says which
      // run these partitions belong to, so they cannot be adopted and do not need
      // to be. A normal re-run treats an unclaimed spool as stale and clears it.
      console.log(
        adoptable
          ? "At least one partition above is damaged, so it cannot be adopted."
          : "There is no checkpoint next to it naming the run it belongs to, so it cannot be adopted.",
      );
      console.log("Nothing needs to be done by hand: simply re-run the indexer. An unclaimed spool is treated as");
      console.log("stale, cleared before pass 1, and rebuilt from the sources.");
    }
    return;
  }
  console.log("At least one partition is damaged or does not match what pass 1 recorded. Its rows cannot be");
  console.log("recovered from the spool, and merging the rest would silently drop them, so:");
  console.log("");
  console.log("    bun tools/indexer/src/cli.ts run --config <cfg> ... --no-resume");
  console.log("");
  console.log("--no-resume discards the spool and rebuilds it from the sources. Pass-2 output already written is");
  console.log("left alone (versions are separate directories) and nothing was uploaded.");
}

if (has("help")) {
  console.log("CompanyIntel spool doctor (read-only)\n");
  console.log("  --work-dir <path>     inspect this directory (default .indexer-work, or the config's workDir)");
  console.log("  --config <path>       read workDir from this indexer configuration");
  console.log("  --json                one machine-readable report");
  console.log("  --hashes              also re-verify every partition checksum (re-reads each file)");
  console.log("  --repair-manifest     write spool-manifest.json for an intact spool (nothing else is touched)\n");
  console.log("Exit codes: 0 clean, 1 damaged or incomplete, 2 no spool found. No record content is ever printed.");
  process.exit(0);
}

const workDir = await resolveWorkDir();
if (!existsSync(workDir)) {
  console.error(`No work directory at ${workDir}. Nothing to inspect (exit 2).`);
  process.exit(2);
}

const inspection = await inspectSpool(workDir, { checkHashes: has("hashes") });

if (has("json")) {
  console.log(JSON.stringify(inspection, null, 2));
  process.exitCode = inspection.verdict === "clean" ? 0 : inspection.verdict === "empty" ? 2 : 1;
} else {
  printReport(inspection);

  let repaired = false;
  if (has("repair-manifest")) {
    if (inspection.verdict === "clean") {
      console.log(`Nothing to repair: ${spoolManifestPathFor(workDir)} already exists and matches.`);
    } else {
      const identity = inspection.checkpoint.identity;
      if (!identity) {
        console.error("Refusing to repair: the checkpoint carries no run identity, so the spool has no provenance.");
        console.error("Re-run the indexer with --no-resume to rebuild it.");
        process.exit(1);
      }
      const manifest = await adoptSpool(workDir, identity, inspection);
      repaired = true;
      console.log(`Recorded ${spoolManifestPathFor(workDir)}: ${manifest.totals.files} partition(s), ${manifest.totals.lines.toLocaleString()} rows, ${formatBytes(manifest.totals.bytes)}.`);
      console.log("Nothing else was modified.");
    }
  }

  printGuidance(inspection, { repaired });
  console.log("");
  console.log(`No record content was printed and no file was modified${repaired ? " except the spool manifest" : ""}.`);
  process.exitCode = inspection.verdict === "clean" ? 0 : inspection.verdict === "empty" ? 2 : repaired ? 0 : 1;
}
