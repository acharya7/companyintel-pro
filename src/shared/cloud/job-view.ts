/**
 * The normalisation boundary for `GET /api/cloud/jobs`.
 *
 * Why this exists: the endpoint returns whatever object is stored at
 * `cloud/jobs/<version>/state.json`, and not every such object is a Pass 1/Pass 2
 * `CloudJobState`. The direct real-data scan (`tools/realdata/scan.ts`) writes a
 * record with `mode: "scan"`, a `progress` block and `accounting` fields that are
 * null — it has no `totals`, no `sources`, no `rate` and no `errors`. The panel
 * dereferenced `state.totals.rowsRead` and the whole page threw
 * `TypeError: Cannot read properties of undefined (reading 'rowsRead')`.
 *
 * So every field the panel displays is extracted here, once, from an `unknown`
 * payload:
 *
 *   - a missing or malformed metric becomes `null`, which the panel renders as
 *     "—" (never 0 — a genuinely unknown number is not a measurement);
 *   - a real 0 stays 0 and is displayed as "0";
 *   - a listing entry that cannot be read at all becomes an issue string, not an
 *     exception, so one historical record can never hide the launch control.
 *
 * Nothing here invents progress, spend or completion.
 */

export type Metric = number | null;

export interface JobTotalsView {
  rowsRead: Metric;
  rowsRejected: Metric;
  rowsIndexed: Metric;
  segments: Metric;
  segmentBytes: Metric;
  sourceBytesRead: Metric;
}

export interface JobRateView {
  rowsPerSecond: Metric;
  etaSeconds: Metric;
}

export interface JobAccountingView {
  estimatedUsd: Metric;
  containerUsd: Metric;
  classA: Metric;
  classB: Metric;
  budgetUsd: Metric;
}

export interface JobCheckpointView {
  at: string | null;
}

export interface JobSourceView {
  id: string;
  complete: boolean;
  rows: Metric;
  rejected: Metric;
  chunks: Metric;
  segments: Metric;
  sourceBytes: Metric;
  size: Metric;
}

export interface JobErrorView {
  at: string;
  stage: string;
  message: string;
}

export interface JobPass2View {
  phase: string | null;
  partitionsDone: Metric;
  partitionsTotal: Metric;
  shardParts: Metric;
  indexObjects: Metric;
  indexBytes: Metric;
  finalizeDone: Metric;
  finalizeTotal: Metric;
  validationDone: Metric;
  validationTotal: Metric;
}

export interface JobInterruptionView {
  at: string | null;
  outcome: string;
  reason: string | null;
}

export interface CloudJobView {
  version: string;
  jobId: string;
  stage: string;
  mode: string;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  note: string | null;
  partitions: Metric;
  totals: JobTotalsView | null;
  rate: JobRateView | null;
  accounting: JobAccountingView | null;
  checkpoint: JobCheckpointView | null;
  sources: JobSourceView[];
  /** False when the record carries no source list at all (a scan, not an index job). */
  sourcesKnown: boolean;
  errors: JobErrorView[];
  pass2: JobPass2View | null;
  interruption: JobInterruptionView | null;
}

export interface JobControlView {
  pause: boolean;
  abort: boolean;
  approvedFullRun: boolean;
}

export interface JobRunView {
  outcome: string;
  stage: string;
  attempt: Metric;
  pid: Metric;
  heartbeatAt: string | null;
  reason: string | null;
}

export interface JobWarningView {
  kind: string;
  since: string | null;
  reason: string;
}

export interface CloudJobListingView {
  job: CloudJobView;
  control: JobControlView | null;
  run: JobRunView | null;
  warning: JobWarningView | null;
}

