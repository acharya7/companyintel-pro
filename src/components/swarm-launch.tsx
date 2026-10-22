/**
 * One-click full-corpus indexing: launch control + live swarm status.
 *
 * The button runs the EXISTING production control plane in order, with the operator's
 * single confirmation standing in for the individual phase approvals:
 *
 *   1. POST /api/cloud/jobs/<version>/control  { action: "approve" }   ← full-run gate
 *   2. POST /api/cloud/swarm/plan   { version, partitions: 256, blockMb: 64, rangeBlocks: 2, workers: 64 }
 *   3. POST /api/cloud/swarm/launch            { workers: 64 }
 *   4. GET  /api/cloud/swarm/status            ← the live state rendered below
 *
 * It never bypasses Access: every request goes through the same admin API the rest of
 * this page uses, and the card is only rendered after an authorised `/api/cloud/jobs`
 * read succeeds. The coordinator owns execution from there — the browser may be
 * closed, and a paused or interrupted run resumes from its durable plan.
 *
 * Duplicate protection: if a parallel run already exists, the control refuses to
 * start a second one for a different version, resumes the same version instead of
 * re-planning it, and re-launching only pumps the selected workers (which is how a stalled
 * swarm is woken without resetting its queues).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Cloud, Gauge, Pause, Play, Power, RefreshCw, Rocket, ShieldCheck, Square, Timer, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Section, StatCard } from "@/components/common";
import type { SwarmStatus, SwarmStopSummary } from "@/shared/cloud/swarm";

const SOURCE_FACTS = [
  { id: "csv1", key: "raw/file1.csv", size: "10.22 GB" },
  { id: "csv2", key: "raw/file2.csv", size: "54.04 GB" },
];

const TERMINAL = new Set(["complete", "aborted", "failed"]);
const WORKER_CHOICES = [1, 2, 4, 8, 16, 32, 64, 96, 128];
/** Target pool for the full corpus; the operator can scale within the coordinator's ceiling. */
const WORKER_DEFAULT = 64;

/** What every swarm control answers with, including what the containers really did. */
interface SwarmControlResponse {
  ok?: boolean;
  status?: SwarmStatus | null;
  released?: string[];
  workers?: number;
  retired?: string[];
  shutdown?: SwarmStopSummary;
}

async function admin<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-companyintel-cloud-admin": "dev",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!response.ok) {
    // The status code is kept: "no plan yet" (502) and "this deployment has no
    // swarm" (503) are different answers, and only the first is normal.
    const failure = new Error(body?.error?.message ?? `Request failed (${response.status})`) as Error & { status?: number };
    failure.status = response.status;
    throw failure;
  }
  return body as T;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatRate(value: number | null | undefined): string {
  return value ? `${Math.round(value).toLocaleString()}/s` : "—";
}

function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds <= 0) return "0m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const STAGE_LABEL: Record<string, string> = {
  planned: "Planned",
  blocks: "Blocks (alignment)",
  ingest: "Parallel ingest",
  merge_partitions: "256 partition merges",
  assemble_shards: "Shard assembly",
  finalize: "Finalize",
  merge: "Merge (legacy single task)",
  complete: "Complete",
  paused: "Paused",
  aborted: "Aborted",
  failed: "Failed",
};

