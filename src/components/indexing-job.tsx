/**
 * The selected job's durable detail: totals, per-source progress, controls, Pass 2.
 *
 * Props-driven on purpose. The job listing is whatever object is stored at
 * `cloud/jobs/<version>/state.json`, and those objects are not all the same shape
 * (a direct real-data scan has no `totals`, `sources` or `rate`; an interrupted
 * pre-upgrade job can lack `accounting`). Rendering this component from a
 * normalised `CloudJobView` — and testing it with those records — is what stops a
 * single historical job from taking the whole page down.
 *
 * Display rule: an unknown value is "—", never 0. A measured 0 is shown as 0.
 */

import { Activity, AlertTriangle, Cloud, Database, Gauge, HardDrive, Layers, Pause, Play, ShieldCheck, Square, Timer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Section, StatCard, StatusPill } from "@/components/common";
import type { CloudJobView, JobAccountingView, JobCheckpointView, JobControlView, JobRateView, JobRunView, JobWarningView } from "@/shared/cloud/job-view";

export type JobAction = "pause" | "resume" | "abort" | "approve";

const WARNING_LABEL: Record<string, string> = {
  failed: "Pass stopped with an error",
  interrupted: "Run interrupted",
  terminated: "Run terminated by the platform",
  stale: "Run is not advancing",
};

function formatCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
}

