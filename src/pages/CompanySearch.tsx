/**
 * Company search — the primary screen.
 *
 * Query state lives in the URL so a search can be bookmarked, shared with
 * yourself, and re-run from the Saved Searches screen. Typing is debounced and
 * the suggestion list is a separate, cheaper query (six rows) so autocomplete
 * never costs a full result page.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Building2, ChevronDown, Copy, Database, ExternalLink, Filter, Linkedin, Search, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorBlock, LoadingBlock, MatchBadge, PageHeader, Pager, Section } from "@/components/common";
import {
  useCompanySearch,
  useCreateSavedSearch,
  useDatasetMode,
  useDatasetStatus,
  useSaveLead as useInsertLead,
  recordActivity,
} from "@/hooks/use-api";
import { formatNumber } from "@/lib/format";
import type { CompanyFilters, CompanySortField, SortOrder } from "@/shared/models";
import { cn } from "@/lib/utils";

interface SearchState {
  q: string;
  page: number;
  pageSize: number;
  sort: CompanySortField;
  order: SortOrder;
  fuzzy: boolean;
  filters: CompanyFilters;
}

function readState(params: URLSearchParams): SearchState {
  const filters: CompanyFilters = {};
  for (const key of ["industry", "country", "city", "companySize"] as const) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  if (params.get("hasContacts") === "true") filters.hasContacts = true;
  if (params.get("hasDomain") === "true") filters.hasDomain = true;
  return {
    q: params.get("q") ?? "",
    page: Math.max(1, Number(params.get("page") ?? 1)),
    pageSize: Math.min(100, Math.max(5, Number(params.get("pageSize") ?? 25))),
    sort: (params.get("sort") as CompanySortField) ?? "relevance",
    order: (params.get("order") as SortOrder) ?? "desc",
    fuzzy: params.get("fuzzy") !== "false",
    filters,
  };
}

export default function CompanySearch() {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => readState(params), [params]);
  const [draft, setDraft] = useState(state.q);
  const [showFilters, setShowFilters] = useState(
    Boolean(state.filters.industry || state.filters.country || state.filters.city || state.filters.hasContacts || state.filters.hasDomain),
  );
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [debouncedDraft, setDebouncedDraft] = useState(state.q);
  const inputRef = useRef<HTMLInputElement>(null);

  const dataset = useDatasetStatus();
  const datasetMode = useDatasetMode();
  const saveSearch = useCreateSavedSearch();
  const saveLead = useInsertLead();

  // Keep the input in sync when the URL changes (back/forward, saved search).
  useEffect(() => {
    setDraft(state.q);
    setDebouncedDraft(state.q);
  }, [state.q]);

  // Debounce typing before hitting the index for suggestions.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedDraft(draft), 320);
    return () => clearTimeout(handle);
  }, [draft]);

  const query = useCompanySearch({
    query: state.q,
    page: state.page,
    pageSize: state.pageSize,
    sort: state.sort,
    order: state.order,
    fuzzy: state.fuzzy,
    resultBudget: 800,
    filters: state.filters,
  });
  const suggestions = useCompanySearch({
    query: debouncedDraft.trim().length >= 2 && debouncedDraft !== state.q ? debouncedDraft : "",
    page: 1,
    pageSize: 6,
    sort: "relevance",
    order: "desc",
    fuzzy: state.fuzzy,
    resultBudget: 200,
    filters: {},
  });

  const datasetVersion = query.data?.datasetVersion ?? dataset.data?.activeVersion ?? "unknown";

  function update(patch: Partial<SearchState>) {
    const next = new URLSearchParams(params);
    const merged = { ...state, ...patch };
    if (patch.q !== undefined) next.set("q", patch.q);
    if (patch.page !== undefined) next.set("page", String(patch.page));
    if (patch.pageSize !== undefined) {
      next.set("pageSize", String(patch.pageSize));
      next.set("page", "1");
    }
    if (patch.sort !== undefined) next.set("sort", patch.sort);
    if (patch.order !== undefined) next.set("order", patch.order);
    if (patch.fuzzy !== undefined) next.set("fuzzy", String(patch.fuzzy));
    if (patch.filters !== undefined) {
      const filters = patch.filters;
      for (const key of ["industry", "country", "city", "companySize"] as const) {
        if (filters[key]) next.set(key, filters[key]!);
        else next.delete(key);
      }
      for (const key of ["hasContacts", "hasDomain"] as const) {
        if (filters[key]) next.set(key, "true");
        else next.delete(key);
      }
    }
    if (patch.q !== undefined && patch.page === undefined) next.set("page", "1");
    void merged;
    setParams(next, { replace: true });
  }

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    const query = draft.trim();
    if (!query) return;
    update({ q: query, page: 1 });
    setSuggestOpen(false);
    recordActivity({ kind: "search", label: query, href: `/companies?q=${encodeURIComponent(query)}` });
  }

  const activeFilterCount = Object.values(state.filters).filter(Boolean).length;
  const hits = query.data?.hits ?? [];
  const showSuggestions =
    suggestOpen && debouncedDraft.trim().length >= 2 && debouncedDraft !== state.q && (suggestions.data?.hits.length ?? 0) > 0;

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Company search"
        description="Exact, partial and typo-tolerant matching across every company in the indexed dataset. Similar names stay separate — nothing is merged by similarity."
        actions={
          <>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                setSaveName(state.q || "Untitled search");
                setSaveOpen(true);
              }}
              disabled={!state.q}
            >
              <Star className="size-4" />
              Save this search
            </Button>
            <Button variant="outline" className="gap-2 lg:hidden" onClick={() => setShowFilters((value) => !value)}>
              <Filter className="size-4" />
              Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
            </Button>
          </>
        }
      />

      <div className="surface p-4 sm:p-5">
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSuggestOpen(true);
              }}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setTimeout(() => setSuggestOpen(false), 160)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSuggestOpen(false);
                if (event.key === "Enter") submit(event as unknown as React.FormEvent);
              }}
              placeholder="Company name — typos are fine (Microsft, Googel, Tata Consultency)"
              aria-label="Search companies"
              className="h-11 pl-10 pr-9 text-base"
              role="combobox"
              aria-expanded={showSuggestions}
              aria-controls="company-suggestions"
            />
            {draft ? (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setDraft("");
                  inputRef.current?.focus();
                }}
              >
                <X className="size-4" />
              </button>
            ) : null}

            {showSuggestions ? (
              <div
                id="company-suggestions"
                role="listbox"
                className="surface-raised absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden p-1.5"
              >
                {suggestions.isFetching ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">Searching index…</p>
                ) : (
                  suggestions.data!.hits.map((hit) => (
                    <button
                      key={hit.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent"
                      onClick={() => {
                        setDraft(hit.name);
                        setSuggestOpen(false);
                        update({ q: hit.name, page: 1 });
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{hit.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {[hit.industry, hit.city, hit.country].filter(Boolean).join(" · ") || "No location metadata"}
                        </p>
                      </div>
                      <span className="tabular shrink-0 text-[11px] text-muted-foreground">{hit.relevance.toFixed(2)}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <Button type="submit" size="lg" className="h-11 gap-2 px-6" disabled={!draft.trim()}>
            <Search className="size-4" />
            Search
          </Button>
        </form>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border/60 pt-4">
          <div className="flex items-center gap-2">
            <Switch
              id="fuzzy"
              checked={state.fuzzy}
              onCheckedChange={(checked) => update({ fuzzy: checked, page: 1 })}
            />
            <Label htmlFor="fuzzy" className="text-xs font-normal text-muted-foreground">
              Fuzzy matching (typos, missing letters, transpositions)
            </Label>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Sort</span>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={state.sort}
              onChange={(event) => update({ sort: event.target.value as CompanySortField, page: 1 })}
              aria-label="Sort results by"
            >
              <option value="relevance">Relevance</option>
              <option value="name">Company name</option>
              <option value="contactCount">Contact count</option>
            </select>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={state.order}
              onChange={(event) => update({ order: event.target.value as SortOrder })}
              aria-label="Sort direction"
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </div>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground lg:hidden"
            onClick={() => setShowFilters((value) => !value)}
          >
            <Filter className="size-3.5" />
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
            <ChevronDown className={cn("size-3.5 transition-transform", showFilters && "rotate-180")} />
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          {query.data?.notice ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-chart-3/40 bg-chart-3/[0.08] px-4 py-3 text-xs">
              <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-chart-3" />
              <p>{query.data.notice}</p>
            </div>
          ) : null}

          {datasetMode.mode === "no-dataset" && !datasetMode.isLoading ? (
            // Nothing is published, so there is nothing honest to search. This is a
            // state, not an error: explain it instead of showing a failed request.
            <EmptyState
              icon={<Database className="size-5" />}
              title="No dataset indexed"
              description={
                datasetMode.error
                  ? `The dataset status could not be read: ${(datasetMode.error as Error).message}`
                  : datasetMode.description
              }
              action={
                <Button variant="outline" className="gap-2" asChild>
                  <Link to="/dataset">
                    <Database className="size-4" />
                    Dataset management
                  </Link>
                </Button>
              }
            />
          ) : query.isLoading ? (
            <LoadingBlock label="Searching the index" rows={6} />
          ) : query.error ? (
            <ErrorBlock error={query.error as Error} onRetry={() => query.refetch()} />
          ) : !state.q ? (
            <EmptyState
              icon={<Search className="size-5" />}
              title="Search the company index"
              description="Start typing a company name. Matching is exact-first, then name variants, prefixes and finally bounded typo correction — the entered query is never silently replaced."
            />
          ) : hits.length === 0 ? (
            <EmptyState
              icon={<Building2 className="size-5" />}
              title={`No companies matched “${state.q}”`}
              description="Try fewer words, check the spelling of a distinctive word, or turn on fuzzy matching. Nothing outside the indexed dataset can be returned."
            />
          ) : (
            <>
              <div className="surface overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-3">
                  <p className="text-xs text-muted-foreground">
                    {query.data?.retrieval.scored ?? 0} candidates scored · {query.data?.tookMs ?? 0} ms · dataset{" "}
                    {query.data?.datasetVersion}
                  </p>
                  <p className="tabular hidden text-xs text-muted-foreground sm:block">
                    {formatNumber(query.data?.page.total ?? 0)} ranked results
                  </p>
                </div>
                <ul className="divide-y divide-border/60">
                  {hits.map((hit) => (
                    <li key={hit.id} className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-muted/35 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link to={`/companies/${hit.id}`} className="truncate text-sm font-semibold hover:text-primary">
                            {hit.name}
                          </Link>
                          {hit.multiSource ? (
                            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                              merged sources
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {[hit.industry, [hit.city, hit.state, hit.country].filter(Boolean).join(", ")]
                            .filter(Boolean)
                            .join(" · ") || "No location or industry metadata"}
                        </p>
                        <div className="mt-2">
                          <MatchBadge category={hit.matchCategory} relevance={hit.relevance} possible={hit.possibleMatch} />
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5 sm:flex-col sm:items-end sm:gap-2">
                        <span className="tabular rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                          {formatNumber(hit.contactCount)} contacts
                        </span>
                        <div className="flex items-center gap-1">
                          {hit.domain ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title={`Copy ${hit.domain}`}
                              aria-label={`Copy domain ${hit.domain}`}
                              onClick={() => void navigator.clipboard?.writeText(hit.domain!)}
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          ) : null}
                          {hit.website ? (
                            <Button variant="ghost" size="icon-sm" asChild title="Open company website">
                              <a href={hit.website} target="_blank" rel="noreferrer noopener">
                                <ExternalLink className="size-3.5" />
                              </a>
                            </Button>
                          ) : null}
                          {hit.linkedinUrl ? (
                            <Button variant="ghost" size="icon-sm" asChild title="Open LinkedIn page">
                              <a href={hit.linkedinUrl} target="_blank" rel="noreferrer noopener">
                                <Linkedin className="size-3.5" />
                              </a>
                            </Button>
                          ) : null}
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() =>
                              saveLead.mutate({
                                kind: "company",
                                targetId: hit.id,
                                datasetVersion,
                                snapshot: {
                                  name: hit.name,
                                  industry: hit.industry ?? null,
                                  country: hit.country ?? null,
                                  contactCount: hit.contactCount,
                                },
                              })
                            }
                          >
                            <Star className="size-3.5" />
                            Save
                          </Button>
                          <Button size="sm" asChild>
                            <Link to={`/companies/${hit.id}`}>View</Link>
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <Pager
                page={query.data!.page.page}
                pageSize={query.data!.page.pageSize}
                total={query.data!.page.total}
                hasMore={query.data!.page.hasMore}
                totalIsLowerBound={query.data!.page.totalIsLowerBound}
                onPage={(page) => update({ page })}
                onPageSize={(pageSize) => update({ pageSize })}
              />
            </>
          )}
        </div>

        <aside className={cn("space-y-4 lg:block", showFilters ? "block" : "hidden")}>
          <Section
            title="Filters"
            description="Applied to the retrieved candidate pool"
            actions={
              activeFilterCount ? (
                <Button variant="ghost" size="sm" onClick={() => update({ filters: {}, page: 1 })}>
                  Clear
                </Button>
              ) : null
            }
          >
            <div className="space-y-4">
              {(
                [
                  { key: "industry", label: "Industry" },
                  { key: "country", label: "Country" },
                  { key: "city", label: "City" },
                  { key: "companySize", label: "Company size" },
                ] as const
              ).map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`filter-${field.key}`} className="text-xs">
                    {field.label}
                  </Label>
                  <Input
                    id={`filter-${field.key}`}
                    value={state.filters[field.key] ?? ""}
                    placeholder="Exact value from the data"
                    className="h-8 text-xs"
                    onChange={(event) => update({ filters: { ...state.filters, [field.key]: event.target.value || undefined }, page: 1 })}
                  />
                </div>
              ))}
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="filter-contacts" className="text-xs font-normal">
                  Has contacts
                </Label>
                <Switch
                  id="filter-contacts"
                  checked={Boolean(state.filters.hasContacts)}
                  onCheckedChange={(checked) => update({ filters: { ...state.filters, hasContacts: checked || undefined }, page: 1 })}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="filter-domain" className="text-xs font-normal">
                  Has website
                </Label>
                <Switch
                  id="filter-domain"
                  checked={Boolean(state.filters.hasDomain)}
                  onCheckedChange={(checked) => update({ filters: { ...state.filters, hasDomain: checked || undefined }, page: 1 })}
                />
              </div>
              <p className="text-[11px] leading-5 text-muted-foreground">
                Filters narrow the candidates retrieved from the index for this query. They are not a full-collection
                scan, so a very selective filter combined with a vague query can return fewer rows than expected.
              </p>
            </div>
          </Section>

          {query.data ? (
            <Section title="Retrieval detail" description="Index work done for this query">
              <dl className="space-y-2 text-xs">
                {[
                  ["Exact index", query.data.retrieval.exact],
                  ["Prefix index", query.data.retrieval.prefix],
                  ["Token index", query.data.retrieval.token],
                  ["Trigram index", query.data.retrieval.trigram],
                  ["Candidates scored", query.data.retrieval.scored],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular">{formatNumber(Number(value))}</dd>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2">
                  <dt className="text-muted-foreground">Normalized query</dt>
                  <dd className="truncate font-mono text-[11px]">{query.data.normalizedQuery}</dd>
                </div>
                {query.data.correctedQuery ? (
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Closest name</dt>
                    <dd className="truncate text-[11px]">{query.data.correctedQuery}</dd>
                  </div>
                ) : null}
              </dl>
            </Section>
          ) : null}
        </aside>
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this search</DialogTitle>
            <DialogDescription>
              Saved searches store the query, filters and sorting so you can re-run them later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="saved-search-name">Display name</Label>
            <Input
              id="saved-search-name"
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder="e.g. Indian IT services"
            />
            <p className="text-xs text-muted-foreground">
              Query: <span className="font-medium">{state.q || "—"}</span>
              {activeFilterCount ? ` · ${activeFilterCount} filter${activeFilterCount > 1 ? "s" : ""}` : ""}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!saveName.trim() || !state.q}
              onClick={() => {
                saveSearch.mutate(
                  { name: saveName.trim(), query: state.q, filters: state.filters, sort: state.sort, order: state.order },
                  { onSuccess: () => setSaveOpen(false) },
                );
              }}
            >
              Save search
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
