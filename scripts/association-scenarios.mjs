#!/usr/bin/env node
/**
 * CompanyIntel — synthetic association scenario runner (READ-ONLY, offline).
 *
 *   bun run index:assoc-scenarios            # human report, exit 1 on any failure
 *   bun run index:assoc-scenarios -- --json  # machine-readable report
 *   bun run index:assoc-scenarios -- --keep  # keep the generated index for inspection
 *
 * Builds the synthetic corpus described in `scripts/lib/association-scenarios.mjs`
 * in a temporary directory, runs the real indexer, and checks every expected
 * attachment and the reconciliation invariants. It reads no source data, uses no
 * credentials, and makes no network request.
 *
 * The corpus is deliberately adversarial and tiny. Its numbers are NOT an estimate
 * of real-data association accuracy.
 */

import { formatAssociationScenarioReport, runAssociationScenarios } from "./lib/association-scenarios.mjs";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);

const report = await runAssociationScenarios({ keep: has("keep") });
console.log(has("json") ? JSON.stringify(report, null, 2) : formatAssociationScenarioReport(report));
process.exit(report.passed ? 0 : 1);
