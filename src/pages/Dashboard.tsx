/**
 * Dashboard.
 *
 * Every number here is read from a stored manifest or from real application
 * data. When no dataset version is active the screen says so plainly instead of
 * showing invented statistics.
 */

import { Link } from "react-router";
import {
  Activity,
  ArrowRight,
  Building2,
  Database,
  FileDown,
  Layers,
  Search,
  Star,
  TrendingUp,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BarList, EmptyState, ErrorBlock, LoadingBlock, PageHeader, Section, StatCard } from "@/components/common";
import { useActivity, useDatasetStats, useDatasetStatus, useLeads, useSavedSearches, apiMode } from "@/hooks/use-api";
import { formatBytes, formatCompact, formatNumber, relativeTime } from "@/lib/format";
import { readRecentCompanies } from "@/lib/recent";
import { RealDataCoverageNotice } from "@/components/realdata";
import { LEAD_STATUSES } from "@/shared/models";

export default function Dashboard() {
  const status = useDatasetStatus();
  const stats = useDatasetStats(Boolean(status.data?.indexed || status.data?.dataOrigin === "sample"));
  const leads = useLeads();
  const searches = useSavedSearches();
  const activity = useActivity();

  const savedCompanies = (leads.data?.leads ?? []).filter((lead) => lead.kind === "company");
  const savedContacts = (leads.data?.leads ?? []).filter((lead) => lead.kind === "contact");
  const recentCompanies = readRecentCompanies();
  const activeVersion = status.data?.versions.find((version) => version.version === status.data?.activeVersion);

  if (status.isLoading) {
    return (
      <>
        <PageHeader title="Dashboard" description="Loading dataset state…" />
        <LoadingBlock label="Reading dataset manifests" rows={6} />
      </>
    );
  }

  if (status.error) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorBlock error={status.error as Error} onRetry={() => status.refetch()} />
      </>
    );
  }

  const indexed = Boolean(status.data?.indexed);
  const sample = status.data?.dataOrigin === "sample";

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Dashboard"
        description="Dataset health, search activity and your saved pipeline in one place."
        actions={
          <>
            <Button variant="outline" className="gap-2" asChild>
              <Link to="/companies">
                <Search className="size-4" />
                Company search
              </Link>
            </Button>
            <Button className="gap-2" asChild>
              <Link to="/leads">
                <Star className="size-4" />
                Saved leads
              </Link>
            </Button>
          </>
        }
      />

      <RealDataCoverageNotice className="mb-4" />

      {!indexed ? (
        <div className="surface border-chart-3/40 bg-chart-3/[0.06] p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-chart-3/15 text-chart-3">
                <Database className="size-4" />
              </span>
              <div>
                <p className="text-sm font-semibold">Dataset not indexed</p>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{status.data?.message}</p>
                {status.data?.bucketError ? (
                  <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{status.data.bucketError}</p>
                ) : null}
              </div>
            </div>
            <Button variant="outline" size="sm" className="gap-2" asChild>
              <Link to="/dataset">
                Dataset management
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Indexed companies"
          value={stats.data ? formatNumber(stats.data.companies) : "—"}
          hint={stats.data ? (sample ? "Sample dataset only" : `Version ${stats.data.version}`) : "Statistics not generated yet"}
          icon={<Building2 className="size-4" />}
        />
        <StatCard
          label="Indexed contacts"
          value={stats.data ? formatNumber(stats.data.contacts) : "—"}
          hint={
            stats.data
              ? `Email available on ${formatNumber(stats.data.contactCoverage.email)} contacts`
              : "Statistics not generated yet"
          }
          icon={<Users className="size-4" />}
        />
        <StatCard
          label="Active dataset version"
          value={status.data?.activeVersion ?? "none"}
          hint={status.data?.lastIndexedAt ? `Published ${relativeTime(status.data.lastIndexedAt)}` : "Nothing published yet"}
          icon={<Layers className="size-4" />}
        />
        <StatCard
          label="Index size"
          value={activeVersion ? formatBytes(activeVersion.bytes) : "—"}
          hint={
            activeVersion
              ? `${formatNumber(activeVersion.objectCount)} objects · ${formatNumber(activeVersion.counters.rowsRead)} source rows read`
              : "No version published"
          }
          icon={<TrendingUp className="size-4" />}
        />
        <StatCard label="Saved companies" value={formatNumber(savedCompanies.length)} hint="Company leads in your pipeline" icon={<Star className="size-4" />} />
        <StatCard label="Saved contacts" value={formatNumber(savedContacts.length)} hint="Individual people saved as leads" icon={<Users className="size-4" />} />
        <StatCard label="Saved searches" value={formatNumber(searches.data?.length ?? 0)} hint="Reusable queries" icon={<Search className="size-4" />} />
        <StatCard
          label="Data source"
          value={sample ? "Sample" : indexed ? "R2 index" : "Not indexed"}
          hint={sample ? "Synthetic preview dataset — never production data" : `API mode: ${apiMode}`}
          icon={<Database className="size-4" />}
          tone={sample ? "accent" : "default"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="Contacts by designation" description="Top ten designations across indexed contacts" className="lg:col-span-1">
          {stats.data ? (
            <BarList buckets={stats.data.contactsByDesignation} max={10} />
          ) : (
            <EmptyState
              title="No statistics yet"
              description="Charts appear once a dataset version has been indexed and its statistics object written."
            />
          )}
        </Section>

        <Section title="Companies by industry" description="Top ten industries in the active dataset" className="lg:col-span-1">
          {stats.data ? (
            <BarList buckets={stats.data.companiesByIndustry} max={10} />
          ) : (
            <EmptyState title="No statistics yet" description="Industry distribution is computed by the indexer." />
          )}
        </Section>

        <Section title="Companies by country" description="Top ten countries in the active dataset" className="lg:col-span-1">
          {stats.data ? (
            <BarList buckets={stats.data.companiesByCountry} max={10} />
          ) : (
            <EmptyState title="No statistics yet" description="Country distribution is computed by the indexer." />
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Datasets and search activity"
          description="Recent searches, saved searches and recently viewed companies"
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link to="/saved-searches">All saved searches</Link>
            </Button>
          }
        >
          <div className="space-y-6">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">Recent searches</p>
              {(activity.data ?? []).filter((entry) => entry.kind === "search").length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No searches recorded yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {(activity.data ?? [])
                    .filter((entry) => entry.kind === "search")
                    .slice(0, 5)
                    .map((entry) => (
                      <li key={entry.id} className="flex items-center justify-between gap-3 text-sm">
                        <Link to={entry.href ?? "/companies"} className="truncate hover:text-primary">
                          {entry.label}
                        </Link>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(entry.at)}</span>
                      </li>
                    ))}
                </ul>
              )}
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">Saved searches</p>
              {(searches.data ?? []).length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No saved searches yet — run a search and save it.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {(searches.data ?? []).slice(0, 4).map((search) => (
                    <li key={search.id} className="flex items-center justify-between gap-3 text-sm">
                      <Link to={`/companies?q=${encodeURIComponent(search.query)}`} className="truncate hover:text-primary">
                        {search.name}
                      </Link>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {search.runCount} runs{search.lastRunAt ? ` · ${relativeTime(search.lastRunAt)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">Recently viewed companies</p>
              {recentCompanies.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">Companies you open will appear here.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {recentCompanies.slice(0, 5).map((company) => (
                    <li key={company.id} className="flex items-center justify-between gap-3 text-sm">
                      <Link to={`/companies/${company.id}`} className="truncate hover:text-primary">
                        {company.name}
                      </Link>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(company.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>

        <div className="space-y-6">
          <Section title="Dataset health" description="Verified state of the active index">
            <dl className="divide-y divide-border/60">
              <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                <dt className="text-muted-foreground">Source files detected</dt>
                <dd className="tabular">
                  {status.data?.sources.filter((source) => source.verified).length ?? 0} / {status.data?.sources.length ?? 0} verified
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                <dt className="text-muted-foreground">Index status</dt>
                <dd>{indexed ? "Published" : sample ? "Sample only" : "Not indexed"}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                <dt className="text-muted-foreground">Active version</dt>
                <dd className="tabular">{status.data?.activeVersion ?? "—"}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                <dt className="text-muted-foreground">Companies / contacts indexed</dt>
                <dd className="tabular">
                  {stats.data ? `${formatCompact(stats.data.companies)} / ${formatCompact(stats.data.contacts)}` : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                <dt className="text-muted-foreground">Rejected rows</dt>
                <dd className="tabular">{activeVersion ? formatNumber(activeVersion.counters.rowsRejected) : "—"}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                <dt className="text-muted-foreground">Last verification</dt>
                <dd>{activeVersion?.validationPassed ? "Passed" : "Not verified"}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/dataset">Open dataset management</Link>
              </Button>
            </div>
          </Section>

          <Section
            title="Recent activity"
            description="Searches, views, saved leads and exports"
            actions={
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => activity.refetch()}>
                <Activity className="size-3.5" />
                Refresh
              </Button>
            }
          >
            {(activity.data ?? []).length === 0 ? (
              <EmptyState title="No activity yet" description="Activity is recorded when you search, open a company, save a lead or run an export." />
            ) : (
              <ul className="space-y-2.5">
                {(activity.data ?? []).slice(0, 8).map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 text-sm">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      {entry.kind === "export" ? (
                        <FileDown className="size-3" />
                      ) : entry.kind === "lead-saved" ? (
                        <Star className="size-3" />
                      ) : entry.kind === "company-view" ? (
                        <Building2 className="size-3" />
                      ) : (
                        <Search className="size-3" />
                      )}
                    </span>
                    <div className="min-w-0">
                      {entry.href ? (
                        <Link to={entry.href} className="truncate font-medium hover:text-primary">
                          {entry.label}
                        </Link>
                      ) : (
                        <p className="truncate font-medium">{entry.label}</p>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        {entry.detail ? `${entry.detail} · ` : ""}
                        {relativeTime(entry.at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      <Section title="Pipeline snapshot" description="Saved leads by status">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {LEAD_STATUSES.map((statusKey) => {
            const count = (leads.data?.leads ?? []).filter((lead) => lead.status === statusKey).length;
            return (
              <div key={statusKey} className="rounded-lg border border-border/70 bg-muted/25 p-3">
                <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                  {statusKey.replace("-", " ")}
                </p>
                <p className="tabular mt-1.5 text-lg font-semibold">{count}</p>
              </div>
            );
          })}
        </div>
        {(leads.data?.total ?? 0) === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="No saved leads yet"
              description="Save a company or a contact from search results, then track it here by status, tags and notes."
              action={
                <Button asChild>
                  <Link to="/companies">Find companies</Link>
                </Button>
              }
            />
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="outline" className="font-normal">
              {formatNumber(leads.data?.total ?? 0)} leads total
            </Badge>
            {(searches.data?.length ?? 0) > 0 ? (
              <Badge variant="outline" className="font-normal">
                {formatNumber(searches.data?.length ?? 0)} saved searches
              </Badge>
            ) : null}
          </div>
        )}
      </Section>
    </>
  );
}