export interface JobsView {
  jobs: CloudJobListingView[];
  truncated: boolean;
  staging: boolean;
  /** `null` when the response did not say — the panel then stays quiet about it. */
  containerBound: boolean | null;
  /** Non-fatal problems with the payload, surfaced as a diagnostic. */
  issues: string[];
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

/** A finite number is a measurement — including 0. Anything else is unknown. */
function metric(value: unknown): Metric {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeTotals(value: unknown): JobTotalsView | null {
  const totals = asRecord(value);
  if (!totals) return null;
  return {
    rowsRead: metric(totals.rowsRead),
    rowsRejected: metric(totals.rowsRejected),
    rowsIndexed: metric(totals.rowsIndexed),
    segments: metric(totals.segments),
    segmentBytes: metric(totals.segmentBytes),
    sourceBytesRead: metric(totals.sourceBytesRead),
  };
}

function normalizeRate(value: unknown): JobRateView | null {
  const rate = asRecord(value);
  if (!rate) return null;
  return { rowsPerSecond: metric(rate.rowsPerSecond), etaSeconds: metric(rate.etaSeconds) };
}

function normalizeAccounting(value: unknown): JobAccountingView | null {
  const accounting = asRecord(value);
  if (!accounting) return null;
  return {
    estimatedUsd: metric(accounting.estimatedUsd),
    containerUsd: metric(accounting.containerUsd),
    classA: metric(accounting.classA),
    classB: metric(accounting.classB),
    budgetUsd: metric(accounting.budgetUsd),
  };
}

function normalizeSources(value: unknown): { sources: JobSourceView[]; known: boolean } {
  if (!Array.isArray(value)) return { sources: [], known: false };
  const sources: JobSourceView[] = [];
  for (const entry of value) {
    const source = asRecord(entry);
    const id = source ? text(source.id) : null;
    if (!source || !id) continue;
    sources.push({
      id,
      complete: source.complete === true,
      rows: metric(source.rows),
      rejected: metric(source.rejected),
      chunks: metric(source.chunks),
      segments: metric(source.segments),
      sourceBytes: metric(source.sourceBytes),
      size: metric(source.size),
    });
  }
  return { sources, known: true };
}

function normalizeErrors(value: unknown): JobErrorView[] {
  if (!Array.isArray(value)) return [];
  const errors: JobErrorView[] = [];
  for (const entry of value) {
    const error = asRecord(entry);
    const message = error ? text(error.message) : null;
    if (!message) continue;
    errors.push({ at: text(error!.at) ?? "", stage: text(error!.stage) ?? "unknown", message });
  }
  return errors;
}

function normalizePass2(value: unknown): JobPass2View | null {
  const pass2 = asRecord(value);
  if (!pass2) return null;
  return {
    phase: text(pass2.phase),
    partitionsDone: metric(pass2.partitionsDone),
    partitionsTotal: metric(pass2.partitionsTotal),
    shardParts: metric(pass2.shardParts),
    indexObjects: metric(pass2.indexObjects),
    indexBytes: metric(pass2.indexBytes),
    finalizeDone: metric(pass2.finalizeDone),
    finalizeTotal: metric(pass2.finalizeTotal),
    validationDone: metric(pass2.validationDone),
    validationTotal: metric(pass2.validationTotal),
  };
}

function normalizeCheckpoint(value: unknown): JobCheckpointView | null {
  const checkpoint = asRecord(value);
  return checkpoint ? { at: text(checkpoint.at) } : null;
}

function normalizeInterruption(value: unknown): JobInterruptionView | null {
  const interruption = asRecord(value);
  if (!interruption) return null;
  return {
    at: text(interruption.at),
    outcome: text(interruption.outcome) ?? "interrupted",
    reason: text(interruption.reason),
  };
}

/**
 * One job record. Returns `null` only when the payload is not a record or names no
 * version — a record with nothing but a version still renders, with "—" everywhere.
 */
export function normalizeJobState(value: unknown): CloudJobView | null {
  const record = asRecord(value);
  if (!record) return null;
  const version = text(record.version) ?? text(record.jobId);
  if (!version) return null;
  const { sources, known } = normalizeSources(record.sources);
  return {
    version,
    jobId: text(record.jobId) ?? version,
    stage: text(record.stage) ?? "unknown",
    mode: text(record.mode) ?? "unknown",
    startedAt: text(record.startedAt),
    updatedAt: text(record.updatedAt),
    finishedAt: text(record.finishedAt),
    note: text(record.note),
    partitions: metric(record.partitions),
    totals: normalizeTotals(record.totals),
    rate: normalizeRate(record.rate),
    accounting: normalizeAccounting(record.accounting),
    checkpoint: normalizeCheckpoint(record.checkpoint),
    sources,
    sourcesKnown: known,
    errors: normalizeErrors(record.errors),
    pass2: normalizePass2(record.pass2),
    interruption: normalizeInterruption(record.interruption),
  };
}

function normalizeControl(value: unknown): JobControlView | null {
  const control = asRecord(value);
  if (!control) return null;
  return {
    pause: control.pause === true,
    abort: control.abort === true,
    approvedFullRun: control.approvedFullRun === true,
  };
}

function normalizeRun(value: unknown): JobRunView | null {
  const run = asRecord(value);
  if (!run) return null;
  return {
    outcome: text(run.outcome) ?? "unknown",
    stage: text(run.stage) ?? "unknown",
    attempt: metric(run.attempt),
    pid: metric(run.pid),
    heartbeatAt: text(run.heartbeatAt),
    reason: text(run.reason),
  };
}

function normalizeWarning(value: unknown): JobWarningView | null {
  const warning = asRecord(value);
  const reason = warning ? text(warning.reason) : null;
  if (!warning || !reason) return null;
  return { kind: text(warning.kind) ?? "failed", since: text(warning.since), reason };
}

/**
 * The whole `GET /api/cloud/jobs` response. Total: every shape of input yields a
 * view, and anything skipped is reported in `issues` instead of thrown.
 */
export function normalizeJobsResponse(value: unknown): JobsView {
  const root = asRecord(value);
  if (!root) {
    return {
      jobs: [],
      truncated: false,
      staging: false,
      containerBound: null,
      issues: ["The control plane answered with a payload that is not a JSON object."],
    };
  }

  const issues: string[] = [];
  const rawJobs = Array.isArray(root.jobs) ? root.jobs : [];
  if (!Array.isArray(root.jobs)) issues.push("The response had no job list.");

  const jobs: CloudJobListingView[] = [];
  for (const entry of rawJobs) {
    const listing = asRecord(entry);
    const job = listing ? normalizeJobState(listing.state) : null;
    if (!listing || !job) {
      issues.push("A job record had no readable state and was skipped.");
      continue;
    }
    jobs.push({
      job,
      control: normalizeControl(listing.control),
      run: normalizeRun(listing.run),
      warning: normalizeWarning(listing.warning),
    });
  }

  return {
    jobs,
    truncated: root.truncated === true,
    staging: root.staging === true,
    containerBound: typeof root.containerBound === "boolean" ? root.containerBound : null,
    issues,
  };
}
