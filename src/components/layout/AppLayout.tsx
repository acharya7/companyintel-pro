/**
 * Application shell: a collapsible workspace rail, a compact top bar and the
 * content area.
 *
 * Navigation is split into two groups on purpose: daily prospecting screens come
 * first, while dataset and indexing operations sit below a divider — reachable
 * from anywhere, but visually secondary to the work of finding companies and
 * people. The rail collapses to an icon strip (persisted per browser) and becomes
 * a slide-over sheet on small screens.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useTheme } from "next-themes";
import {
  Building2,
  ChevronsLeft,
  ChevronsRight,
  Cloud,
  Command,
  Database,
  FileDown,
  LayoutDashboard,
  Library,
  ListPlus,
  Menu,
  Moon,
  Search,
  Settings as SettingsIcon,
  Star,
  Sun,
  UserRound,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { DatasetModeBanner, ErrorBlock, StatusPill } from "@/components/common";
import { useDatasetMode, useDatasetVersionSync, useLeads, useSavedSearches } from "@/hooks/use-api";
import { useHydrated } from "@/hooks/use-hydrated";
import { apiMode, relativeTime } from "@/lib/format-bridge";

type NavItem = {
  to: string;
  label: string;
  icon: typeof Search;
  hint: string;
};

const PRIMARY_NAV: NavItem[] = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard, hint: "Dataset health, recent activity and saved pipeline" },
  { to: "/companies", label: "Find Companies", icon: Search, hint: "Typo-tolerant company discovery with filters" },
  { to: "/people", label: "Find People", icon: Users, hint: "Search people across the indexed contact population" },
  { to: "/leads", label: "Saved Leads", icon: Star, hint: "Companies and contacts you have saved" },
  { to: "/lists", label: "Lead Lists", icon: ListPlus, hint: "Organise saved records into working lists" },
  { to: "/saved-searches", label: "Saved Searches", icon: Library, hint: "Reusable company and people queries" },
  { to: "/exports", label: "Exports", icon: FileDown, hint: "Generated CSV files" },
];

const SECONDARY_NAV: NavItem[] = [
  { to: "/dataset", label: "Dataset", icon: Database, hint: "Active version, coverage and source files" },
  { to: "/indexing", label: "Cloud Indexing", icon: Cloud, hint: "Container job state, checkpoints and cost" },
  { to: "/settings", label: "Settings", icon: SettingsIcon, hint: "Search, cache and privacy" },
];

const COLLAPSE_KEY = "companyintel.sidebar.collapsed";

function useCollapsedRail() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(COLLAPSE_KEY) === "true";
  });
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, String(next));
      } catch {
        /* storage can be disabled; the rail still works for this session */
      }
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

function BrandMark({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", collapsed && "justify-center")}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Building2 className="size-4" />
      </span>
      {collapsed ? null : (
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold tracking-tight">CompanyIntel</span>
          <span className="block truncate text-[11px] text-muted-foreground">Sales intelligence workspace</span>
        </span>
      )}
    </div>
  );
}

