/**
 * Rendering for the read-only R2 probe report (`scripts/verify-r2-remote.mjs`).
 *
 * Pure formatting: no network, no credentials, no bucket. That is deliberate —
 * the renderer can be unit tested from a canned probe response, and the probe
 * response itself is already guaranteed by the shared schema report to contain
 * no cell values, names, emails or phone numbers.
 *
 * `exitCodeFor` is the single place that decides what "verified" means:
 *   0  every expected object is present and readable
 *   1  a problem was reported (missing object, unreadable body, failed validation)
 *   2  the probe could not be started or did not answer
 */

import { formatBytes } from "../../src/shared/r2/objects.ts";

/** Exit code for a completed probe run. */
export function exitCodeFor(payload) {
  const verification = payload?.verification ?? null;
  if (!verification) return 1;
  if (verification.access !== "ok") return 1;
  if ((verification.problems ?? []).length > 0) return 1;
  return 0;
}

function percent(value) {
  return `${(value * 100).toFixed(0)}%`;
}

/** Human-readable report. Never contains raw cell values. */
export function renderProbeReport(payload) {
  const lines = [];
  const verification = payload?.verification ?? null;
  const schemas = payload?.schemas ?? [];

  lines.push(`CompanyIntel R2 probe — ${payload?.service ?? "companyintel-r2-probe"}`);
  lines.push(`checked at ${payload?.generatedAt ?? "unknown"}   read-only: no writes, no uploads, no deletes`);
  lines.push("");

  if (!verification) {
    lines.push("The probe returned no verification block.");
    return lines.join("\n");
  }

  const listing = verification.listing;
  lines.push(`Bucket ${verification.bucket} — ${verification.access === "ok" ? "READABLE with the native COMPANY_DATA binding (no S3 keys used)" : "NOT READABLE"}`);
  lines.push(
    `Objects under ${listing.prefix}: ${listing.objectsRead} read over ${listing.pagesRead} page(s), showing up to ${listing.pageLimit}` +
      `${listing.truncated ? "  (listing truncated — more objects exist)" : ""}`,
  );
  for (const object of listing.listed) {
    lines.push(`  ${formatBytes(object.size).padStart(10)}  ${object.key}${object.lastModified ? `   ${object.lastModified}` : ""}`);
  }
  if (!listing.listed.length) lines.push("  (none)");
  if (listing.otherObjects?.length) lines.push(`  non-CSV objects under ${listing.prefix}: ${listing.otherObjects.join(", ")}`);

  lines.push("");
  lines.push(`Source selection: ${verification.selection?.mode ?? "none"}${verification.selection?.ambiguous ? " (AMBIGUOUS — pass --keys)" : ""}`);
  if (verification.selection?.csvCandidates?.length) {
    lines.push(`  .csv candidates: ${verification.selection.csvCandidates.join(", ")}`);
  }

  lines.push("");
  lines.push("Source objects");
  for (const source of verification.sources ?? []) {
    if (!source.present) {
      lines.push(`  MISSING   ${source.key}  — not present in the bounded listing`);
      continue;
    }
    lines.push(
      `  ${source.error ? "FAILED   " : "ok       "} ${source.key}  ${formatBytes(source.sizeBytes)}  ` +
        `etag=${source.etag ?? "n/a"}  last-modified=${source.lastModified ?? "n/a"}  read ${formatBytes(source.readBytes)} of the body`,
    );
    if (source.error) lines.push(`              ${source.error}`);
  }
  if (!(verification.sources ?? []).length) lines.push("  no source object could be identified");

  lines.push("");
  lines.push("Published dataset");
  const dataset = verification.dataset;
  if (!dataset?.activeVersion) {
    lines.push(`  none — ${dataset?.note ?? "no dataset version is published yet"}`);
  } else {
    lines.push(`  active version    ${dataset.activeVersion}${dataset.publishedAt ? `   published ${dataset.publishedAt}` : ""}`);
    if (dataset.previousVersion) lines.push(`  previous version  ${dataset.previousVersion} (rollback target)`);
    lines.push(`  companies         ${dataset.counters?.uniqueCompanies ?? "unknown"}`);
    lines.push(`  contacts          ${dataset.counters?.uniqueContacts ?? "unknown"}`);
    lines.push(`  rows rejected     ${dataset.counters?.rowsRejected ?? "unknown"}`);
    lines.push(`  validation        ${dataset.validationPassed ? "passed" : "FAILED or missing"}`);
    lines.push(`  index size        ${formatBytes(dataset.indexBytes)}`);
  }

  for (const entry of schemas) {
    lines.push("");
    lines.push(`Schema — ${entry.key}`);
    const report = entry.report;
    lines.push(`  object size       ${formatBytes(report.objectBytes)}   inspected ${formatBytes(report.sample?.bytesRead)} (${report.sample?.rowsInspected} data rows)`);
    lines.push(`  encoding          ${report.encoding?.label} (${report.encoding?.encoding}, confidence ${report.encoding?.confidence})`);
    lines.push(`  delimiter         ${JSON.stringify(report.delimiter?.delimiter)} (confidence ${report.delimiter?.confidence})`);
    lines.push(`  header line       ${report.headerLine}   columns ${report.headers?.length ?? 0}`);
    lines.push("  columns (no cell values are included):");
    for (const column of report.columns ?? []) {
      lines.push(
        `    ${String(column.index).padStart(3)}  ${String(column.header).slice(0, 34).padEnd(34)} ${String(column.looksLike).padEnd(6)} ` +
          `fill=${percent(column.fillRate)} distinct~${column.approximateUnique} maxlen=${column.maxLength}`,
      );
    }
    lines.push("  mapping suggestions:");
    for (const suggestion of report.mapping ?? []) {
      const field = suggestion.proposedField ? `${suggestion.proposedField} (${suggestion.confidence})` : "— unmapped";
      lines.push(`    ${String(suggestion.column).slice(0, 34).padEnd(34)} → ${field}${suggestion.ambiguous ? "  [AMBIGUOUS]" : ""}`);
      lines.push(`        ${suggestion.evidence}${suggestion.alternatives?.length ? ` (could also be: ${suggestion.alternatives.join(", ")})` : ""}`);
    }
    if (report.unmappedColumns?.length) lines.push(`  unmapped columns: ${report.unmappedColumns.join(", ")}`);
    if (report.canonicalFieldsAbsent?.length) lines.push(`  canonical fields absent from this file: ${report.canonicalFieldsAbsent.join(", ")}`);
    const override = entry.columnsOverride ?? {};
    lines.push(`  suggested indexer columns override: ${Object.keys(override).length ? JSON.stringify(override) : "{} (nothing confident enough to suggest)"}`);
    if (report.problems?.length) for (const problem of report.problems) lines.push(`  ! ${problem}`);
  }

  const notices = verification.notices ?? [];
  const problems = verification.problems ?? [];
  lines.push("");
  for (const notice of notices) lines.push(`  note: ${notice}`);
  if (notices.length) lines.push("");
  if (problems.length) {
    lines.push(`${problems.length} problem(s) — reported as problems, never assumed away:`);
    for (const problem of problems) lines.push(`  ! ${problem}`);
  } else {
    lines.push("VERIFIED: every expected object is present and readable, and the published dataset is intact.");
  }
  lines.push("");
  lines.push("No contact records, email addresses, phone numbers or cell values are included in this report.");
  return lines.join("\n");
}
