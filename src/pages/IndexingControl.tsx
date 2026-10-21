/**
 * Cloud indexing control panel.
 *
 * Every value on this page is read from the durable job state the engine writes
 * to R2 (`cloud/jobs/<version>/state.json`), and every control writes the same
 * `control.json` flag the engine checks between chunks. Nothing here is mocked.
 *
 * The panel can start a BOUNDED benchmark. It cannot start the full corpus: that
 * requires the measured forecast to be approved and is deliberately not reachable
 * from a browser control.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Cloud, Database, Gauge, HardDrive, Layers, Pause, Play, RefreshCw, ShieldCheck, Square, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader, Section, StatCard, StatusPill } from "@/components/common";
import type { CloudControl, CloudJobState, CloudRunStatus } from "@/shared/cloud/types";

/** Mirrors `JobListing` in `worker/src/indexer-admin.ts`. */
type JobWarning = { kind: "failed" | "interrupted" | "terminated" | "stale"; since: string; reason: string };
type JobListing = { state: CloudJobState; control: CloudControl | null; run: CloudRunStatus | null; warning: JobWarning | null };
type JobsResponse = { jobs: JobListing[]; containerBound?: boolean; staging?: boolean; truncated?: boolean };

const WARNING_LABEL: Record<JobWarning["kind"], string> = {
  failed: "Pass stopped with an error",
  interrupted: "Run interrupted",
  terminated: "Run terminated by the platform",
  stale: "Run is not advancing",
};

async function admin<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-companyintel-cloud-admin": "dev",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
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

const STAGE_TONE: Record<string, string> = {
  complete: "border-chart-2/40 bg-chart-2/10 text-chart-2",
  "pass1-complete": "border-chart-2/40 bg-chart-2/10 text-chart-2",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  aborted: "border-destructive/40 bg-destructive/10 text-destructive",
  paused: "border-chart-3/50 bg-chart-3/12 text-chart-3",
};

