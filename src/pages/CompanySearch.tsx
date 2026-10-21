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
import { Building2, ChevronDown, Copy, Database, ExternalLink, Filter, Linkedin, Mail, MapPin, Search, Star, UserRound, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorBlock, LoadingBlock, MatchBadge, PageHeader, Pager, Section } from "@/components/common";
import {
  useCompanySearch,
  useContactSearch,
  useCreateSavedSearch,
  useDatasetMode,
  useDatasetStatus,
  useSaveLead as useInsertLead,
  recordActivity,
} from "@/hooks/use-api";
import { ASSOCIATION_CATEGORY_LABELS, type AssociationCategory } from "@/shared/association";
import { RealDataCoverageNotice, SourceScanPanel } from "@/components/realdata";
import { ContactNumbers } from "@/components/contact-numbers";
import { useRealDataCoverage } from "@/hooks/use-realdata";
import { formatNumber } from "@/lib/format";
import type { CompanyFilters, CompanySortField, SortOrder } from "@/shared/models";
import { cn } from "@/lib/utils";

/**
 * What the one search box looks through.
 *
 * `all` runs both indexes for the same query, so the user never has to know which
 * kind of record they are looking for before they search.
 */
type SearchMode = "all" | "companies" | "contacts";

interface SearchState {
  q: string;
  mode: SearchMode;
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
  const type = params.get("type");
  return {
    q: params.get("q") ?? "",
    mode: type === "companies" || type === "contacts" ? type : "all",
    page: Math.max(1, Number(params.get("page") ?? 1)),
    pageSize: Math.min(100, Math.max(5, Number(params.get("pageSize") ?? 25))),
    sort: (params.get("sort") as CompanySortField) ?? "relevance",
    order: (params.get("order") as SortOrder) ?? "desc",
    fuzzy: params.get("fuzzy") !== "false",
    filters,
  };
}

/**
 * Employer-confidence badge for a person result.
 *
 * A contact is never presented as a confirmed employee of a company that merely
 * shares the name: the category comes from the indexer's association decision, and
 * anything short of verified evidence is labelled as unconfirmed on the card
 * itself, not only on the detail page.
 */
function AssociationBadge({ category, unconfirmed }: { category: string | null; unconfirmed: boolean }) {
  if (!category && !unconfirmed) return null;
  const label = category ? ASSOCIATION_CATEGORY_LABELS[category as AssociationCategory] ?? category : "Employer unconfirmed";
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] font-normal",
        unconfirmed ? "border-chart-4/50 text-chart-4" : "border-chart-2/50 text-chart-2",
      )}
      title={unconfirmed ? "The employer is claimed by the source row and was not verified" : "Employer supported by strong identity evidence"}
    >
      {label}
    </Badge>
  );
}

