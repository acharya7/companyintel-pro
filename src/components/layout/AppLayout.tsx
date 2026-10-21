/**
 * Application shell: fixed sidebar rail + top bar + content area.
 *
 * Desktop-first, collapsing to a slide-over sheet on small screens. The top bar
 * carries the global company search, the dataset status, and the theme switch so
 * those are reachable from every screen.
 */

import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useTheme } from "next-themes";
import {
  Building2,
  Cloud,
  Database,
  FileDown,
  LayoutDashboard,
  Library,
  Menu,
  Moon,
  Search,
  Settings as SettingsIcon,
  Star,
  Sun,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DatasetModeBanner, ErrorBlock, StatusPill } from "@/components/common";
import { useDatasetMode, useLeads, useSavedSearches } from "@/hooks/use-api";
import { useHydrated } from "@/hooks/use-hydrated";
import { apiMode, relativeTime } from "@/lib/format-bridge";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, hint: "Dataset health and recent activity" },
  { to: "/companies", label: "Company Search", icon: Search, hint: "Typo-tolerant company lookup" },
  { to: "/contacts", label: "Contacts", icon: Users, hint: "People attached to your selected companies" },
  { to: "/leads", label: "Saved Leads", icon: Star, hint: "Your pipeline and notes" },
  { to: "/saved-searches", label: "Saved Searches", icon: Library, hint: "Reusable queries" },
  { to: "/exports", label: "Exports", icon: FileDown, hint: "Generated CSV files" },
  { to: "/dataset", label: "Dataset", icon: Database, hint: "R2 index status and versions" },
  { to: "/indexing", label: "Cloud Indexing", icon: Cloud, hint: "Container job state, checkpoints and cost" },
  { to: "/settings", label: "Settings", icon: SettingsIcon, hint: "Search, cache and privacy" },
] as const;

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Building2 className="size-4" />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight">CompanyIntel</span>
        <span className="block text-[11px] text-muted-foreground">Private company intelligence</span>
      </span>
    </div>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const { data: leads } = useLeads();
  const { data: searches } = useSavedSearches();
  const counts: Record<string, number | undefined> = {
    "/leads": leads?.total,
    "/saved-searches": searches?.length,
  };

  return (
    <nav className="space-y-0.5">
      {NAV.map((item) => (
        <TooltipProvider key={item.to} delayDuration={600}>
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to={item.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                  )
                }
              >
                <item.icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
                {counts[item.to] ? (
                  <span className="tabular ml-auto rounded-full bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-border">
                    {counts[item.to]}
                  </span>
                ) : null}
              </NavLink>
            </TooltipTrigger>
            <TooltipContent side="right">{item.hint}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ))}
    </nav>
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
  // The resolved theme is only known after hydration (`next-themes` reads the
  // document), so the icon is gated on that instead of on a `mounted` flag that
  // a mount effect had to flip.
  const mounted = useHydrated();
  const next = (resolvedTheme ?? theme) === "dark" ? "light" : "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {mounted && (resolvedTheme ?? theme) === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

/**
 * The header search field clears itself when the header leaves the company-search
 * area. That used to be an effect + `setState`; keying the field on it instead
 * lets React remount a fresh (empty) field, with no cascading render and the same
 * behaviour for back/forward navigation.
 */
function GlobalSearch() {
  const location = useLocation();
  const onCompanies = location.pathname.startsWith("/companies");
  return <GlobalSearchField key={onCompanies ? "companies" : "elsewhere"} />;
}

function GlobalSearchField() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");

  return (
    <form
      className="relative w-full max-w-md"
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        if (!query) return;
        navigate(`/companies?q=${encodeURIComponent(query)}`);
      }}
      role="search"
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search companies — typos are fine (e.g. Microsft)"
        aria-label="Search companies"
        className="pl-9"
      />
    </form>
  );
}

export function AppLayout() {
  const { mode, label, status: dataset, error: datasetError, refetch: refetchDataset } = useDatasetMode();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 lg:flex">
        <div className="px-1.5 pb-5">
          <BrandMark />
        </div>
        <NavItems />
        <div className="mt-auto space-y-3 px-1.5 pt-6">
          <DatasetPill />
          <div className="rounded-lg border border-sidebar-border bg-background/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Access</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              {apiMode === "worker"
                ? "Cloudflare Access enforces a single approved identity on the app and every API route."
                : "Preview: running on sample data. Production requires Cloudflare Access and a published R2 index."}
            </p>
          </div>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="sticky top-0 z-40 flex items-center gap-2 border-b border-border/70 bg-background/90 px-3 py-2.5 backdrop-blur lg:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 bg-sidebar p-4">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <div className="pb-4">
              <BrandMark />
            </div>
            <NavItems onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
        <BrandMark />
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 hidden items-center gap-4 border-b border-border/70 bg-background/80 px-6 py-3 backdrop-blur lg:flex">
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            <DatasetPill />
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1500px] space-y-6 px-4 py-6 sm:px-6 lg:py-8">
          <div className="lg:hidden">
            <GlobalSearch />
          </div>
          {datasetError && !dataset ? (
            <ErrorBlock error={datasetError as Error} onRetry={() => void refetchDataset()} />
          ) : mode === "demo" ? (
            <DatasetModeBanner mode="demo" detail={dataset?.message} />
          ) : mode === "no-dataset" ? (
            <DatasetModeBanner mode="no-dataset" detail={dataset?.message} />
          ) : null}
          <Outlet />
        </main>
        <footer className="mx-auto w-full max-w-[1500px] px-4 pb-8 text-[11px] text-muted-foreground sm:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-4">
            <span>CompanyIntel · private single-user deployment</span>
            <span aria-hidden>·</span>
            <span>Cloudflare Workers + R2</span>
            <span aria-hidden>·</span>
            <span>{mode === "real" ? label : mode === "demo" ? "Demo mode (bundled sample data)" : "No dataset indexed"}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
