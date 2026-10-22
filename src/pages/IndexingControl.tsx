/**
 * Cloud indexing control panel.
 *
 * Every value on this page is read from the durable job state the engine writes
 * to R2 (`cloud/jobs/<version>/state.json`), and every control writes the same
 * `control.json` flag the engine checks between chunks. Nothing here is mocked.
 *
 * Two kinds of run live here:
 *   - a BOUNDED benchmark, started and driven through this page's own controls;
 *   - the full corpus, started by ONE administrator confirmation in `SwarmLaunch`,
 *     which approves the run, plans 256 partitions and pumps all 16 containers
 *     through the existing production endpoints. From there the durable coordinator
 *     owns execution, so the browser may be closed.
 *
 * Neither path bypasses Access, the admin allowlist or the budget gates.
 *
 * The listing is normalised before it is rendered (`normalizeJobsResponse`): a
 * historical record can be a scan (no `totals`) or an older partial state, and
 * missing metrics must render as "—" rather than crash the page — and must never
 * hide the launch control.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Cloud, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, PageHeader, Section } from "@/components/common";
import { JobDetail, type JobAction } from "@/components/indexing-job";
import { SwarmLaunch } from "@/components/swarm-launch";
import { admin, loadJobs } from "@/lib/api/cloud-admin";
import type { CloudJobListingView } from "@/shared/cloud/job-view";

const STAGE_TONE: Record<string, string> = {
  complete: "border-chart-2/40 bg-chart-2/10 text-chart-2",
  "pass1-complete": "border-chart-2/40 bg-chart-2/10 text-chart-2",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  aborted: "border-destructive/40 bg-destructive/10 text-destructive",
  paused: "border-chart-3/50 bg-chart-3/12 text-chart-3",
};

export default function IndexingControl() {
  const [jobs, setJobs] = useState<CloudJobListingView[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Non-fatal listing problems: one unreadable record never hides the rest. */
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifyOutput, setVerifyOutput] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  /** True only after the Access-protected `/api/cloud/jobs` read succeeded. */
  const [authorized, setAuthorized] = useState(false);
  // `null` until the first successful read, so the panel does not warn about a
  // missing container before it knows.
  const [containerBound, setContainerBound] = useState<boolean | null>(null);
  const [benchVersion, setBenchVersion] = useState(`bench-${new Date().toISOString().slice(0, 10)}`);
  const stagingPrefixApplied = useRef(false);
  const [benchMb, setBenchMb] = useState("16");
  const [benchPartitions, setBenchPartitions] = useState("16");

  const refresh = useCallback(async () => {
    const result = await loadJobs();
    if (result.kind === "denied") {
      // A 401/403 is an authorisation answer, not a transport failure: hide the
      // launch control instead of offering a button that can never succeed.
      setAuthorized(false);
      setError(result.message);
      return;
    }
    if (result.kind === "error") {
      // The last authorised view stays on screen; only the failure is reported.
      setError(result.message);
      return;
    }
    const view = result.view;
    setJobs(view.jobs);
    setDiagnostics(view.issues);
    setTruncated(view.truncated);
    setSelected((current) => current ?? view.jobs[0]?.job.version ?? null);
    setStaging(view.staging);
    setContainerBound(view.containerBound);
    setAuthorized(true);
    // A staging deployment only accepts `stg-` version ids; default the benchmark
    // field to one so the first attempt is not a 400.
    if (view.staging && !stagingPrefixApplied.current) {
      stagingPrefixApplied.current = true;
      setBenchVersion((current) => (current.startsWith("stg-") ? current : `stg-${current}`));
    }
    setError(null);
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
    const matched = jobs.find((entry) => entry.job.version === selected);
    return matched ?? jobs[0] ?? null;
  }, [jobs, selected]);

  const job = current?.job ?? null;
  const control = current?.control ?? null;
  const warning = current?.warning ?? null;
  const run = current?.run ?? null;

  const act = async (action: JobAction) => {
    if (!job) return;
    if (action === "approve" && !window.confirm(`Record approval for a full-corpus run of ${job.version}? This is the gate that allows Pass 1 to read all 64 GB.`)) return;
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
      }>(`/api/cloud/jobs/${encodeURIComponent(job.version)}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (action === "resume") {
        setNotice(
          result.message ??
            (result.started
              ? `Resumed ${job.version} at the ${result.stage} stage.`
              : `Nothing was started for ${job.version}: no execution is pending.`),
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
    if (!job) return;
    setBusy("verify");
    setVerifyOutput(null);
    try {
      const result = await admin<{ ok: boolean; output: string }>(`/api/cloud/jobs/${encodeURIComponent(job.version)}/verify`, {
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
    if (!job) return;
    if (!window.confirm(`Start FULL Pass 1 for ${job.version}? It reads all 64.26 GB from R2 and can run for hours.`)) return;
    setBusy("start-full");
    setNotice(null);
    try {
      const result = await admin<{ started: boolean }>(`/api/cloud/jobs/${encodeURIComponent(job.version)}/start`, {
        method: "POST",
        body: JSON.stringify({ confirm: "START", stage: "pass1" }),
      });
      setNotice(result.started ? `Full Pass 1 started for ${job.version}. Progress is durable in R2.` : "The job was not started.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const startPass2 = async () => {
    if (!job) return;
    if (!window.confirm(`Merge ${job.version} from its verified R2 segments into the index? No source object is modified.`)) return;
    setBusy("pass2");
    setNotice(null);
    try {
      const result = await admin<{ started: boolean; partitions: number; message?: string }>(
        `/api/cloud/jobs/${encodeURIComponent(job.version)}/pass2`,
        {
          method: "POST",
          body: JSON.stringify({ confirm: "PASS2", partitions: job.partitions ?? undefined }),
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
    if (!job) return;
    if (!window.confirm(`Activate ${job.version} for the application? The previous version stays in R2 as the rollback target.`)) return;
    setBusy("activate");
    setNotice(null);
    try {
      const result = await admin<{ ok: boolean; output: string }>(`/api/cloud/jobs/${encodeURIComponent(job.version)}/activate`, {
        method: "POST",
        body: JSON.stringify({ confirm: job.version }),
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
      {diagnostics.length ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-chart-3/40 bg-chart-3/10 p-3 text-xs text-chart-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>Some job records could not be read.</strong> {diagnostics.join(" ")} The rest of the panel and the launch control are
            unaffected.
          </span>
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-chart-2/30 bg-chart-2/5 p-3 text-xs text-chart-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>{notice}</span>
        </div>
      ) : null}

      {/*
       * The one-click full-corpus launch. It sits outside the job listing because a
       * swarm run is coordinated by its own durable object, not by `cloud/jobs`
       * state — so it must be reachable on a deployment that has never run a job,
       * and on one whose newest job record is incomplete.
       */}
      <SwarmLaunch authorized={authorized} staging={staging} />

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
              value={job?.version ?? ""}
              onChange={(event) => setSelected(event.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              {jobs.map((entry) => (
                <option key={entry.job.version} value={entry.job.version}>
                  {entry.job.version} · {entry.job.stage}
                </option>
              ))}
            </select>
            {job ? (
              <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STAGE_TONE[job.stage] ?? "border-border bg-muted/40 text-muted-foreground"}`}>
                {job.stage}
                {job.stage === "pass2" && job.pass2?.phase ? ` · ${job.pass2.phase}` : ""}
              </span>
            ) : null}
            {job && job.mode !== "full" && job.mode !== "benchmark" ? (
              <span className="text-xs text-muted-foreground">record type {job.mode}</span>
            ) : null}
            {control ? (
              <span className="text-xs text-muted-foreground">
                pause {String(control.pause)} · abort {String(control.abort)} · full-run approval {String(control.approvedFullRun)}
              </span>
            ) : null}
            {truncated ? <span className="text-xs text-chart-3">showing the newest jobs only</span> : null}
          </div>

          {job ? (
            <JobDetail
              job={job}
              control={control}
              run={run}
              warning={warning}
              busy={busy}
              verifyOutput={verifyOutput}
              onAction={(action) => void act(action)}
              onVerify={() => void verify()}
              onPreflight={() => void preflight()}
              onStartFull={() => void startFull()}
              onStartPass2={() => void startPass2()}
              onActivate={() => void activate()}
            />
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
