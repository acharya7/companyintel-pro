/**
 * Shared presentational building blocks.
 *
 * Kept in one module on purpose: these are small, purely visual pieces that
 * every screen composes, and a single file keeps their spacing and typography
 * consistent across the application.
 */

import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronLeft, ChevronRight, Database, Info, Loader2, RefreshCw } from "lucide-react";
import { matchCategoryLabel } from "@/lib/format";
import type { MatchCategory } from "@/shared/models";
import type { DatasetMode } from "@/lib/api/types";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-border/70 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        {eyebrow ? (
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{eyebrow}</p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.7rem]">{title}</h1>
        {description ? <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "muted" | "accent";
}) {
  return (
    <div className={cn("surface p-4 sm:p-5", tone === "muted" && "bg-muted/40")}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
        {icon ? <span className="text-muted-foreground/70">{icon}</span> : null}
      </div>
      <p className={cn("tabular mt-3 text-2xl font-semibold tracking-tight", tone === "accent" && "text-primary")}>
        {value}
      </p>
      {hint ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("surface overflow-hidden", className)}>
      <div className="flex flex-col gap-3 border-b border-border/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-lg border border-dashed border-border/80 bg-muted/25 px-6 py-12 text-center", className)}>
      <div className="flex size-11 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
        {icon ?? <Info className="size-5" />}
      </div>
      <p className="mt-4 text-sm font-medium">{title}</p>
      {description ? <p className="mt-1.5 max-w-md text-xs leading-5 text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function LoadingBlock({ label = "Loading", rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {label}…
      </p>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="size-4" />
        Request failed
      </p>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{error.message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-3 gap-2" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Shown whenever the active dataset is the synthetic sample, never hidden. */
export function SampleDataBanner({ message }: { message?: string }) {
  return <DatasetModeBanner mode="demo" detail={message} />;
}

/**
 * States what the application is actually serving.
 *
 * One banner for all three modes, so "demo", "live" and "nothing published yet"
 * can never be confused with each other — and a bucket that happens to be
 * reachable is never labelled as real data.
 */
export function DatasetModeBanner({
  mode,
  detail,
  action,
}: {
  mode: DatasetMode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  const copy: Record<DatasetMode, { title: string; body: string; tone: string; icon: ReactNode }> = {
    demo: {
      title: "Demo mode — bundled sample data",
      body: "The synthetic dataset is serving this preview. Nothing on screen is read from your Cloudflare R2 bucket.",
      tone: "border-chart-3/40 bg-chart-3/10 text-chart-3",
      icon: <Database className="mt-0.5 size-4 shrink-0" />,
    },
    real: {
      title: "REAL DATA — published R2 index",
      body: "Results come from the active index version published in company-intel-data; the coverage label above states how much of the source corpus it represents.",
      tone: "border-chart-2/40 bg-chart-2/10 text-chart-2",
      icon: <Database className="mt-0.5 size-4 shrink-0" />,
    },
    "no-dataset": {
      title: "No dataset indexed",
      body: "No validated index version has been published to R2 yet, so there are no real records to search.",
      tone: "border-chart-3/50 bg-chart-3/[0.07] text-chart-3",
      icon: <AlertTriangle className="mt-0.5 size-4 shrink-0" />,
    },
  };
  const item = copy[mode];
  return (
    <div
      className={cn("flex items-start gap-3 rounded-lg border px-4 py-3", item.tone)}
      data-dataset-mode={mode}
      role="status"
    >
      {item.icon}
      <div className="text-xs leading-5">
        <p className="font-medium text-foreground">{item.title}</p>
        <p className="text-muted-foreground">{detail ?? item.body}</p>
      </div>
      {action ? <div className="ml-auto shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

const MATCH_TONES: Record<MatchCategory, string> = {
  exact: "border-primary/30 bg-primary/10 text-primary",
  alias: "border-chart-2/40 bg-chart-2/10 text-chart-2",
  prefix: "border-border bg-muted text-foreground",
  typo: "border-chart-3/50 bg-chart-3/12 text-chart-3",
  similar: "border-border bg-muted/60 text-muted-foreground",
};

export function MatchBadge({ category, relevance, possible }: { category: MatchCategory; relevance: number; possible: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", MATCH_TONES[category])}>
        {matchCategoryLabel(category)}
      </span>
      <span className="tabular text-[11px] text-muted-foreground">{relevance.toFixed(3)}</span>
      {possible ? (
        <Badge variant="outline" className="text-[11px] font-normal text-muted-foreground">
          Possible match
        </Badge>
      ) : null}
    </div>
  );
}

export function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        ok ? "border-chart-2/40 bg-chart-2/10 text-chart-2" : "border-chart-3/50 bg-chart-3/12 text-chart-3",
      )}
    >
      <span className={cn("size-1.5 rounded-full", ok ? "bg-chart-2" : "bg-chart-3")} />
      {label}
    </span>
  );
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-48 shrink-0 text-xs uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/**
 * A value that can be long — a 3 KB company description, a JSON blob column.
 *
 * The source value is stored and delivered whole (the indexer never truncates), so
 * this only decides how much of it is on screen: a collapsed preview with the real
 * character count, and a toggle that shows every character. Nothing is lost — the
 * copy button copies the full value, not the preview.
 */
export function LongText({ text, limit = 280 }: { text: string; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= limit) return <>{text}</>;
  return (
    <span className="block">
      <span className="block whitespace-pre-wrap break-words">{expanded ? text : `${text.slice(0, limit)}…`}</span>
      <button
        type="button"
        className="mt-1 text-xs font-medium text-primary hover:underline"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
      </button>
    </span>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  hasMore,
  totalIsLowerBound,
  onPage,
  onPageSize,
  pageSizeOptions = [10, 25, 50, 100],
}: {
  page: number;
  pageSize: number;
  total: number | null;
  hasMore: boolean;
  totalIsLowerBound?: boolean;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  pageSizeOptions?: number[];
}) {
  const start = total === null ? (page - 1) * pageSize + 1 : total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = (page - 1) * pageSize + pageSize;
  return (
    <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <p className="tabular">
        {total === null ? `Showing ${start}–${end}` : total === 0 ? "No results" : `Showing ${start}–${Math.min(end, total)} of ${total}${totalIsLowerBound ? "+" : ""}`}
        {" · page "}
        {page}
      </p>
      <div className="flex items-center gap-2">
        {onPageSize ? (
          <label className="flex items-center gap-2">
            <span className="hidden sm:inline">Rows</span>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={pageSize}
              onChange={(event) => onPageSize(Number(event.target.value))}
              aria-label="Rows per page"
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button variant="outline" size="sm" className="gap-1" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-3.5" />
          Previous
        </Button>
        <Button variant="outline" size="sm" className="gap-1" disabled={!hasMore} onClick={() => onPage(page + 1)}>
          Next
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function FacetList({
  title,
  buckets,
  selected,
  onSelect,
  emptyLabel = "No values available",
}: {
  title: string;
  buckets: { value: string; count: number }[];
  selected?: string;
  onSelect: (value: string | undefined) => void;
  emptyLabel?: string;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">{title}</p>
      {buckets.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 max-h-60 space-y-0.5 overflow-y-auto pr-1">
          {buckets.slice(0, 40).map((bucket) => {
            const active = selected === bucket.value;
            return (
              <li key={bucket.value}>
                <button
                  type="button"
                  onClick={() => onSelect(active ? undefined : bucket.value)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    active ? "bg-primary/10 text-primary" : "hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <span className="truncate">{bucket.value}</span>
                  <span className="tabular shrink-0 text-[11px] text-muted-foreground">{bucket.count}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Simple horizontal bar list — used where a chart would be overkill. */
export function BarList({ buckets, max = 8, unit = "" }: { buckets: { value: string; count: number }[]; max?: number; unit?: string }) {
  const rows = buckets.slice(0, max);
  const peak = rows.reduce((highest, row) => Math.max(highest, row.count), 0) || 1;
  if (!rows.length) return <p className="text-xs text-muted-foreground">No data available.</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.value}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate font-medium">{row.value}</span>
            <span className="tabular text-muted-foreground">
              {row.count.toLocaleString("en-US")}
              {unit}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary/80" style={{ width: `${(row.count / peak) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CardShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card className={cn("border-border/70 shadow-none", className)}>
      <CardContent className="p-5">{children}</CardContent>
    </Card>
  );
}