export function SwarmLaunch({ authorized, staging }: { authorized: boolean; staging: boolean }) {
  const [version, setVersion] = useState(() => `full-${new Date().toISOString().slice(0, 10)}`);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<SwarmStatus | null>(null);
  /** A 502 "no swarm plan" is the normal empty state, not an error worth showing. */
  const [statusKnown, setStatusKnown] = useState(false);
  /** The operator's chosen workforce; `null` means "whatever the coordinator reports". */
  const [workerChoice, setWorkerChoice] = useState<number | null>(null);
  /** The last stop's per-worker outcome, shown until the next control is used. */
  const [shutdown, setShutdown] = useState<SwarmStopSummary | null>(null);
  const workers = workerChoice ?? status?.workersAuthorised ?? WORKER_DEFAULT;

  const refreshStatus = useCallback(async () => {
    try {
      const data = await admin<SwarmStatus>("/api/cloud/swarm/status");
      // Guard the shape: this endpoint answers with the coordinator's status or a
      // JSON error, and a malformed payload must not crash the panel.
      if (data && typeof data.stage === "string" && data.tasks) {
        setStatus(data);
        setStatusKnown(true);
      }
    } catch {
      // No plan yet (or a transient coordinator error). Keep whatever we had.
      setStatusKnown(true);
    }
  }, []);

  useEffect(() => {
    if (!authorized || staging) return;
    const initial = setTimeout(() => void refreshStatus(), 0);
    // The coordinator is the source of truth while the page is open; execution does
    // not depend on this poll — closing the tab does not stop the swarm.
    const timer = setInterval(() => void refreshStatus(), 5000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [authorized, staging, refreshStatus]);

  const running = Boolean(status && !TERMINAL.has(status.stage));
  const accounting = status?.accounting;
  const remaining = useMemo(() => {
    if (!accounting) return null;
    const budget = accounting.budgetUsd ?? 50;
    return Math.max(0, budget - accounting.estimatedUsd);
  }, [accounting]);

  const start = async () => {
    const id = version.trim();
    setBusy("start");
    setError(null);
    setNotice(null);
    try {
      /*
       * Never start a second swarm. The coordinator is per version, so an existing
       * non-terminal run for a different version is a conflict; the same version is
       * resumed (plan is idempotent) rather than re-planned.
       */
      let existing: SwarmStatus | null = null;
      try {
        existing = await admin<SwarmStatus>("/api/cloud/swarm/status");
      } catch (caught) {
        // A deployment without the coordinator/Container bindings must say so, not
        // fall through to an approval request that would fail with a confusing
        // "invalid action" from whichever plane answered.
        if ((caught as { status?: number }).status === 503) throw caught;
        existing = null;
      }
      if (existing && typeof existing.stage === "string" && !TERMINAL.has(existing.stage) && existing.version !== id) {
        throw new Error(
          `A parallel run for ${existing.version} is already ${existing.stage}. Finish or stop it before starting ${id}.`,
        );
      }
      /*
       * The coordinator is keyed per version: one completed swarm leaves it owning
       * that version. Say so plainly instead of letting the plan call fail with a
       * coordinator error — re-indexing needs a fresh coordinator, and activation of
       * the completed generation is the step that comes first.
       */
      if (existing?.stage === "complete" && existing.version !== id) {
        throw new Error(
          `The swarm coordinator already completed ${existing.version}; it will not take a second version. Activate that generation first, then start a new run against a fresh coordinator.`,
        );
      }

      await admin(`/api/cloud/jobs/${encodeURIComponent(id)}/control`, {
        method: "POST",
        body: JSON.stringify({ action: "approve" }),
      });

      if (existing?.version === id && existing.stage === "paused") {
        const resumed = await admin<SwarmControlResponse>("/api/cloud/swarm/resume", {
          method: "POST",
          body: JSON.stringify({ workers }),
        });
        setShutdown(resumed.shutdown ?? null);
        setNotice(`Resumed ${id} with ${workers} worker(s) from its durable plan; the workers pick up where they stopped.`);
      } else if (!(existing?.version === id && !TERMINAL.has(existing.stage))) {
        await admin("/api/cloud/swarm/plan", {
          method: "POST",
          body: JSON.stringify({ version: id, partitions: 256, blockMb: 64, rangeBlocks: 2, workers: WORKER_DEFAULT }),
        });
        setNotice(`Full-corpus plan created for ${id}: 256 partitions, ${WORKER_DEFAULT} containers.`);
      } else {
        setNotice(`A plan for ${id} already exists at ${existing.stage}; re-launching its workers.`);
      }

      const launched = await admin<{ launched: number }>("/api/cloud/swarm/launch", {
        method: "POST",
        body: JSON.stringify({ workers }),
      });
      await refreshStatus();
      setNotice((current) => `${current ?? ""} ${launched.launched} worker(s) pumped; the coordinator runs the phases.`.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  /**
   * Every control reports what the CONTAINERS did, not just what the coordinator was
   * told. A pause that is recorded while nine containers keep running is the failure
   * this panel exists to make visible.
   */
  const runControl = async (action: string, path: string, body: Record<string, unknown>, message: string) => {
    setBusy(action);
    setError(null);
    try {
      const result = await admin<SwarmControlResponse>(path, { method: "POST", body: JSON.stringify(body) });
      setShutdown(result.shutdown ?? null);
      if (result.status) setStatus(result.status);
      setNotice(
        result.shutdown && result.shutdown.failed > 0
          ? `${message} ${result.shutdown.stopped} container(s) stopped, ${result.shutdown.failed} did not — see the per-worker report.`
          : message,
      );
      await refreshStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const pauseAndDrain = () =>
    runControl(
      "pause",
      "/api/cloud/swarm/pause",
      {},
      "Paused: the coordinator released every in-flight lease, so the containers were stopped without failing or parking a task.",
    );

  const resume = () =>
    runControl(
      "resume",
      "/api/cloud/swarm/resume",
      { workers },
      `Resumed with ${workers} worker(s); workers above that count were stopped and their leases handed back.`,
    );

  const stopContainers = () =>
    runControl(
      "stop",
      "/api/cloud/swarm/stop",
      {},
      "Stop requested: the coordinator is paused and every container was asked to stop. The job itself is untouched and can be resumed.",
    );

  const scale = () =>
    runControl(
      "scale",
      "/api/cloud/swarm/scale",
      { workers },
      `Workforce limited to ${workers}; workers above that count were stopped and their leases returned to the queue.`,
    );

  const abort = () =>
    runControl("abort", "/api/cloud/swarm/abort", {}, "Aborted: every container was asked to stop.");

  // Authorisation is enforced by the API; the control is not even rendered for an
  // identity the admin read did not accept, and staging never starts a full run.
  if (!authorized || staging) return null;

  return (
    <Section
      className="mb-4"
      title={`Full dataset indexing — ${WORKER_DEFAULT} containers`}
      description="One confirmation starts the production swarm: blocks → parallel ingest → 256 partition merges → 2,816 shard tasks → finalize. The coordinator runs in Cloudflare and survives closing this tab."
      actions={
        <>
          {status ? (
            <Badge variant="outline" className="gap-1.5 text-xs">
              <Activity className="size-3.5" /> {STAGE_LABEL[status.stage] ?? status.stage}
            </Badge>
          ) : null}
          <Button variant="outline" className="gap-2" onClick={() => void refreshStatus()} disabled={busy !== null}>
            <RefreshCw className="size-4" /> Status
          </Button>
          <Button className="gap-2" onClick={() => setConfirming(true)} disabled={busy !== null || running}>
            <Rocket className="size-4" />
            {running ? "Full indexing is running" : `START FULL INDEXING — ${WORKER_DEFAULT} CONTAINERS`}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <div className="grid gap-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="space-y-1">
            <span className="block font-medium text-muted-foreground">Version id for this run</span>
            <Input value={version} onChange={(event) => setVersion(event.target.value)} disabled={running || busy !== null} className="h-8 font-mono text-xs" />
          </label>
          <p className="text-muted-foreground sm:max-w-md">
            A published version is immutable: use a new id for a fresh run, or re-launch the current one to resume it.
          </p>
        </div>

        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="flex items-start gap-2 rounded-lg border border-chart-2/30 bg-chart-2/5 p-3 text-xs text-chart-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>{notice}</span>
          </div>
        ) : null}

        {status ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Job</span>
              <Badge variant="outline" className="font-mono text-xs">
                {status.version}
              </Badge>
              <span>{STAGE_LABEL[status.stage] ?? status.stage}</span>
              <span>· {status.workersActive}/{status.workersAuthorised} containers active</span>
              <span>· {status.sources.length} sources</span>
              {status.stopReason ? <span className="text-chart-3">· {status.stopReason}</span> : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Source coverage" value={`${status.totals.coveragePercent}%`} hint={`${formatBytes(status.totals.bytesCovered)} of ${formatBytes(status.totals.bytesTotal)}`} icon={<Cloud className="size-4" />} />
              <StatCard label="Rows parsed" value={status.totals.rows.toLocaleString()} hint={`${formatRate(status.rate.rowsPerSecond)} parsed`} icon={<Gauge className="size-4" />} />
              <StatCard label="Searchable rate" value={formatRate(status.rate.searchableRowsPerSecond)} hint="rows/s in a completed index" icon={<Activity className="size-4" />} />
              <StatCard label="ETA" value={formatEta(status.rate.etaSeconds)} hint={status.stage === "complete" ? "finished" : "from measured bytes/s"} icon={<Timer className="size-4" />} />
              <StatCard label="Partition merges" value={`${status.tasks.partitionsDone ?? 0}/${status.tasks.partitionsTotal ?? 0}`} hint="one task per spool partition" />
              <StatCard label="Shard tasks" value={`${status.tasks.shardsDone ?? 0}/${status.tasks.shardsTotal ?? 0}`} hint="one task per index shard" />
              <StatCard label="Spend estimate" value={accounting ? `$${accounting.estimatedUsd.toFixed(2)}` : "—"} hint={remaining === null ? "budget unknown" : `$${remaining.toFixed(2)} remaining of $${(accounting?.budgetUsd ?? 50).toFixed(0)}`} tone="muted" />
              <StatCard
                label="Failed / parked"
                value={`${status.tasks.failed} / ${status.tasks.parked}`}
                hint={status.errors.length ? status.errors[status.errors.length - 1]!.message.slice(0, 80) : "no errors reported"}
                tone={status.tasks.parked ? "accent" : "default"}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" className="gap-2" onClick={() => void pauseAndDrain()} disabled={busy !== null || !running}>
                <Pause className="size-4" /> {busy === "pause" ? "Pausing…" : "Pause & drain"}
              </Button>
              <Button variant="outline" className="gap-2" onClick={() => void resume()} disabled={busy !== null || !status || status.stage !== "paused"}>
                <Play className="size-4" /> {busy === "resume" ? "Resuming…" : `Resume with ${workers}`}
              </Button>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Users className="size-4" />
                <select
                  aria-label="Workers"
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={workers}
                  onChange={(event) => setWorkerChoice(Number(event.target.value))}
                  disabled={busy !== null}
                >
                  {WORKER_CHOICES.map((count) => (
                    <option key={count} value={count}>
                      {count} worker{count === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="outline" className="gap-2" onClick={() => void scale()} disabled={busy !== null || !running || workers === status.workersAuthorised}>
                <Users className="size-4" /> Apply workforce
              </Button>
              <Button variant="outline" className="gap-2" onClick={() => void stopContainers()} disabled={busy !== null || TERMINAL.has(status.stage)}>
                <Power className="size-4" /> Stop containers
              </Button>
              <Button variant="outline" className="gap-2 text-destructive" onClick={() => void abort()} disabled={busy !== null || TERMINAL.has(status.stage)}>
                <Square className="size-4" /> Abort job
              </Button>
              <span className="text-xs text-muted-foreground">
                Budget gates: $40 warning · $45 no new tasks · $50 pause. These are application guards over an estimate, not a Cloudflare billing cap.
              </span>
            </div>

            {shutdown ? <ShutdownReport summary={shutdown} /> : null}

            {status.errors.length ? (
              <ul className="space-y-1 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
                {status.errors.slice(-4).map((entry) => (
                  <li key={`${entry.at}-${entry.taskId}`}>
                    <span className="font-mono">{new Date(entry.at).toLocaleTimeString()}</span> {entry.taskId}: {entry.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {statusKnown ? `No parallel run yet. Starting one approves the full run, plans 256 partitions and pumps all ${WORKER_DEFAULT} containers.` : "Reading swarm status…"}
          </p>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Start full dataset indexing?</DialogTitle>
            <DialogDescription>
              This reads both source objects in full and builds a new generation. The current searchable dataset stays live until the new one is validated and
              activated.
            </DialogDescription>
          </DialogHeader>
          <SwarmConfirmFacts version={version.trim()} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button className="gap-2" onClick={() => void start()} disabled={busy !== null}>
              <Rocket className="size-4" /> {busy === "start" ? "Starting…" : "Confirm and start"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/**
 * The real answer to a stop request, worker by worker.
 *
 * The previous control could only say "pause recorded". This says which containers are
 * actually down, which refused, and whether the task each was holding went back to the
 * queue instead of being stranded on a container that no longer exists.
 */
export function ShutdownReport({ summary }: { summary: SwarmStopSummary }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-xs">
      <p className="font-medium">
        Container shutdown: {summary.stopped} of {summary.requested} succeeded
        {summary.failed ? ` · ${summary.failed} failed` : ""}
      </p>
      {summary.error ? <p className="mt-1 text-destructive">{summary.error}</p> : null}
      {summary.results.length ? (
        <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
          {summary.results.map((result) => (
            <li key={result.workerId} className={result.ok ? "text-muted-foreground" : "text-destructive"}>
              <span className="font-mono">{result.workerId}</span>{" "}
              {result.ok ? "stopped" : (result.error ?? "failed")}
              {result.releasedTaskId
                ? result.releaseConfirmed
                  ? ` · released ${result.releasedTaskId}`
                  : ` · ${result.releasedTaskId} left to lease expiry`
                : " · idle"}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Exactly what the operator is about to authorise.
 *
 * Exported so the confirmation's content is rendered (and asserted) on its own: a
 * dialog that fails to state the source objects, the container class, the partition
 * count or the budget gates is the one place this control must not be vague.
 */
export function SwarmConfirmFacts({ version }: { version: string }) {
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {SOURCE_FACTS.map((source) => (
          <div key={source.id} className="contents">
            <dt className="font-mono text-muted-foreground">{source.id}</dt>
            <dd>
              {source.key} · {source.size}
            </dd>
          </div>
        ))}
        <div className="contents">
          <dt className="text-muted-foreground">version</dt>
          <dd className="font-mono">{version}</dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">total</dt>
          <dd>≈64.26 GB across both files</dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">containers</dt>
          <dd>64 × Cloudflare standard-4 (4 vCPU / 12 GiB / 20 GB)</dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">partitions</dt>
          <dd>256 independent merge tasks, then 2,816 shard tasks</dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">budget</dt>
          <dd>$50 cumulative objective · $40 warning · $45 no new tasks · $50 automatic pause</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        The automatic budget pause stops the swarm at the next durable boundary; nothing is activated and the run resumes when you raise the limit or resume
        deliberately. The estimate is not a Cloudflare billing cap.
      </p>
    </div>
  );
}

