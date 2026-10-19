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

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Cloud, Gauge, HardDrive, Pause, Play, RefreshCw, ShieldCheck, Square, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader, Section, StatCard, StatusPill } from "@/components/common";
import type { CloudControl, CloudJobState } from "@/shared/cloud/types";

type JobsResponse = { jobs: { state: CloudJobState; control: CloudControl | null }[] };

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
  const [jobs, setJobs] = useState<{ state: CloudJobState; control: CloudControl | null }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifyOutput, setVerifyOutput] = useState<string | null>(null);
  const [benchVersion, setBenchVersion] = useState(`bench-${new Date().toISOString().slice(0, 10)}`);
  const [benchMb, setBenchMb] = useState("16");
  const [benchPartitions, setBenchPartitions] = useState("16");

  const refresh = useCallback(async () => {
    try {
      const data = await admin<JobsResponse>("/api/cloud/jobs");
      setJobs(data.jobs);
      setSelected((current) => current ?? data.jobs[0]?.state.version ?? null);
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

  const act = async (action: "pause" | "resume" | "abort") => {
    if (!state) return;
    setBusy(action);
    setNotice(null);
    try {
      await admin(`/api/cloud/jobs/${encodeURIComponent(state.version)}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setNotice(`${action} recorded — the engine checks it before the next chunk.`);
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
        description="Live Pass 1 state from R2. The engine runs in a Cloudflare Container; this page reads its durable checkpoint and writes its pause/abort flags."
        actions={
          <>
            <Badge variant="outline" className="gap-1.5 text-xs">
              <Cloud className="size-3.5" /> Preview control plane
            </Badge>
            <Button variant="outline" className="gap-2" onClick={() => void refresh()}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
          </>
        }
      />

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
              </span>
            ) : null}
            {control ? (
              <span className="text-xs text-muted-foreground">
                pause {String(control.pause)} · abort {String(control.abort)} · full-run approval {String(control.approvedFullRun)}
              </span>
            ) : null}
          </div>

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
                title="Bounded benchmark"
                description="Reads the first N MB of BOTH real sources, verifies every uploaded segment, and records the measured ratios the full-run forecast is built from."
                className="mt-6"
              >
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
                    <Button className="w-full gap-2" disabled={busy !== null} onClick={() => void startBenchmark()}>
                      <Play className="size-4" /> {busy === "benchmark" ? "Starting…" : "Run benchmark"}
                    </Button>
                  </div>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Partitions below 256 are a benchmark-only shortcut (the forecast scales object counts back up). A real run always
                  uses the configured partition count.
                </p>
              </Section>
            </>
          ) : null}
        </>
      )}
    </>
  );
}
