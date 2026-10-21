/**
 * REAL DATA provenance and the bounded direct-scan panel.
 *
 * The vocabulary here is deliberately literal because it is the product's honesty
 * contract:
 *
 *   REAL DATA              every record came from R2, never from a fixture;
 *   PARTIAL COVERAGE       only a measured prefix of the original files is indexed;
 *   SEARCH IN PROGRESS     a background job is reading ranges of the source files;
 *   SEARCH COMPLETE        the job's own bounded scope was processed.
 *
 * `SEARCH COMPLETE` is never rendered as "not found". A scan reads a budgeted
 * number of megabytes, so the panel always states how many bytes were read and
 * that records outside them may still exist.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleStop, Database, Loader2, Mail, Play, RefreshCw, ScanSearch, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRealDataCoverage } from "@/hooks/use-realdata";
import { ContactNumbers } from "@/components/contact-numbers";
import { cancelSourceScan, getSourceScan, startSourceScan } from "@/lib/api/realdata";
import { formatBytes, formatNumber, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  RealDataScanKind,
  RealDataScanResponse,
  RealDataScanResults,
  RealDataScanStatus,
  ScannedCompany,
  ScannedContact,
} from "@/shared/realdata/types";

function BytesLabel({ bytes }: { bytes: number }) {
  return <span className="tabular">{formatBytes(bytes)}</span>;
}

/**
 * Global provenance strip: what the current deployment can answer from, and how
 * much of the source corpus that represents. Renders nothing when the real-data
 * routes are not deployed (the local preview), so it cannot show sample numbers as
 * if they were R2 coverage.
 */