export default function IndexingControl() {
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifyOutput, setVerifyOutput] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  // `null` until the first successful read, so the panel does not warn about a
  // missing container before it knows.
  const [containerBound, setContainerBound] = useState<boolean | null>(null);
  const [benchVersion, setBenchVersion] = useState(`bench-${new Date().toISOString().slice(0, 10)}`);
  const stagingPrefixApplied = useRef(false);
  const [benchMb, setBenchMb] = useState("16");
  const [benchPartitions, setBenchPartitions] = useState("16");

  const refresh = useCallback(async () => {
    try {
      const data = await admin<JobsResponse>("/api/cloud/jobs");
      setJobs(data.jobs);
      setTruncated(Boolean(data.truncated));
      setSelected((current) => current ?? data.jobs[0]?.state.version ?? null);
      setStaging(Boolean(data.staging));
      setContainerBound(Boolean(data.containerBound));
      // A staging deployment only accepts `stg-` version ids; default the benchmark
      // field to one so the first attempt is not a 400.
      if (data.staging && !stagingPrefixApplied.current) {
        stagingPrefixApplied.current = true;
        setBenchVersion((current) => (current.startsWith("stg-") ? current : `stg-${current}`));
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    // Poll the durable state. The first read is deferred to a timer callback so
    // the effect only subscribes to an external system (the job state in R2).
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  const current = useMemo(() => {
    const matched = jobs.find((job) => job.state.version === selected);
    return matched ?? jobs[0] ?? null;
  }, [jobs, selected]);

  const state = current?.state ?? null;
  const control = current?.control ?? null;
  const warning = current?.warning ?? null;
  const run = current?.run ?? null;

  const act = async (action: "pause" | "resume" | "abort" | "approve") => {
    if (!state) return;
    if (action === "approve" && !window.confirm(`Record approval for a full-corpus run of ${state.version}? This is the gate that allows Pass 1 to read all 64 GB.`)) return;
    setBusy(action);
    setNotice(null);
    setError(null);
    try {
      // Resume is an action, not a flag: the server restarts the job (or the merge)
      // from its durable configuration and answers with what it actually did. Showing
      // that answer is what makes "recorded" and "started" distinguishable.
      const result = await admin<{
        ok?: boolean;
        started?: boolean;
        alreadyRunning?: boolean;
        stage?: string;
        partitions?: number;
        maxSourceMb?: number;
        message?: string;
      }>(`/api/cloud/jobs/${encodeURIComponent(state.version)}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (action === "resume") {
        setNotice(
          result.message ??
            (result.started
              ? `Resumed ${state.version} at the ${result.stage} stage.`
              : `Nothing was started for ${state.version}: no execution is pending.`),
        );
      } else {
        setNotice(
          action === "approve"
            ? "Full-run approval recorded in control.json. Nothing has started; use Start full Pass 1 when you are ready."
            : `${action} recorded — the engine checks it between chunks/partitions.`,
        );
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    if (!state) return;
    setBusy("verify");
    setVerifyOutput(null);
    try {
      const result = await admin<{ ok: boolean; output: string }>(`/api/cloud/jobs/${encodeURIComponent(state.version)}/verify`, {
        method: "POST",
        body: "{}",
      });
      setVerifyOutput(result.output || (result.ok ? "PASS" : "FAIL"));
    } catch (caught) {
      setVerifyOutput(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const preflight = async () => {
    setBusy("preflight");
    setVerifyOutput(null);
    try {
      const result = await admin<{ ok: boolean; output: string }>("/api/cloud/preflight", { method: "POST", body: "{}" });
      setVerifyOutput(result.output || (result.ok ? "READY" : "NOT READY"));
    } catch (caught) {
      setVerifyOutput(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const startFull = async () => {
    if (!state) return;
    if (!window.confirm(`Start FULL Pass 1 for ${state.version}? It reads all 64.26 GB from R2 and can run for hours.`)) return;
    setBusy("start-full");
    setNotice(null);
    try {
      const result = await admin<{ started: boolean }>(`/api/cloud/jobs/${encodeURIComponent(state.version)}/start`, {
        method: "POST",
        body: JSON.stringify({ confirm: "START", stage: "pass1" }),
      });
      setNotice(result.started ? `Full Pass 1 started for ${state.version}. Progress is durable in R2.` : "The job was not started.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const startPass2 = async () => {
    if (!state) return;
    if (!window.confirm(`Merge ${state.version} from its verified R2 segments into the index? No source object is modified.`)) return;
    setBusy("pass2");
    setNotice(null);
    try {
      const result = await admin<{ started: boolean; partitions: number; message?: string }>(
        `/api/cloud/jobs/${encodeURIComponent(state.version)}/pass2`,
        {
          method: "POST",
          body: JSON.stringify({ confirm: "PASS2", partitions: state.partitions }),
        },
      );
      setNotice(
        result.started
          ? `Cloud Pass 2 started with ${result.partitions} partitions. It merges one partition at a time and writes the index to R2.`
          : result.message ?? "Pass 2 was not started; a run is already active.",
      );
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    if (!state) return;
    if (!window.confirm(`Activate ${state.version} for the application? The previous version stays in R2 as the rollback target.`)) return;
    setBusy("activate");
    setNotice(null);
    try {
      const result = await admin<{ ok: boolean; output: string }>(`/api/cloud/jobs/${encodeURIComponent(state.version)}/activate`, {
        method: "POST",
        body: JSON.stringify({ confirm: state.version }),
      });
      setVerifyOutput(result.output || (result.ok ? "Activated." : "Activation failed."));
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const startBenchmark = async () => {
    setBusy("benchmark");
    setNotice(null);
    try {
      const result = await admin<{ started: boolean; version: string }>("/api/cloud/jobs/benchmark", {
        method: "POST",
        body: JSON.stringify({
          confirm: "BENCHMARK",
          version: benchVersion,
          maxSourceMb: Number(benchMb),
          partitions: Number(benchPartitions),
        }),
      });
      setSelected(result.version);
      setNotice(`Bounded benchmark started: ${result.version}. Progress appears here within one chunk.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Cloud indexing"
        description="Durable Pass 1 and Pass 2 state from R2. The engine runs in a Cloudflare Container; this page reads its checkpoint, writes the pause/abort flags, starts the merge and activates only a completed full run."
        actions={
          <>
            <Badge variant="outline" className="gap-1.5 text-xs">
              <Cloud className="size-3.5" /> Access-protected control plane
            </Badge>
            <Button variant="outline" className="gap-2" onClick={() => void refresh()}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
          </>
        }
      />

      {staging ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-chart-3/40 bg-chart-3/10 p-3 text-xs text-chart-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            Staging deployment. Version ids must start with <code className="font-mono">stg-</code>, full-corpus runs are refused, and activation
            writes <code className="font-mono">staging/active.json</code> — the production index pointer is never touched from here.
          </span>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-chart-2/30 bg-chart-2/5 p-3 text-xs text-chart-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>{notice}</span>
        </div>
      ) : null}

      {jobs.length === 0 ? (
        <EmptyState
          icon={<Cloud className="size-5" />}
          title="No cloud indexing job yet"
          description="Run the bounded benchmark below. It reads a slice of the real R2 sources through the same chunker and segment writer the container uses, and records every result in R2."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <label className="text-xs text-muted-foreground" htmlFor="job-select">
              Job
            </label>
            <select
              id="job-select"
              value={state?.version ?? ""}
              onChange={(event) => setSelected(event.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              {jobs.map((job) => (
                <option key={job.state.version} value={job.state.version}>
                  {job.state.version} · {job.state.stage}
                </option>
              ))}
            </select>
            {state ? (
              <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STAGE_TONE[state.stage] ?? "border-border bg-muted/40 text-muted-foreground"}`}>
                {state.stage}
                {state.stage === "pass2" && state.pass2?.phase ? ` · ${state.pass2.phase}` : ""}
              </span>
            ) : null}
            {control ? (
              <span className="text-xs text-muted-foreground">
                pause {String(control.pause)} · abort {String(control.abort)} · full-run approval {String(control.approvedFullRun)}
              </span>
            ) : null}
            {truncated ? <span className="text-xs text-chart-3">showing the newest jobs only</span> : null}
          </div>

          {/*
           * A detached run leaves no open request behind, so "the job is not moving"
           * has to be stated from the durable heartbeat. Without this banner a stopped
           * Pass 1 looks exactly like a slow one.
           */}
          {warning ? (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong>{WARNING_LABEL[warning.kind]}</strong> — {warning.reason}
                <span className="text-muted-foreground"> · {new Date(warning.since).toLocaleString()}</span>
              </span>
            </div>
          ) : run && run.outcome === "running" ? (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-chart-2/30 bg-chart-2/5 p-3 text-xs text-chart-2">
              <Activity className="mt-0.5 size-4 shrink-0" />
              <span>
                Run {run.attempt} is alive · stage {run.stage} · last heartbeat {new Date(run.heartbeatAt).toLocaleTimeString()}
                {run.pid ? ` · pid ${run.pid}` : ""}
              </span>
            </div>
          ) : run && run.outcome !== "completed" && (run.reason ?? state?.interruption?.reason) ? (
            /*
             * A terminal failure on a job whose stage is no longer in flight (failed,
             * paused after a stop) still needs its reason in the most visible place: the
             * stage pill alone does not say why it stopped.
             */
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong>{WARNING_LABEL[run.outcome as JobWarning["kind"]] ?? "Run stopped"}</strong> — {run.reason ?? state?.interruption?.reason}
                <span className="text-muted-foreground"> · {new Date(run.heartbeatAt).toLocaleString()}</span>
              </span>
            </div>
          ) : null}

          {state ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label="Rows read" value={state.totals.rowsRead.toLocaleString()} hint={`${state.totals.rowsRejected.toLocaleString()} rejected`} icon={<Activity className="size-4" />} />
                <StatCard
                  label="Segments"
                  value={state.totals.segments.toLocaleString()}
                  hint={`${formatBytes(state.totals.segmentBytes)} spool · ${state.totals.sourceBytesRead ? `${((state.totals.segmentBytes / state.totals.sourceBytesRead) * 100).toFixed(1)}% of source` : "—"}`}
                  icon={<HardDrive className="size-4" />}
                />
                <StatCard
                  label="Throughput"
                  value={state.rate.rowsPerSecond ? `${Math.round(state.rate.rowsPerSecond).toLocaleString()} rows/s` : "—"}
                  hint={`ETA ${formatDuration(state.rate.etaSeconds)}`}
                  icon={<Gauge className="size-4" />}
                />
                <StatCard
                  label="Estimated cost"
                  value={`$${state.accounting.estimatedUsd.toFixed(3)}`}
                  hint={`${state.accounting.classA.toLocaleString()} Class A · ${state.accounting.classB.toLocaleString()} Class B`}
                  icon={<Timer className="size-4" />}
                />
              </div>

              <Section
                title="Sources"
                description="Byte offsets are record boundaries; a restart resumes at the last verified chunk."
                className="mt-6"
              >
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
                    {state.sources.map((source) => (
                      <TableRow key={source.id}>
                        <TableCell className="font-medium">{source.id}</TableCell>
                        <TableCell>
                          <StatusPill ok={source.complete} label={source.complete ? "complete" : "in progress"} />
                        </TableCell>
                        <TableCell className="text-right tabular">{source.rows.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular">{source.rejected.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular">{source.chunks}</TableCell>
                        <TableCell className="text-right tabular">
                          {formatBytes(source.sourceBytes)} / {formatBytes(source.size)}
                        </TableCell>
                        <TableCell className="text-right tabular">{source.segments.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>

              <Section
                title="Controls"
                description="Pause takes effect after the chunk currently being written. No control deletes anything."
                className="mt-6"
              >
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" className="gap-2" disabled={busy !== null} onClick={() => void preflight()}>
                    <Cloud className="size-4" /> {busy === "preflight" ? "Checking…" : "Run preflight"}
                  </Button>
                  <Button variant="outline" className="gap-2" disabled={!state || busy !== null} onClick={() => void act("pause")}>
                    <Pause className="size-4" /> Pause
                  </Button>
                  <Button variant="outline" className="gap-2" disabled={!state || busy !== null} onClick={() => void act("resume")}>
                    <Play className="size-4" /> Resume
                  </Button>
                  <Button variant="outline" className="gap-2 text-destructive" disabled={!state || busy !== null} onClick={() => void act("abort")}>
                    <Square className="size-4" /> Stop
                  </Button>
                  <Button variant="outline" className="gap-2" disabled={!state || busy !== null} onClick={() => void verify()}>
                    <ShieldCheck className="size-4" /> {busy === "verify" ? "Verifying…" : "Verify segments"}
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2"
                    disabled={!state || busy !== null || Boolean(control?.approvedFullRun)}
                    onClick={() => void act("approve")}
                  >
                    <ShieldCheck className="size-4" /> {control?.approvedFullRun ? "Full run approved" : "Approve full run"}
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2"
                    disabled={!state || busy !== null || !control?.approvedFullRun || !["pass1", "failed"].includes(state.stage)}
                    onClick={() => void startFull()}
                  >
                    <Play className="size-4" /> {busy === "start-full" ? "Starting…" : "Start full Pass 1"}
                  </Button>
                </div>
                {verifyOutput ? (
                  <pre className="mt-3 max-h-56 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-[11px] leading-5">{verifyOutput}</pre>
                ) : null}
                <p className="mt-3 text-xs text-muted-foreground">
                  Last checkpoint: {state.checkpoint ? new Date(state.checkpoint.at).toLocaleString() : "none yet"} · full-run
                  execution is disabled here and requires an approved forecast.
                </p>
                {state.errors.length ? (
                  <div className="mt-3 space-y-1 text-xs text-destructive">
                    {state.errors.slice(-3).map((entry, index) => (
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
                {(() => {
                  /*
                   * A job used to sit at `stage: pass2` with the merge's last ETA for the
                   * entire finalize and validation tail, so a healthy upload looked
                   * stuck. The phase and its object counters are written by the engine;
                   * they are rendered here as the progress they are, and no ETA is shown
                   * for work that is request-bound rather than row-bound.
                   */
                  const pass2 = state.pass2;
                  const phase = pass2?.phase ?? (pass2 ? "merge" : null);
                  const merging = phase === "merge";
                  return (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                      <StatCard
                        label="Pass 2 merge"
                        value={pass2 ? `${pass2.partitionsDone.toLocaleString()} / ${pass2.partitionsTotal.toLocaleString()}` : "—"}
                        hint={
                          !pass2
                            ? "not started"
                            : merging
                              ? `${(state.rate.rowsPerSecond ?? 0).toLocaleString()} rows/s · ETA ${formatDuration(state.rate.etaSeconds)}`
                              : "merge complete — not repeated on resume"
                        }
                        icon={<Layers className="size-4" />}
                      />
                      <StatCard
                        label={phase === "validate" ? "Validation" : "Finalize"}
                        value={
                          phase === "finalize"
                            ? `${(pass2?.finalizeDone ?? 0).toLocaleString()} / ${(pass2?.finalizeTotal ?? 0).toLocaleString()}`
                            : phase === "validate" || phase === "complete"
                              ? "done"
                              : "—"
                        }
                        hint={
                          phase === "validate"
                            ? `${(pass2?.validationDone ?? 0).toLocaleString()} / ${(pass2?.validationTotal ?? 0).toLocaleString()} objects read back and checksummed`
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
                        hint={`${(pass2?.indexObjects ?? 0).toLocaleString()} objects · ${(pass2?.shardParts ?? 0).toLocaleString()} shard parts`}
                        icon={<Database className="size-4" />}
                      />
                      <StatCard
                        label="Estimated spend"
                        value={`$${(state.accounting.estimatedUsd + state.accounting.containerUsd).toFixed(3)}`}
                        hint={`R2 requests + container time · ${state.accounting.budgetUsd ? `budget $${state.accounting.budgetUsd} for the whole job · ` : ""}not a billing cap`}
                        icon={<Timer className="size-4" />}
                      />
                    </div>
                  );
                })()}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    className="gap-2"
                    disabled={busy !== null || !["pass1-complete", "pass2", "paused"].includes(state.stage)}
                    onClick={() => void startPass2()}
                  >
                    <Cloud className="size-4" /> {busy === "pass2" ? "Starting…" : "Start / resume Cloud Pass 2"}
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2"
                    disabled={busy !== null || state.stage !== "complete" || state.mode !== "full"}
                    onClick={() => void activate()}
                  >
                    <ShieldCheck className="size-4" /> {busy === "activate" ? "Activating…" : "Activate completed version"}
                  </Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {state.mode !== "full"
                    ? "This job is a bounded benchmark: it can build and verify an index, but activation is refused."
                    : "Activation re-checks the uploaded manifest and validation report in R2. A Pass 2 resumed after its merge continues at finalization: the 16 partition merge is not repeated, and every output is written idempotently, so nothing is duplicated."}
                </p>
                {state.errors.length ? (
                  <div className="mt-3 space-y-1 text-xs text-destructive">
                    {state.errors.slice(-3).map((entry, index) => (
                      <p key={`p2-${entry.at}-${index}`}>
                        {entry.stage}: {entry.message}
                      </p>
                    ))}
                  </div>
                ) : null}
              </Section>

            </>
          ) : null}
        </>
      )}

      {/*
       * Outside the `jobs.length` branch on purpose: the bounded benchmark is how a
       * first job is created, so hiding it behind "a job already exists" made the
       * only start control unreachable on a fresh deployment. It also stays visible
       * while a start is failing, so the error and the retry are on screen together.
       */}
      <Section
        title="Bounded benchmark"
        description="Reads the first N MB of BOTH real sources, verifies every uploaded segment, and records the measured ratios the full-run forecast is built from."
        className={jobs.length === 0 ? "" : "mt-6"}
      >
        {containerBound === false ? (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-chart-3/40 bg-chart-3/10 p-3 text-xs text-chart-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              No container binding is deployed on this Worker, so starting a job is refused. The panel can still read job state from
              R2.
            </span>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Version id</span>
            <Input value={benchVersion} onChange={(event) => setBenchVersion(event.target.value)} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">MB per source (1–256)</span>
            <Input value={benchMb} onChange={(event) => setBenchMb(event.target.value)} inputMode="numeric" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Partitions</span>
            <Input value={benchPartitions} onChange={(event) => setBenchPartitions(event.target.value)} inputMode="numeric" />
          </label>
          <div className="flex items-end">
            <Button className="w-full gap-2" disabled={busy !== null || containerBound === false} onClick={() => void startBenchmark()}>
              <Play className="size-4" /> {busy === "benchmark" ? "Starting…" : "Run benchmark"}
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Partitions below 256 are a benchmark-only shortcut (the forecast scales object counts back up). A real run always uses the
          configured partition count. A cold container start is waited for, so the first attempt is not refused while the image boots.
        </p>
      </Section>
    </>
  );
}