function formatUsd(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(3)}` : "—";
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function checkpointLabel(checkpoint: JobCheckpointView | null): string {
  if (!checkpoint) return "none yet";
  return formatTime(checkpoint.at) ?? "not reported";
}

function rateHint(rate: JobRateView | null): string {
  if (!rate) return "not reported by this job";
  return `${formatCount(rate.rowsPerSecond)} rows/s · ETA ${formatDuration(rate.etaSeconds)}`;
}

/** The combined estimate needs both halves; one missing is not a total. */
function combinedSpend(accounting: JobAccountingView | null): number | null {
  if (!accounting || accounting.estimatedUsd === null || accounting.containerUsd === null) return null;
  return accounting.estimatedUsd + accounting.containerUsd;
}

function spendHint(accounting: JobAccountingView | null): string {
  if (!accounting) return "not reported by this job";
  const budget = accounting.budgetUsd !== null ? `budget $${accounting.budgetUsd} for the whole job · ` : "";
  return `${budget}not a billing cap`;
}

export interface JobDetailProps {
  job: CloudJobView;
  control: JobControlView | null;
  run: JobRunView | null;
  warning: JobWarningView | null;
  busy: string | null;
  verifyOutput: string | null;
  onAction: (action: JobAction) => void;
  onVerify: () => void;
  onPreflight: () => void;
  onStartFull: () => void;
  onStartPass2: () => void;
  onActivate: () => void;
}

export function JobDetail({
  job,
  control,
  run,
  warning,
  busy,
  verifyOutput,
  onAction,
  onVerify,
  onPreflight,
  onStartFull,
  onStartPass2,
  onActivate,
}: JobDetailProps) {
  const missing = [
    job.totals ? null : "indexing totals",
    job.rate ? null : "throughput",
    job.accounting ? null : "spend",
    job.sourcesKnown ? null : "per-source progress",
  ].filter((entry): entry is string => entry !== null);

  const pass2 = job.pass2;
  const phase = pass2?.phase ?? (pass2 ? "merge" : null);
  const merging = phase === "merge";
  const spend = combinedSpend(job.accounting);
  const heartbeat = formatTime(run?.heartbeatAt ?? null);
  const stoppedReason = run?.reason ?? job.interruption?.reason ?? null;
  const stoppedAt = formatTime(run?.heartbeatAt ?? job.interruption?.at ?? null);

  return (
    <>
      {/*
       * A record that is not a Pass 1/Pass 2 state (a scan, or an old partial
       * write) is named as such instead of being rendered as "0 rows".
       */}
      {missing.length ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-chart-3/40 bg-chart-3/10 p-3 text-xs text-chart-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            This record does not include {missing.join(", ")} (mode <code className="font-mono">{job.mode}</code>). Those values are shown as — and
            nothing is inferred; the job&apos;s controls stay available.
          </span>
        </div>
      ) : null}

      {/* A detached run leaves no open request behind, so "the job is not moving" has to be stated. */}
      {warning ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>{WARNING_LABEL[warning.kind] ?? "Run stopped"}</strong> — {warning.reason}
            {formatTime(warning.since) ? <span className="text-muted-foreground"> · {formatTime(warning.since)}</span> : null}
          </span>
        </div>
      ) : run && run.outcome === "running" ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-chart-2/30 bg-chart-2/5 p-3 text-xs text-chart-2">
          <Activity className="mt-0.5 size-4 shrink-0" />
          <span>
            Run {formatCount(run.attempt)} is alive · stage {run.stage}
            {heartbeat ? ` · last heartbeat ${heartbeat}` : ""}
            {run.pid === null ? "" : ` · pid ${run.pid}`}
          </span>
        </div>
      ) : run && run.outcome !== "completed" && stoppedReason ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>{WARNING_LABEL[run.outcome] ?? "Run stopped"}</strong> — {stoppedReason}
            {stoppedAt ? <span className="text-muted-foreground"> · {stoppedAt}</span> : null}
          </span>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Rows read"
          value={formatCount(job.totals?.rowsRead)}
          hint={job.totals ? `${formatCount(job.totals.rowsRejected)} rejected` : "not reported by this job"}
          icon={<Activity className="size-4" />}
        />
        <StatCard
          label="Segments"
          value={formatCount(job.totals?.segments)}
          hint={
            job.totals
              ? `${formatBytes(job.totals.segmentBytes)} spool${
                  job.totals.segmentBytes !== null && job.totals.sourceBytesRead
                    ? ` · ${((job.totals.segmentBytes / job.totals.sourceBytesRead) * 100).toFixed(1)}% of source`
                    : ""
                }`
              : "not reported by this job"
          }
          icon={<HardDrive className="size-4" />}
        />
        <StatCard
          label="Throughput"
          value={job.rate && job.rate.rowsPerSecond !== null ? `${formatCount(Math.round(job.rate.rowsPerSecond))} rows/s` : "—"}
          hint={rateHint(job.rate)}
          icon={<Gauge className="size-4" />}
        />
        <StatCard
          label="Estimated cost"
          value={formatUsd(job.accounting?.estimatedUsd)}
          hint={
            job.accounting
              ? `${formatCount(job.accounting.classA)} Class A · ${formatCount(job.accounting.classB)} Class B`
              : "not reported by this job"
          }
          icon={<Timer className="size-4" />}
        />
      </div>

      <Section title="Sources" description="Byte offsets are record boundaries; a restart resumes at the last verified chunk." className="mt-6">
        {job.sourcesKnown ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
                <TableHead className="text-right">Chunks</TableHead>
                <TableHead className="text-right">Read</TableHead>
                <TableHead className="text-right">Segments</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {job.sources.map((source) => (
                <TableRow key={source.id}>
                  <TableCell className="font-medium">{source.id}</TableCell>
                  <TableCell>
                    <StatusPill ok={source.complete} label={source.complete ? "complete" : "in progress"} />
                  </TableCell>
                  <TableCell className="text-right tabular">{formatCount(source.rows)}</TableCell>
                  <TableCell className="text-right tabular">{formatCount(source.rejected)}</TableCell>
                  <TableCell className="text-right tabular">{formatCount(source.chunks)}</TableCell>
                  <TableCell className="text-right tabular">
                    {formatBytes(source.sourceBytes)} / {formatBytes(source.size)}
                  </TableCell>
                  <TableCell className="text-right tabular">{formatCount(source.segments)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-5 py-4 text-xs text-muted-foreground">
            This job record carries no per-source progress. It was not written by a Pass 1 run, so there is nothing to verify or resume per
            source here.
          </p>
        )}
      </Section>

      <Section
        title="Controls"
        description="Pause takes effect after the chunk currently being written. No control deletes anything."
        className="mt-6"
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="gap-2" disabled={busy !== null} onClick={onPreflight}>
            <Cloud className="size-4" /> {busy === "preflight" ? "Checking…" : "Run preflight"}
          </Button>
          <Button variant="outline" className="gap-2" disabled={busy !== null} onClick={() => onAction("pause")}>
            <Pause className="size-4" /> Pause
          </Button>
          <Button variant="outline" className="gap-2" disabled={busy !== null} onClick={() => onAction("resume")}>
            <Play className="size-4" /> Resume
          </Button>
          <Button variant="outline" className="gap-2 text-destructive" disabled={busy !== null} onClick={() => onAction("abort")}>
            <Square className="size-4" /> Stop
          </Button>
          <Button variant="outline" className="gap-2" disabled={busy !== null} onClick={onVerify}>
            <ShieldCheck className="size-4" /> {busy === "verify" ? "Verifying…" : "Verify segments"}
          </Button>
          <Button variant="outline" className="gap-2" disabled={busy !== null || control?.approvedFullRun === true} onClick={() => onAction("approve")}>
            <ShieldCheck className="size-4" /> {control?.approvedFullRun ? "Full run approved" : "Approve full run"}
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            disabled={busy !== null || control?.approvedFullRun !== true || !["pass1", "failed"].includes(job.stage)}
            onClick={onStartFull}
          >
            <Play className="size-4" /> {busy === "start-full" ? "Starting…" : "Start full Pass 1"}
          </Button>
        </div>
        {verifyOutput ? (
          <pre className="mt-3 max-h-56 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-[11px] leading-5">{verifyOutput}</pre>
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground">
          Last checkpoint: {checkpointLabel(job.checkpoint)} · full-run execution is disabled here and requires an approved forecast.
        </p>
        {job.errors.length ? (
          <div className="mt-3 space-y-1 text-xs text-destructive">
            {job.errors.slice(-3).map((entry, index) => (
              <p key={`${entry.at}-${index}`}>
                {entry.stage}: {entry.message}
              </p>
            ))}
          </div>
        ) : null}
      </Section>

      <Section
        title="Cloud Pass 2 and activation"
        description="Merges the verified segments directly from R2, one partition at a time. The whole spool and the whole index are never on local disk, and the source objects are read-only."
        className="mt-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Pass 2 merge"
            value={pass2 ? `${formatCount(pass2.partitionsDone)} / ${formatCount(pass2.partitionsTotal)}` : "—"}
            hint={
              !pass2
                ? "not started"
                : merging
                  ? job.rate
                    ? `${formatCount(job.rate.rowsPerSecond)} rows/s · ETA ${formatDuration(job.rate.etaSeconds)}`
                    : "rate not reported"
                  : "merge complete — not repeated on resume"
            }
            icon={<Layers className="size-4" />}
          />
          <StatCard
            label={phase === "validate" ? "Validation" : "Finalize"}
            value={
              phase === "finalize"
                ? `${formatCount(pass2?.finalizeDone)} / ${formatCount(pass2?.finalizeTotal)}`
                : phase === "validate" || phase === "complete"
                  ? "done"
                  : "—"
            }
            hint={
              phase === "validate"
                ? `${formatCount(pass2?.validationDone)} / ${formatCount(pass2?.validationTotal)} objects read back and checksummed`
                : phase === "finalize"
                  ? "shards processed and written to R2 (empty shards write no object)"
                  : phase === "complete"
                    ? "manifest and validation report published"
                    : "starts after the merge"
            }
            icon={<ShieldCheck className="size-4" />}
          />
          <StatCard
            label="Index in R2"
            value={formatBytes(pass2?.indexBytes)}
            hint={`${formatCount(pass2?.indexObjects)} objects · ${formatCount(pass2?.shardParts)} shard parts`}
            icon={<Database className="size-4" />}
          />
          <StatCard label="Estimated spend" value={formatUsd(spend)} hint={spendHint(job.accounting)} icon={<Timer className="size-4" />} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            className="gap-2"
            disabled={busy !== null || !["pass1-complete", "pass2", "paused"].includes(job.stage)}
            onClick={onStartPass2}
          >
            <Cloud className="size-4" /> {busy === "pass2" ? "Starting…" : "Start / resume Cloud Pass 2"}
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            disabled={busy !== null || job.stage !== "complete" || job.mode !== "full"}
            onClick={onActivate}
          >
            <ShieldCheck className="size-4" /> {busy === "activate" ? "Activating…" : "Activate completed version"}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {job.mode !== "full"
            ? "This job is not a full-corpus run: it can build and verify an index, but activation is refused."
            : "Activation re-checks the uploaded manifest and validation report in R2. A Pass 2 resumed after its merge continues at finalization: the 16 partition merge is not repeated, and every output is written idempotently, so nothing is duplicated."}
        </p>
        {job.errors.length ? (
          <div className="mt-3 space-y-1 text-xs text-destructive">
            {job.errors.slice(-3).map((entry, index) => (
              <p key={`p2-${entry.at}-${index}`}>
                {entry.stage}: {entry.message}
              </p>
            ))}
          </div>
        ) : null}
      </Section>
    </>
  );
}