function NavItemLink({
  item,
  collapsed,
  onNavigate,
  count,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
  count?: number;
}) {
  const link = (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium outline-none transition-[background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring/60",
          collapsed && "justify-center px-0",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon className="size-4 shrink-0" />
          {collapsed ? null : <span className="truncate">{item.label}</span>}
          {!collapsed && count ? (
            <span className="tabular ml-auto rounded-full bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-border">
              {count}
            </span>
          ) : null}
          {isActive ? <span className="absolute inset-y-1.5 -left-2 w-0.5 rounded-full bg-primary" aria-hidden /> : null}
        </>
      )}
    </NavLink>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        <p className="font-medium">{item.label}</p>
        <p className="text-muted-foreground">{item.hint}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function NavGroups({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { data: leads } = useLeads();
  const { data: searches } = useSavedSearches();
  const counts: Record<string, number | undefined> = {
    "/leads": leads?.total,
    "/saved-searches": searches?.length,
  };
  return (
    <TooltipProvider delayDuration={300}>
      <nav className="space-y-5" aria-label="Main navigation">
        <div className="space-y-0.5">
          {!collapsed ? (
            <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
              Prospecting
            </p>
          ) : null}
          {PRIMARY_NAV.map((item) => (
            <NavItemLink
              key={item.to}
              item={item}
              collapsed={collapsed}
              onNavigate={onNavigate}
              count={counts[item.to]}
            />
          ))}
        </div>
        <div className="space-y-0.5 border-t border-sidebar-border pt-4">
          {!collapsed ? (
            <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
              Data & operations
            </p>
          ) : null}
          {SECONDARY_NAV.map((item) => (
            <NavItemLink key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>
      </nav>
    </TooltipProvider>
  );
}

function DatasetPill() {
  const { mode, label, description, status, isLoading, error, refetch } = useDatasetMode();
  if (isLoading) return <Badge variant="outline" className="animate-pulse text-xs">Checking dataset…</Badge>;
  // A failed status request is NOT "no dataset" and must never be reported as
  // demo data: say the truth and offer a retry.
  if (error && !status) {
    return (
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <StatusPill ok={false} label="Dataset status unavailable" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs text-xs">
            <p className="font-medium">The dataset status request failed.</p>
            <p className="text-muted-foreground">{(error as Error).message}</p>
            <button type="button" className="mt-1 font-medium text-primary hover:underline" onClick={() => void refetch()}>
              Retry
            </button>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <StatusPill ok={mode === "real"} label={label} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-xs">
          <p className="font-medium">{status?.bucket ?? "company-intel-data"}</p>
          <p className="text-muted-foreground">
            {description}
            {mode === "real" && status?.lastIndexedAt ? ` Published ${relativeTime(status.lastIndexedAt)}.` : ""}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const mounted = useHydrated();
  const next = (resolvedTheme ?? theme) === "dark" ? "light" : "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="size-8"
      onClick={() => setTheme(next)}
    >
      {mounted && (resolvedTheme ?? theme) === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

type SearchScope = "companies" | "people";

/**
 * Global search, reachable from every screen.
 *
 * `⌘K` / `Ctrl+K` focuses it. The scope toggle decides whether Enter opens the
 * company workspace or the people workspace, so one field serves both indexes
 * without pretending they are the same query.
 */
function GlobalSearch({ autoFocusKey }: { autoFocusKey: number }) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<SearchScope>("companies");
  const inputRef = useRef<HTMLInputElement>(null);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    if (autoFocusKey > 0) inputRef.current?.focus();
  }, [autoFocusKey]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const query = value.trim();
    if (!query) return;
    navigate(`${scope === "people" ? "/people" : "/companies"}?q=${encodeURIComponent(query)}`);
    setValue("");
  };

  return (
    <form onSubmit={submit} role="search" className="relative w-full max-w-xl">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={scope === "people" ? "Search people by name — typos are fine" : "Search companies — typos are fine"}
        aria-label={scope === "people" ? "Search people" : "Search companies"}
        className="h-9 pl-9 pr-24 text-sm"
      />
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        <div className="flex overflow-hidden rounded-md border border-border/70" role="group" aria-label="Search scope">
          <button
            type="button"
            onClick={() => setScope("companies")}
            aria-pressed={scope === "companies"}
            title="Search companies"
            className={cn(
              "flex items-center gap-1 px-1.5 py-1 text-[10px] font-medium transition-colors",
              scope === "companies" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Building2 className="size-3" />
            <span className="hidden xl:inline">Companies</span>
          </button>
          <button
            type="button"
            onClick={() => setScope("people")}
            aria-pressed={scope === "people"}
            title="Search people"
            className={cn(
              "flex items-center gap-1 px-1.5 py-1 text-[10px] font-medium transition-colors",
              scope === "people" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <UserRound className="size-3" />
            <span className="hidden xl:inline">People</span>
          </button>
        </div>
        <kbd className="hidden items-center gap-0.5 rounded border border-border/70 bg-muted px-1 py-0.5 text-[10px] text-muted-foreground sm:inline-flex">
          {isMac ? <Command className="size-2.5" /> : "Ctrl"}K
        </kbd>
      </div>
    </form>
  );
}

function WorkspaceMenu() {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Workspace menu">
          <span className="flex size-6 items-center justify-center rounded-full bg-primary/12 text-[10px] font-semibold text-primary">
            CI
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Private workspace · single operator
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/dashboard")}>
          <LayoutDashboard className="mr-2 size-3.5" /> Overview
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/people")}>
          <Users className="mr-2 size-3.5" /> Find people
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/exports")}>
          <FileDown className="mr-2 size-3.5" /> Exports
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/dataset")}>
          <Database className="mr-2 size-3.5" /> Dataset & coverage
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/settings")}>
          <SettingsIcon className="mr-2 size-3.5" /> Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppLayout() {
  const {
    mode,
    label,
    status: dataset,
    error: datasetError,
    isLoading: datasetLoading,
    refetch: refetchDataset,
  } = useDatasetMode();
  useDatasetVersionSync();
  const { collapsed, toggle } = useCollapsedRail();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchFocus((value) => value + 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <TooltipProvider delayDuration={300}>
        {/* Desktop rail */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-sidebar-border bg-sidebar py-3 transition-[width,padding] duration-200 ease-out lg:flex",
            collapsed ? "w-16 px-2" : "w-64 px-3",
          )}
        >
          <div className={cn("flex items-center gap-2 pb-4", collapsed ? "justify-center px-0" : "px-1")}>
            <BrandMark collapsed={collapsed} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <NavGroups collapsed={collapsed} />
          </div>
          <div className={cn("space-y-3 pt-4", collapsed ? "flex flex-col items-center px-0" : "px-1")}>
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <StatusPill ok={mode === "real"} label={mode === "real" ? "Live" : mode === "demo" ? "Demo" : "No data"} />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs text-xs">
                  {label}
                </TooltipContent>
              </Tooltip>
            ) : (
              <>
                <DatasetPill />
                <div className="rounded-lg border border-sidebar-border bg-background/60 p-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Access</p>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    {apiMode === "worker"
                      ? "Cloudflare Access enforces one approved identity on the app and every API route."
                      : mode === "demo"
                        ? "Preview: the bundled sample dataset is serving this screen."
                        : "Preview: no R2 dataset is published, so there are no real records."}
                  </p>
                </div>
              </>
            )}
            <Button
              variant="ghost"
              size={collapsed ? "icon" : "sm"}
              onClick={toggle}
              className={cn("gap-2 text-muted-foreground", collapsed ? "size-8" : "w-full justify-start")}
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              title={collapsed ? "Expand navigation" : "Collapse navigation"}
            >
              {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
              {collapsed ? null : "Collapse"}
            </Button>
          </div>
        </aside>
      </TooltipProvider>

      {/* Mobile header */}
      <div className="sticky top-0 z-40 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-2 backdrop-blur lg:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Open navigation">
              <Menu className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 overflow-y-auto bg-sidebar p-4">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <div className="pb-4">
              <BrandMark />
            </div>
            <NavGroups collapsed={false} onNavigate={() => setMobileOpen(false)} />
            <div className="mt-6 border-t border-sidebar-border pt-4">
              <DatasetPill />
            </div>
          </SheetContent>
        </Sheet>
        <BrandMark />
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <WorkspaceMenu />
        </div>
      </div>

      <div className={cn("transition-[padding] duration-200 ease-out", collapsed ? "lg:pl-16" : "lg:pl-64")}>
        <header className="sticky top-0 z-20 hidden items-center gap-4 border-b border-border/70 bg-background/85 px-6 py-2.5 backdrop-blur lg:flex">
          <GlobalSearch autoFocusKey={searchFocus} />
          <div className="ml-auto flex items-center gap-2">
            <DatasetPill />
            <ThemeToggle />
            <WorkspaceMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1560px] space-y-6 px-4 py-6 sm:px-6 lg:py-8">
          <div className="lg:hidden">
            <GlobalSearch autoFocusKey={searchFocus} />
          </div>
          {datasetError && !dataset ? (
            <ErrorBlock error={datasetError as Error} onRetry={() => void refetchDataset()} />
          ) : datasetLoading ? null : mode === "demo" ? (
            <DatasetModeBanner mode="demo" detail={dataset?.message} />
          ) : mode === "no-dataset" ? (
            <DatasetModeBanner mode="no-dataset" detail={dataset?.message} />
          ) : null}
          <Outlet />
        </main>
        <footer className="mx-auto flex w-full max-w-[1560px] flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 px-4 pb-8 pt-4 text-[11px] text-muted-foreground sm:px-6">
          <span className="inline-flex items-center gap-1.5">
            <UserRound className="size-3" /> CompanyIntel · private single-operator workspace
          </span>
          <span aria-hidden>·</span>
          <span>Cloudflare Workers + R2</span>
          <span aria-hidden>·</span>
          <span>
            {datasetError && !dataset
              ? "Dataset status unavailable"
              : datasetLoading
                ? "Checking dataset state…"
                : mode === "real"
                  ? label
                  : mode === "demo"
                    ? "Demo mode (bundled sample data)"
                    : "No dataset indexed"}
          </span>
        </footer>
      </div>
    </div>
  );
}