export function RealDataCoverageNotice({ className, compact = false }: { className?: string; compact?: boolean }) {
  const coverage = useRealDataCoverage();
  const data = coverage.data;
  if (!data) return null;

  if (data.dataOrigin === "none") {
    return (
      <div className={cn("surface flex flex-wrap items-center gap-3 px-4 py-3 text-xs", className)}>
        <Badge variant="outline" className="gap-1.5 border-amber-500/40 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3" />
          NO REAL DATA ACTIVE
        </Badge>
        <span className="text-muted-foreground">{data.message}</span>
      </div>
    );
  }

  const percent = data.coverage?.totals.coveragePercent ?? 0;
  return (
    <div className={cn("surface space-y-3 px-4 py-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="gap-1.5 border-emerald-600/30 bg-emerald-500/12 text-emerald-800 dark:text-emerald-300">
          <Database className="size-3" />
          REAL DATA
        </Badge>
        {data.partial ? (
          <Badge variant="outline" className="gap-1.5 border-amber-500/40 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-3" />
            PARTIAL COVERAGE
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1.5 border-emerald-600/40 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="size-3" />
            COMPLETE COVERAGE
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          version <span className="font-mono text-[11px]">{data.version}</span>
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {data.coverage?.lastRefreshAt ? `refreshed ${relativeTime(data.coverage.lastRefreshAt)}` : `checked ${relativeTime(data.checkedAt)}`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
        <span>
          <span className="tabular font-semibold text-foreground">{formatNumber(data.companies)}</span> companies
        </span>
        <span>
          <span className="tabular font-semibold text-foreground">{formatNumber(data.contacts)}</span> contacts
        </span>
        {data.coverage ? (
          <>
            <span>
              <BytesLabel bytes={data.coverage.totals.sourceBytesCovered} /> of{" "}
              <BytesLabel bytes={data.coverage.totals.sourceBytesTotal} /> source read
            </span>
            <span className="tabular">{percent < 1 ? percent.toFixed(4) : percent.toFixed(2)}% of corpus</span>
          </>
        ) : null}
        {data.coverage?.sources.map((source) => (
          <span key={source.id} className="text-muted-foreground">
            {source.key.replace("raw/", "")}: {formatBytes(source.bytesCovered)} · {formatNumber(source.recordsRead)} rows
          </span>
        ))}
      </div>

      {!compact ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Every record above is an original R2 row — no synthetic data. The remaining source bytes have not been indexed; a bounded
          source scan can look for a specific record outside this coverage, and the result always states what it searched.
        </p>
      ) : null}
    </div>
  );
}

function StatusPill({ state }: { state: RealDataScanStatus["state"] }) {
  if (state === "running" || state === "queued") {
    return (
      <Badge variant="outline" className="gap-1.5 border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300">
        <Loader2 className="size-3 animate-spin" />
        SEARCH IN PROGRESS
      </Badge>
    );
  }
  if (state === "complete") {
    return (
      <Badge variant="outline" className="gap-1.5 border-emerald-600/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300">
        <CheckCircle2 className="size-3" />
        SEARCH COMPLETE
      </Badge>
    );
  }
  if (state === "cancelled") {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground">
        <CircleStop className="size-3" />
        CANCELLED
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1.5 border-destructive/50 text-destructive">
      <AlertTriangle className="size-3" />
      SCAN FAILED
    </Badge>
  );
}

function ContactLine({ contact }: { contact: ScannedContact }) {
  return (
    <li className="flex flex-col gap-1 border-t border-border/50 py-2 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{contact.fullName}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {[contact.title ?? contact.designation, contact.seniority, contact.city ?? contact.country].filter(Boolean).join(" · ") ||
            "No title or location in the source row"}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {contact.email ? (
          <a className="inline-flex items-center gap-1 hover:text-foreground" href={`mailto:${contact.email}`}>
            <Mail className="size-3" />
            {contact.email}
          </a>
        ) : null}
        <ContactNumbers contact={contact} showLabels={false} copyable={false} />
        {contact.linkedinUrl ? (
          <a className="hover:text-foreground" href={contact.linkedinUrl} target="_blank" rel="noreferrer noopener">
            LinkedIn
          </a>
        ) : null}
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">row {formatNumber(contact.source.row)}</span>
      </div>
    </li>
  );
}

function ScannedCompanyCard({ company }: { company: ScannedCompany }) {
  const location = [company.city, company.state, company.country].filter(Boolean).join(", ");
  return (
    <li className="rounded-lg border border-border/70 bg-background/40 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{company.name}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {[company.industry, location].filter(Boolean).join(" · ") || "No industry or location in the source row"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {company.website ? (
            <a href={company.website} target="_blank" rel="noreferrer noopener" className="hover:text-foreground">
              {company.domain ?? "website"}
            </a>
          ) : company.domain ? (
            <span>{company.domain}</span>
          ) : null}
          <Badge variant="outline" className="text-[10px] font-normal">
            {company.contacts.length} contact{company.contacts.length === 1 ? "" : "s"}
          </Badge>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">row {formatNumber(company.source.row)}</span>
        </div>
      </div>
      {company.contacts.length ? (
        <ul className="mt-2">
          {company.contacts.map((contact) => (
            <ContactLine key={contact.id} contact={contact} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">
          No person row for this company appeared in the scanned window.
        </p>
      )}
    </li>
  );
}

function ScanResults({ results }: { results: RealDataScanResults }) {
  if (!results.companies.length && !results.contacts.length) return null;
  return (
    <div className="space-y-3">
      {results.companies.length ? (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Database className="size-3" /> Companies from the source
          </p>
          <ul className="space-y-2">
            {results.companies.map((company) => (
              <ScannedCompanyCard key={company.id} company={company} />
            ))}
          </ul>
        </div>
      ) : null}
      {results.contacts.length ? (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Users className="size-3" /> People from the source
          </p>
          <ul className="rounded-lg border border-border/70 bg-background/40 px-3 py-1">
            {results.contacts.map((contact) => (
              <ContactLine key={contact.id} contact={contact} />
            ))}
          </ul>
        </div>
      ) : null}
      {results.truncated ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          The result limit was reached, so not every match in this window is listed. Narrow the query to see others.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Start or follow one bounded source scan for `query`.
 *
 * A scan is started only on an explicit click: searching the index never triggers
 * a source read, so a new query costs nothing beyond the index objects it needs.
 */
export function SourceScanPanel({
  query,
  kind = "both",
  className,
  defaultOpen = false,
}: {
  query: string;
  kind?: RealDataScanKind;
  className?: string;
  defaultOpen?: boolean;
}) {
  const coverage = useRealDataCoverage();
  const [open, setOpen] = useState(defaultOpen);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<RealDataScanStatus | null>(null);
  const [results, setResults] = useState<RealDataScanResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cacheHit, setCacheHit] = useState(false);
  const pollRef = useRef<number | null>(null);

  const available = coverage.data?.directScan === true;
  const budget = coverage.data?.scanBudgetMb ?? 48;
  const terminal = status?.state === "complete" || status?.state === "cancelled" || status?.state === "failed";

  // Poll while a job is live. The interval is cleared on unmount and on a terminal
  // state; a new job id re-runs the effect, which is what "Scan again" produces.
  useEffect(() => {
    if (!jobId) return;
    let cancelledFlag = false;
    let delay = 1200;
    const poll = async () => {
      try {
        const response: RealDataScanResponse = await getSourceScan(jobId);
        if (cancelledFlag) return;
        setStatus(response.status);
        setResults(response.results);
        setCacheHit(response.cacheHit);
        setError(null);
        if (response.status.state === "running" || response.status.state === "queued") {
          delay = Math.min(4000, Math.round(delay * 1.25));
          pollRef.current = window.setTimeout(poll, delay);
        } else {
          pollRef.current = null;
        }
      } catch (cause) {
        if (cancelledFlag) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        pollRef.current = window.setTimeout(poll, 4000);
      }
    };
    pollRef.current = window.setTimeout(poll, 600);
    return () => {
      cancelledFlag = true;
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
      pollRef.current = null;
    };
  }, [jobId]);

  async function start(force = false) {
    const trimmed = query.trim();
    if (!trimmed) return;
    setStarting(true);
    setError(null);
    setStatus(null);
    setResults(null);
    try {
      const response = await startSourceScan({ q: trimmed, kind, force });
      setCacheHit(Boolean(response.cacheHit));
      if (response.cached) {
        setJobId(response.jobId);
        setStatus(response.cached.status);
        setResults(response.cached.results);
      } else {
        setJobId(response.jobId);
        setStatus({
          format: 1,
          jobId: response.jobId,
          query: trimmed,
          normalizedQuery: trimmed.toLowerCase(),
          kind,
          state: response.state,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sources: [],
          totals: { bytesScanned: 0, bytesTotal: 0, coveragePercent: 0, recordsScanned: 0, companies: 0, contacts: 0, dropped: 0 },
          limit: 50,
          maxMbPerSource: budget,
          datasetVersion: coverage.data?.version ?? "unknown",
          complete: false,
          reason: response.message,
        });
      }
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setOpen(true);
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!jobId) return;
    try {
      await cancelSourceScan(jobId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!coverage.data || !coverage.data.partial || !available) return null;

  const scanned = status?.totals.bytesScanned ?? 0;
  const budgetBytes = (status?.maxMbPerSource ?? budget) * 1024 * 1024;
  const budgetPercent = budgetBytes ? Math.min(100, (scanned / (budgetBytes * 2)) * 100) : 0;
  const running = status?.state === "running" || status?.state === "queued" || starting;

  return (
    <section className={cn("surface overflow-hidden", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-3">
        <ScanSearch className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Search the original source files</h3>
        {status ? <StatusPill state={status.state} /> : null}
        {cacheHit ? (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
            cached result
          </Badge>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">bounded · {budget} MB per source · max 100 results</span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {open
            ? "A background job reads ranged slices of raw/file1.csv and raw/file2.csv on Cloudflare, parses records with the same reader as the indexer, and streams matches back. It never loads the file into memory and it stops at the byte budget."
            : "Only part of the 64 GB corpus is indexed. Run a bounded scan of the original R2 files for this query; it reports exactly how many bytes it read."}
        </p>

        {!open ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="gap-2" onClick={() => void start(false)} disabled={starting || !query.trim()}>
              {starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Scan source files
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              What does this do?
            </Button>
          </div>
        ) : (
          <>
            {status?.sources?.length ? (
              <div className="space-y-2">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${Math.max(2, budgetPercent)}%` }} />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>
                    scanned <BytesLabel bytes={scanned} /> of {status.maxMbPerSource * 2} MB budget
                  </span>
                  <span>
                    corpus coverage <span className="tabular">{status.totals.coveragePercent.toFixed(4)}%</span> of {formatBytes(status.totals.bytesTotal)}
                  </span>
                  <span>{formatNumber(status.totals.recordsScanned)} source rows read</span>
                  <span>{formatNumber(status.totals.companies)} companies · {formatNumber(status.totals.contacts)} contacts matched</span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground/80">
                  {status.sources.map((source) => (
                    <span key={source.id}>
                      {source.key.replace("raw/", "")}: {formatBytes(source.bytesScanned)} · {formatNumber(source.recordsRead)} rows
                      {source.complete ? " · done" : ""}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {running ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="gap-2" onClick={() => void cancel()}>
                  <CircleStop className="size-4" />
                  Cancel scan
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Results appear as the scan proceeds. The job keeps running if this page is closed; reopen the same query to follow it.
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="gap-2" onClick={() => void start(true)} disabled={!query.trim()}>
                  <RefreshCw className="size-4" />
                  Scan again
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  A completed result is cached per dataset version, so repeating it costs no source reads.
                </span>
              </div>
            )}

            {status?.reason ? <p className="text-[11px] text-muted-foreground">{status.reason}</p> : null}
            {status?.error ? <p className="text-[11px] text-destructive">{status.error}</p> : null}

            {results ? <ScanResults results={results} /> : null}

            {terminal && !running ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
                {results && (results.companies.length || results.contacts.length)
                  ? "These records are outside the activated index coverage. They are shown from the direct scan only; open the indexed record when one exists for the full profile."
                  : `No match in the ${formatBytes(scanned)} scanned. This is not proof the record does not exist: ${formatBytes(
                      Math.max(0, (status?.totals.bytesTotal ?? 0) - scanned),
                    )} of source data were outside this scan.`}
              </p>
            ) : null}
            {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
          </>
        )}
      </div>
    </section>
  );
}

/** Small inline label used next to indexed results. */
export function RealDataOriginBadge({ origin }: { origin: "index" | "scan" | "cache" }) {
  const label = origin === "index" ? "INDEXED" : origin === "cache" ? "CACHED SCAN" : "DIRECT SCAN";
  return (
    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
      {label}
    </Badge>
  );
}
