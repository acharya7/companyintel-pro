/**
 * Pure formatter for `scripts/r2-schema.mjs`.
 *
 * The report it renders is the one the specification asks for: **original column
 * → normalized field → confidence**, with uncertain or contradictory mappings
 * flagged rather than quietly chosen.
 *
 * Two hard rules, both enforced by tests:
 *   - no cell values ever appear (the underlying schema report collects none);
 *   - nothing is invented — an unmapped column stays `unmapped` and ambiguous
 *     fields are listed under "needs a human decision".
 */

import { formatBytes } from "./raw-report.mjs";

/** One row of the mapping table, flattened for display and testing. */
export function mappingRows(report) {
  return (report.mapping ?? []).map((entry) => ({
    index: entry.index,
    column: entry.column,
    normalized: entry.normalized ?? normalizeForDisplay(entry.column),
    field: entry.proposedField ?? null,
    confidence: entry.confidence ?? null,
    ambiguous: Boolean(entry.ambiguous),
    alternatives: entry.alternatives ?? [],
    evidence: entry.evidence,
  }));
}

export function normalizeForDisplay(header) {
  return String(header ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Mappings that are not a confident, unambiguous header-alias match. */
export function uncertainRows(report) {
  return mappingRows(report).filter((row) => row.ambiguous || row.confidence !== "high");
}

/** Columns that claim the same canonical field (a decision, not a mapping). */
export function contradictoryFields(report) {
  const byField = new Map();
  for (const row of mappingRows(report)) {
    if (!row.field) continue;
    byField.set(row.field, [...(byField.get(row.field) ?? []), row.column]);
  }
  return [...byField.entries()].filter(([, columns]) => columns.length > 1);
}

function pad(value, width) {
  return String(value).length > width ? `${String(value).slice(0, width - 1)}…` : String(value).padEnd(width);
}

export function formatSchemaReport(bundle) {
  const { credentials, objects = [], suggestedSources, problems = [], notices = [] } = bundle;
  const lines = [];
  const say = (line = "") => lines.push(line);

  say("CompanyIntel R2 schema report");
  say(`checked at ${bundle.checkedAt}   read-only: bounded ranged GETs, no writes`);
  say(
    `bucket ${credentials.bucket}   prefix ${credentials.rawPrefix}   credentials: ${
      credentials.source === "file" ? `private file ${credentials.filePath}` : credentials.source
    }`,
  );
  const total = objects.reduce((sum, object) => sum + (object.objectBytes ?? 0), 0);
  say(
    `sampled ${formatBytes(bundle.sampledBytesPerFile)} from each of ${objects.length} object(s) — ` +
      `${formatBytes(total)} exists in R2 and was never downloaded`,
  );

  objects.forEach((object, position) => {
    say("");
    say(
      `${position + 1}. ${object.key}  —  ${formatBytes(object.objectBytes)} in R2, read ${formatBytes(object.sample?.bytesRead ?? 0)}` +
        `${object.sample?.truncated ? " (sample cut at the last complete record)" : " (whole object)"}`,
    );
    if (object.error) {
      say(`   MISSING/UNREADABLE: ${object.error}`);
      return;
    }
    say(
      `   encoding ${object.encoding?.label ?? object.encoding?.encoding} (${object.encoding?.confidence})   ` +
        `delimiter ${JSON.stringify(object.delimiter?.delimiter)} (${object.delimiter?.confidence})   ` +
        `header line ${object.headerLine}   rows inspected ${object.sample?.rowsInspected ?? 0}   columns ${object.headers?.length ?? 0}`,
    );
    say("");
    say(`   ${pad("original column", 34)}${pad("normalized header", 20)}${pad("canonical field", 18)}confidence  flag`);
    for (const row of mappingRows(object)) {
      const flag = row.ambiguous
        ? `AMBIGUOUS (also: ${row.alternatives.join(", ")})`
        : row.confidence === "high"
          ? ""
          : "confirm";
      say(
        `   ${pad(row.column, 34)}${pad(row.normalized, 20)}${pad(row.field ?? "—", 18)}` +
          `${pad(row.confidence ?? "none", 12)}${flag}`,
      );
    }
    const contradictions = contradictoryFields(object);
    for (const [field, columns] of contradictions) {
      say(`   ! ${columns.length} columns map to ${field}: ${columns.join(", ")} — decide by hand`);
    }
    const uncertain = uncertainRows(object);
    if (uncertain.length) {
      say("");
      say("   needs a human decision:");
      for (const row of uncertain) say(`     ${row.column}: ${row.evidence}`);
    }
    if (object.unmappedColumns?.length) say(`   unmapped columns: ${object.unmappedColumns.join(", ")}`);
    if (object.canonicalFieldsAbsent?.length) {
      say(`   canonical fields this file does not provide: ${object.canonicalFieldsAbsent.join(", ")}`);
    }
    say(`   suggested columns override: ${JSON.stringify(recommendedOverrideOf(object))}`);
  });

  say("");
  if (suggestedSources) {
    say("Suggested sources block for tools/indexer/indexer.config.json (MODE B — reads straight from R2):");
    say(JSON.stringify({ sources: suggestedSources }, null, 2));
  } else {
    say("Two readable CSV objects are required for a suggested config; name them with --keys.");
  }

  for (const notice of notices) say(`note: ${notice}`);
  if (problems.length) {
    say("");
    say(`${problems.length} problem(s):`);
    for (const problem of problems) say(`  ! ${problem}`);
  }
  return lines.join("\n");
}

function recommendedOverrideOf(report) {
  const override = {};
  for (const row of mappingRows(report)) {
    if (!row.field || row.ambiguous) continue;
    if (override[row.field]) continue;
    override[row.field] = row.column;
  }
  return override;
}

/** Export for the script, mirroring `recommendedColumnOverride` in shared code. */
export { recommendedOverrideOf };