export default function CompanySearch() {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => readState(params), [params]);
  /**
   * What the user has typed, tagged with the URL query it was typed against.
   *
   * The input follows the URL (back/forward, a saved search, a suggestion click)
   * and follows typing in between; deriving it here instead of copying the URL
   * into state from an effect removes the second render on every navigation and
   * makes "URL wins over an older draft" a single expression rather than a sync
   * rule to remember.
   */
  const [typed, setTyped] = useState<{ q: string; value: string } | null>(null);
  const draft = typed && typed.q === state.q ? typed.value : state.q;
  const setDraft = (value: string) => setTyped({ q: state.q, value });
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
  const contactQuery = useContactSearch({
    query: state.mode === "companies" ? "" : state.q,
    page: state.page,
    pageSize: state.pageSize,
  });
  const suggestionQuery = state.mode === "contacts" ? "" : debouncedDraft.trim().length >= 2 && debouncedDraft !== state.q ? debouncedDraft : "";
  const suggestions = useCompanySearch({
    query: suggestionQuery,
    page: 1,
    pageSize: 6,
    sort: "relevance",
    order: "desc",
    fuzzy: state.fuzzy,
    resultBudget: 200,
    filters: {},
  });
  const contactSuggestions = useContactSearch({
    query: state.mode === "contacts" && debouncedDraft.trim().length >= 2 && debouncedDraft !== state.q ? debouncedDraft : "",
    page: 1,
    pageSize: 6,
  });

  const datasetVersion = query.data?.datasetVersion ?? dataset.data?.activeVersion ?? "unknown";

  function update(patch: Partial<SearchState>) {
    const next = new URLSearchParams(params);
    const merged = { ...state, ...patch };
    if (patch.q !== undefined) next.set("q", patch.q);
    if (patch.mode !== undefined) {
      next.set("type", patch.mode);
      next.set("page", "1");
    }
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
  const realData = useRealDataCoverage();
  const partialCoverage = realData.data?.partial !== false;
  const hits = state.mode === "contacts" ? [] : query.data?.hits ?? [];
  const contactHits = state.mode === "companies" ? [] : contactQuery.data?.hits ?? [];
  const suggestionHits = state.mode === "contacts" ? [] : suggestions.data?.hits ?? [];
  const contactSuggestionHits = state.mode === "contacts" ? contactSuggestions.data?.hits ?? [] : [];
  const showSuggestions =
    suggestOpen &&
    debouncedDraft.trim().length >= 2 &&
    debouncedDraft !== state.q &&
    suggestionHits.length + contactSuggestionHits.length > 0;
  const showContacts = state.mode !== "companies";
  const showCompanies = state.mode !== "contacts";
  const searching = state.mode === "contacts" ? contactQuery.isLoading : state.mode === "companies" ? query.isLoading : query.isLoading || contactQuery.isLoading;
  const searchError = state.mode === "companies" ? query.error : state.mode === "contacts" ? contactQuery.error : query.error ?? contactQuery.error;
  const resultsEmpty = hits.length === 0 && contactHits.length === 0;
  const refetchBoth = () => {
    if (showCompanies) void query.refetch();
    if (showContacts) void contactQuery.refetch();
  };

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Search"
        description="One box for both indexes: search companies, people, or everything at once. Matching is exact-first, then name variants, prefixes and bounded typo correction — the query you typed is never silently replaced, and similar names are never merged."
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

      <RealDataCoverageNotice className="mb-4" compact />

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
                {suggestions.isFetching || contactSuggestions.isFetching ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">Searching index…</p>
                ) : (
                  [
                    ...contactSuggestionHits.map((hit) => (
                      <button
                        key={`c-${hit.id}`}
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent"
                        onClick={() => {
                          setDraft(hit.fullName);
                          setSuggestOpen(false);
                          update({ q: hit.fullName, page: 1 });
                        }}
                      >
                        <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{hit.fullName}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {[hit.title, hit.companyName].filter(Boolean).join(" · ") || "Person record"}
                          </p>
                        </div>
                        <span className="tabular shrink-0 text-[11px] text-muted-foreground">{hit.relevance.toFixed(2)}</span>
                      </button>
                    )),
                  ]
                )}
                {suggestionHits.map((hit) => (
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
                  ))}
              </div>
            ) : null}
          </div>

          <Button type="submit" size="lg" className="h-11 gap-2 px-6" disabled={!draft.trim()}>
            <Search className="size-4" />
            Search
          </Button>
        </form>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-4" role="group" aria-label="What to search">
          {(
            [
              { value: "all", label: "All", icon: <Search className="size-3.5" /> },
              { value: "companies", label: "Companies", icon: <Building2 className="size-3.5" /> },
              { value: "contacts", label: "Contacts", icon: <Users className="size-3.5" /> },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={state.mode === option.value}
              onClick={() => update({ mode: option.value })}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                state.mode === option.value
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {option.icon}
              {option.label}
            </button>
          ))}
        </div>

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
          {contactQuery.data?.notice ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-chart-3/40 bg-chart-3/[0.08] px-4 py-3 text-xs">
              <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-chart-3" />
              <p>{contactQuery.data.notice}</p>
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
          ) : searching ? (
            <LoadingBlock label={showContacts && !showCompanies ? "Searching the contact index" : "Searching the index"} rows={6} />
          ) : searchError ? (
            <ErrorBlock error={searchError as Error} onRetry={refetchBoth} />
          ) : !state.q ? (
            <EmptyState
              icon={<Search className="size-5" />}
              title="Search companies and people"
              description="Start typing a company or a person's name. Matching is exact-first, then name variants, prefixes and finally bounded typo correction — the entered query is never silently replaced."
            />
          ) : resultsEmpty ? (
            <EmptyState
              icon={<Search className="size-5" />}
              title={partialCoverage ? "No match in the indexed coverage" : "No results"}
              description={
                partialCoverage
                  ? "Nothing in the activated index matches this query. Only part of the 64 GB corpus is indexed, so the record may still exist — run a bounded source scan below to look outside that coverage. No absence is claimed."
                  : "We did not find anything related to this company or contact in our database."
              }
            />
          ) : (
            <>
              {showContacts && contactHits.length ? (
                <section className="space-y-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="flex items-center gap-2 text-sm font-semibold">
                      <Users className="size-4 text-muted-foreground" />
                      People
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {formatNumber(contactQuery.data?.matchedIds ?? contactHits.length)} matched · {contactQuery.data?.tookMs ?? 0} ms
                    </p>
                  </div>
                  <ul className="surface divide-y divide-border/60 overflow-hidden">
                    {contactHits.map((hit) => (
                      <li
                        key={hit.id}
                        className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-muted/35 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link to={`/contacts/${hit.id}`} className="truncate text-sm font-semibold hover:text-primary">
                              {hit.fullName || "Unnamed contact"}
                            </Link>
                            <AssociationBadge category={hit.association} unconfirmed={hit.employerUnconfirmed} />
                          </div>
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {[hit.title ?? hit.designation, hit.companyName].filter(Boolean).join(" · ") || "No role or employer in the source row"}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                            {hit.email ? (
                              <span className="inline-flex items-center gap-1.5">
                                <Mail className="size-3" />
                                {hit.email}
                              </span>
                            ) : null}
                            <ContactNumbers contact={hit} showLabels={false} />
                            {[hit.city, hit.country].filter(Boolean).length ? (
                              <span className="inline-flex items-center gap-1.5">
                                <MapPin className="size-3" />
                                {[hit.city, hit.country].filter(Boolean).join(", ")}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {hit.email ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title={`Copy ${hit.email}`}
                              aria-label={`Copy email ${hit.email}`}
                              onClick={() => void navigator.clipboard?.writeText(hit.email!)}
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          ) : null}
                          {hit.linkedinUrl ? (
                            <Button variant="ghost" size="icon-sm" asChild title="Open LinkedIn profile">
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
                                kind: "contact",
                                targetId: hit.id,
                                datasetVersion,
                                snapshot: {
                                  fullName: hit.fullName,
                                  title: hit.title ?? null,
                                  companyName: hit.companyName ?? null,
                                  email: hit.email ?? null,
                                },
                              })
                            }
                          >
                            <Star className="size-3.5" />
                            Save
                          </Button>
                          <Button size="sm" asChild>
                            <Link to={`/contacts/${hit.id}`}>View</Link>
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Pager
                    page={contactQuery.data!.page.page}
                    pageSize={contactQuery.data!.page.pageSize}
                    total={contactQuery.data!.page.total}
                    hasMore={contactQuery.data!.page.hasMore}
                    totalIsLowerBound={contactQuery.data!.page.totalIsLowerBound}
                    onPage={(page) => update({ page })}
                    onPageSize={(pageSize) => update({ pageSize })}
                  />
                </section>
              ) : null}

              {showCompanies && hits.length ? (
              <div className="surface overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-3">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <Building2 className="size-4 text-muted-foreground" />
                    Companies
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {query.data?.retrieval.scored ?? 0} candidates scored · {query.data?.tookMs ?? 0} ms ·{" "}
                    {formatNumber(query.data?.page.total ?? 0)} ranked
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
              ) : null}

              {showCompanies ? (
                <Pager
                  page={query.data!.page.page}
                  pageSize={query.data!.page.pageSize}
                  total={query.data!.page.total}
                  hasMore={query.data!.page.hasMore}
                  totalIsLowerBound={query.data!.page.totalIsLowerBound}
                  onPage={(page) => update({ page })}
                  onPageSize={(pageSize) => update({ pageSize })}
                />
              ) : null}
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

      {state.q && realData.data?.directScan ? (
        <SourceScanPanel
          className="mt-4"
          query={state.q}
          kind={state.mode === "companies" ? "companies" : state.mode === "contacts" ? "contacts" : "both"}
        />
      ) : null}

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
