/**
 * Saved searches: reusable company queries with their filters and sorting.
 */

import { Link, useNavigate } from "react-router";
import { Play, Plus, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, Section } from "@/components/common";
import { RealDataCoverageNotice } from "@/components/realdata";
import { useDeleteSavedSearch, useMarkSavedSearchRun, useSavedSearches, useSettings } from "@/hooks/use-api";
import { formatNumber, relativeTime } from "@/lib/format";
import type { CompanyFilters } from "@/shared/models";

export default function SavedSearches() {
  const searches = useSavedSearches();
  const settings = useSettings();
  const deleteSearch = useDeleteSavedSearch();
  const markRun = useMarkSavedSearchRun();
  const navigate = useNavigate();

  function queryString(query: string, filters: CompanyFilters, sort: string, order: string) {
    const params = new URLSearchParams({ q: query, sort, order });
    for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
      if (value !== undefined && value !== null && value !== false && value !== "") params.set(key, String(value));
    }
    return params.toString();
  }

  const rows = searches.data ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Library"
        title="Saved searches"
        description="Store the queries you run often — query text, filters and sorting — and re-run them in one click."
        actions={
          <Button className="gap-2" asChild>
            <Link to="/companies">
              <Search className="size-4" />
              New search
            </Link>
          </Button>
        }
      />

      <RealDataCoverageNotice className="mb-4" compact />

      <Section
        title="Your saved queries"
        description={
          settings.data
            ? `Default page size ${settings.data.pageSize} · fuzzy matching ${settings.data.fuzzySearch ? "on" : "off"} by default`
            : "Loading preferences…"
        }
      >
        {searches.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading saved searches…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Search className="size-5" />}
            title="No saved searches yet"
            description="Run a company search, then use “Save this search” to keep it here. Autocomplete keystrokes are never saved."
            action={
              <Button asChild>
                <Link to="/companies">
                  <Plus className="size-4" />
                  Go to company search
                </Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((search) => {
              const filterCount = Object.values(search.filters).filter(Boolean).length;
              return (
                <li key={search.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{search.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      Query “{search.query}” · sorted by {search.sort} ({search.order})
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {filterCount ? `${filterCount} filter${filterCount > 1 ? "s" : ""}` : "no filters"}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {formatNumber(search.runCount)} runs
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {search.lastRunAt ? `last run ${relativeTime(search.lastRunAt)}` : "never run"} · created{" "}
                        {relativeTime(search.createdAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      className="gap-2"
                      size="sm"
                      onClick={() => {
                        void markRun.mutateAsync(search.id);
                        navigate(`/companies?${queryString(search.query, search.filters, search.sort, search.order)}`);
                      }}
                    >
                      <Play className="size-3.5" />
                      Run
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => navigate(`/companies?${queryString(search.query, search.filters, search.sort, search.order)}`)}
                    >
                      Open
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${search.name}`}
                      title="Delete saved search"
                      onClick={() => deleteSearch.mutate(search.id)}
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}
