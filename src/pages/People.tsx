/**
 * Find People — global person search.
 *
 * The query goes to `/api/contacts/search`, which searches the full contact name
 * index (86 M+ people in the active generation) and hydrates a bounded page. The
 * filters offered here are refinements of the returned page and say so: a field
 * that is not part of the name index cannot be applied globally, and pretending
 * otherwise would turn "no results" into a lie.
 *
 * Every value on screen comes from the indexed records. A field the source does
 * not carry is shown as unavailable, never filled in.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  ArrowUpRight,
  Building2,
  Check,
  Copy,
  Linkedin,
  Mail,
  MapPin,
  Search,
  Star,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader, Pager } from "@/components/common";
import { useContactSearch, useSaveLead } from "@/hooks/use-api";
import { useRealDataCoverage } from "@/hooks/use-realdata";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import type { ContactSearchHit } from "@/shared/models";

const CONFIDENCE_COPY: Record<string, { label: string; tone: string }> = {
  high_confidence: { label: "Confirmed", tone: "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  plausible: { label: "Likely", tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  unresolved: { label: "Unconfirmed", tone: "border-border bg-muted text-muted-foreground" },
  conflicting: { label: "Conflicting", tone: "border-destructive/30 bg-destructive/10 text-destructive" },
};

function confidenceOf(hit: ContactSearchHit): string {
  if (hit.employerUnconfirmed) return hit.association ?? "unresolved";
  return hit.association ?? "high_confidence";
}

function locationOf(hit: ContactSearchHit): string {
  return [hit.city, hit.country].filter(Boolean).join(", ");
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`);
  } catch {
    toast.error("Clipboard access was denied by the browser.");
  }
}

function ConfidenceBadge({ hit }: { hit: ContactSearchHit }) {
  const key = confidenceOf(hit);
  const copy = CONFIDENCE_COPY[key] ?? CONFIDENCE_COPY.unresolved!;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", copy.tone)}>
      <Check className="size-2.5" />
      {copy.label}
    </span>
  );
}

function PersonDrawer({
  hit,
  datasetVersion,
  onClose,
  onSaved,
}: {
  hit: ContactSearchHit;
  datasetVersion: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const saveLead = useSaveLead();
  const linkedin = hit.linkedinUrl;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${hit.fullName} details`}>
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/35 backdrop-blur-[1px] motion-safe:animate-in motion-safe:fade-in"
        aria-label="Close details"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200">
        <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-border/70 bg-card/95 px-5 py-4 backdrop-blur">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {initials(hit.fullName) || <UserRound className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold tracking-tight">{hit.fullName || "Unnamed contact"}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {hit.designation ?? hit.title ?? "Designation not recorded"}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="Close details">
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <ConfidenceBadge hit={hit} />
            {hit.companyId ? (
              <Badge variant="outline" className="gap-1 font-normal">
                <Building2 className="size-3" />
                {hit.companyName}
              </Badge>
            ) : (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                No confirmed employer
              </Badge>
            )}
          </div>

          <dl className="divide-y divide-border/60 text-sm">
            <div className="flex items-start justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="min-w-0 text-right">
                {hit.email ? (
                  <button type="button" onClick={() => void copy(hit.email!, "Email")} className="inline-flex items-center gap-1.5 break-all hover:text-primary">
                    {hit.email}
                    <Copy className="size-3 shrink-0" />
                  </button>
                ) : (
                  <span className="text-muted-foreground">Not available</span>
                )}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">LinkedIn</dt>
              <dd className="min-w-0 text-right">
                {linkedin ? (
                  <span className="inline-flex items-center gap-2">
                    <a href={linkedin} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">
                      Profile
                    </a>
                    <button type="button" onClick={() => void copy(linkedin, "LinkedIn URL")} aria-label="Copy LinkedIn URL">
                      <Copy className="size-3" />
                    </button>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not available</span>
                )}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="text-right">{hit.phone ?? hit.mobile ?? <span className="text-muted-foreground">Not available</span>}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Location</dt>
              <dd className="text-right">{locationOf(hit) || <span className="text-muted-foreground">Not recorded</span>}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Department</dt>
              <dd className="text-right">{hit.department ?? <span className="text-muted-foreground">Not recorded</span>}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Seniority</dt>
              <dd className="text-right">{hit.seniority ?? <span className="text-muted-foreground">Not recorded</span>}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Record id</dt>
              <dd className="tabular text-right text-xs">{hit.id}</dd>
            </div>
          </dl>

          <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-[11px] leading-5 text-muted-foreground">
            <p className="font-medium text-foreground">Company association evidence</p>
            <p className="mt-1">
              {hit.association === "high_confidence"
                ? "The record carries employer identity or an email domain that matches the assigned company."
                : hit.association === "plausible"
                  ? "The employer is inferred from the source row; the email domain did not independently confirm it."
                  : "No employer could be confirmed from the row, so the person is preserved without a confirmed company."}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              className="gap-2"
              disabled={saveLead.isPending}
              onClick={() =>
                saveLead.mutate(
                  {
                    kind: "contact",
                    targetId: hit.id,
                    datasetVersion,
                    snapshot: {
                      fullName: hit.fullName,
                      title: hit.designation ?? hit.title ?? "",
                      companyId: hit.companyId ?? "",
                      companyName: hit.companyName ?? "",
                      email: hit.email ?? "",
                      linkedinUrl: hit.linkedinUrl ?? "",
                    },
                  },
                  { onSuccess: onSaved },
                )
              }
            >
              <Star className="size-4" />
              Save lead
            </Button>
            <Button variant="outline" className="gap-2" asChild>
              <Link to={`/contacts/${encodeURIComponent(hit.id)}`}>
                Open full record
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}

export default function People() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(params.get("pageSize") ?? 25) || 25));
  // The input follows the URL unless the operator is mid-typing. Tagging the
  // draft with the query it was typed against avoids copying the URL into state
  // from an effect (which would add a render on every navigation).
  const [typed, setTyped] = useState<{ q: string; value: string } | null>(null);
  const draft = typed && typed.q === query ? typed.value : query;
  const setDraft = (value: string) => setTyped({ q: query, value });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<ContactSearchHit | null>(null);
  const [refine, setRefine] = useState({ hasEmail: false, hasLinkedin: false, confirmedOnly: false, location: "" });
  const coverage = useRealDataCoverage();
  const search = useContactSearch({ query, page, pageSize });

  function update(patch: Record<string, string | number | undefined>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") next.delete(key);
      else next.set(key, String(value));
    }
    if (patch.q !== undefined) next.delete("page");
    setParams(next, { replace: true });
  }

  const hits = useMemo(() => search.data?.hits ?? [], [search.data]);
  const filtered = useMemo(() => {
    const term = refine.location.trim().toLowerCase();
    return hits.filter((hit) => {
      if (refine.hasEmail && !hit.email) return false;
      if (refine.hasLinkedin && !hit.linkedinUrl) return false;
      if (refine.confirmedOnly && hit.employerUnconfirmed) return false;
      if (term && !(`${hit.city ?? ""} ${hit.country ?? ""}`.toLowerCase().includes(term))) return false;
      return true;
    });
  }, [hits, refine]);

  const activeFilters = Number(refine.hasEmail) + Number(refine.hasLinkedin) + Number(refine.confirmedOnly) + Number(Boolean(refine.location));
  const datasetVersion = search.data?.datasetVersion ?? coverage.data?.version ?? "unknown";
  const coverageComplete = coverage.data?.coverageStatus === "complete";

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="Prospecting"
        title="Find people"
        description="Search the full indexed contact population by name — exact, partial or misspelled — then open a person to see the employer evidence behind the record."
        actions={
          coverage.data ? (
            <Badge variant="outline" className="font-normal">
              {coverageComplete ? "Complete coverage" : "Coverage " + (coverage.data.coverageStatus ?? "unknown")} ·{" "}
              {formatNumber(coverage.data.contacts)} contacts
            </Badge>
          ) : null
        }
      />

      <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="surface h-fit p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Filters</p>
            {activeFilters ? (
              <button
                type="button"
                className="text-[11px] font-medium text-primary hover:underline"
                onClick={() => setRefine({ hasEmail: false, hasLinkedin: false, confirmedOnly: false, location: "" })}
              >
                Clear
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            Applied to the results of the current query. Name matching itself always searches the full index.
          </p>
          <div className="mt-4 space-y-3">
            <label className="flex items-center justify-between gap-2 text-xs">
              <span>Email available</span>
              <Checkbox checked={refine.hasEmail} onCheckedChange={(checked) => setRefine((r) => ({ ...r, hasEmail: Boolean(checked) }))} />
            </label>
            <label className="flex items-center justify-between gap-2 text-xs">
              <span>LinkedIn available</span>
              <Checkbox checked={refine.hasLinkedin} onCheckedChange={(checked) => setRefine((r) => ({ ...r, hasLinkedin: Boolean(checked) }))} />
            </label>
            <label className="flex items-center justify-between gap-2 text-xs">
              <span>Confirmed employer</span>
              <Checkbox checked={refine.confirmedOnly} onCheckedChange={(checked) => setRefine((r) => ({ ...r, confirmedOnly: Boolean(checked) }))} />
            </label>
            <div className="space-y-1.5 pt-1">
              <Label htmlFor="refine-location" className="text-xs">
                City or country
              </Label>
              <Input
                id="refine-location"
                value={refine.location}
                onChange={(event) => setRefine((r) => ({ ...r, location: event.target.value }))}
                placeholder="e.g. London"
                className="h-8 text-xs"
              />
            </div>
          </div>
        </aside>

        <div className="min-w-0 space-y-4">
          <form
            className="surface flex flex-col gap-2 p-3 sm:flex-row sm:items-center"
            onSubmit={(event) => {
              event.preventDefault();
              const value = draft.trim();
              if (!value) return;
              setSelected(new Set());
              update({ q: value, page: undefined });
            }}
            role="search"
          >
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Search people by name — partial names and typos are supported"
                className="h-9 pl-9"
                aria-label="Search people by name"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" className="gap-2">
                <Search className="size-3.5" />
                Search
              </Button>
              {query ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="gap-1.5 text-muted-foreground"
                  onClick={() => {
                    setDraft("");
                    setParams(new URLSearchParams(), { replace: true });
                  }}
                >
                  <X className="size-3.5" />
                  Clear
                </Button>
              ) : null}
            </div>
          </form>

          {search.error ? (
            <ErrorBlock error={search.error as Error} onRetry={() => void search.refetch()} />
          ) : !query ? (
            <EmptyState
              icon={<Users className="size-5" />}
              title="Search people across the full index"
              description="Type a full name, a last name, a partial name or a spelling you are unsure about. Results include the associated company and the evidence behind that association."
            />
          ) : search.isLoading ? (
            <LoadingBlock label="Searching the contact name index" rows={8} />
          ) : search.data && search.data.hits.length === 0 ? (
            <EmptyState
              icon={<Search className="size-5" />}
              title="We did not find anything related to this company or contact in our database."
              description={
                search.data.notice ??
                (coverageComplete
                  ? "The complete indexed corpus was searched. Try a different spelling or a shorter part of the name."
                  : "Only the indexed coverage could be searched, so this is not proof the person is absent.")
              }
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setDraft("");
                    setParams(new URLSearchParams(), { replace: true });
                  }}
                >
                  Try another search
                </Button>
              }
            />
          ) : search.data ? (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular">
                  {formatNumber(search.data.matchedIds)} matched · {search.data.tookMs} ms
                </span>
                {search.data.correctedQuery ? <span>Interpreted as “{search.data.correctedQuery}”</span> : null}
                {activeFilters ? (
                  <Badge variant="outline" className="font-normal">
                    {filtered.length} of {hits.length} on this page after filters
                  </Badge>
                ) : null}
                {selected.size ? (
                  <span className="ml-auto inline-flex items-center gap-2">
                    <span className="tabular">{selected.size} selected</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5"
                      onClick={() => {
                        const rows = hits.filter((hit) => selected.has(hit.id));
                        void copy(rows.map((hit) => hit.email).filter(Boolean).join("\n"), "Email addresses");
                      }}
                    >
                      <Copy className="size-3" />
                      Copy emails
                    </Button>
                  </span>
                ) : null}
              </div>

              {search.data.notice ? (
                <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.07] px-4 py-2.5 text-xs">{search.data.notice}</div>
              ) : null}

              <div className="surface overflow-hidden">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-card">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-9" />
                        <TableHead className="min-w-[180px]">Name</TableHead>
                        <TableHead className="min-w-[150px]">Designation</TableHead>
                        <TableHead className="min-w-[160px]">Company</TableHead>
                        <TableHead className="min-w-[180px]">Email</TableHead>
                        <TableHead className="min-w-[130px]">Location</TableHead>
                        <TableHead className="w-16">LinkedIn</TableHead>
                        <TableHead className="w-28">Association</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((hit) => (
                        <TableRow
                          key={hit.id}
                          className="cursor-pointer text-[13px]"
                          onClick={() => setActive(hit)}
                          data-state={selected.has(hit.id) ? "selected" : undefined}
                        >
                          <TableCell onClick={(event) => event.stopPropagation()}>
                            <Checkbox checked={selected.has(hit.id)} onCheckedChange={() => toggle(hit.id)} aria-label={`Select ${hit.fullName}`} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                                {initials(hit.fullName) || "?"}
                              </span>
                              <span className="truncate font-medium">{hit.fullName || "Unnamed"}</span>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[190px] truncate text-muted-foreground">
                            {hit.designation ?? hit.title ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-[190px] truncate">
                            {hit.companyId ? (
                              <Link
                                to={`/companies/${encodeURIComponent(hit.companyId)}`}
                                onClick={(event) => event.stopPropagation()}
                                className="hover:text-primary hover:underline"
                              >
                                {hit.companyName}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">{hit.companyName ?? "—"}</span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[210px] truncate">
                            {hit.email ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void copy(hit.email!, "Email");
                                }}
                                className="inline-flex max-w-full items-center gap-1.5 hover:text-primary"
                                title={hit.email}
                              >
                                <Mail className="size-3 shrink-0 text-muted-foreground" />
                                <span className="truncate">{hit.email}</span>
                              </button>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[150px] truncate text-muted-foreground">
                            {locationOf(hit) ? (
                              <span className="inline-flex items-center gap-1">
                                <MapPin className="size-3" />
                                {locationOf(hit)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell onClick={(event) => event.stopPropagation()}>
                            {hit.linkedinUrl ? (
                              <a href={hit.linkedinUrl} target="_blank" rel="noreferrer" aria-label={`LinkedIn profile for ${hit.fullName}`} className="text-primary">
                                <Linkedin className="size-3.5" />
                              </a>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <ConfidenceBadge hit={hit} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {filtered.length === 0 ? (
                  <div className="px-5 py-8 text-center text-xs text-muted-foreground">
                    No people on this page match the page filters. Clear them to see every result.
                  </div>
                ) : null}
              </div>

              <Pager
                page={search.data.page.page}
                pageSize={search.data.page.pageSize}
                total={search.data.page.total}
                hasMore={search.data.page.hasMore}
                totalIsLowerBound={search.data.page.totalIsLowerBound}
                onPage={(value) => update({ page: value })}
                onPageSize={(value) => update({ pageSize: value, page: undefined })}
              />
            </>
          ) : null}
        </div>
      </div>

      {active ? (
        <PersonDrawer
          hit={active}
          datasetVersion={datasetVersion}
          onClose={() => setActive(null)}
          onSaved={() => setActive(null)}
        />
      ) : null}
    </>
  );
}
