/**
 * Public landing page.
 *
 * There is no signup: the application is a private, single-identity deployment
 * behind Cloudflare Access, so every call to action leads straight into the
 * console rather than into an account flow.
 */

import { Link } from "react-router";
import { useTheme } from "next-themes";
import {
  ArrowRight,
  Building2,
  Database,
  FileDown,
  Gauge,
  Layers,
  Lock,
  Moon,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const FEATURES = [
  {
    icon: Search,
    title: "Typo-tolerant company search",
    body: "Trigram, token and prefix indexes built at ingest time. “Microsft”, “Googel” and “Tata Consultency” resolve to the right company without scanning a single CSV row.",
  },
  {
    icon: Users,
    title: "Contact discovery per company",
    body: "Server-side filtering by designation, department, seniority, country and coverage, with bounded pagination — never tens of thousands of rows in one response.",
  },
  {
    icon: Star,
    title: "Saved leads with notes and tags",
    body: "Track a personal pipeline across six statuses, keep notes, and export any slice of it. Leads persist in R2, so they survive reloads and devices.",
  },
  {
    icon: FileDown,
    title: "Safe CSV exports",
    body: "Filenames, UTF-8 and formula-injection protection are handled for you. Exports are staged and never built from an unbounded memory load.",
  },
  {
    icon: Layers,
    title: "Four-layer caching",
    body: "TanStack Query in memory, IndexedDB across reloads, edge caching only where it is provably safe, and immutable versioned index objects in R2.",
  },
  {
    icon: Database,
    title: "Dataset versions and rollback",
    body: "Indexes publish atomically behind an active-version pointer. A failed build never touches the version you are searching.",
  },
];

const PIPELINE = [
  {
    step: "01",
    title: "Raw files stay in R2",
    body: "Both CSVs are uploaded once to company-intel-data/raw/. The originals are never modified by the application.",
  },
  {
    step: "02",
    title: "Local streaming indexer",
    body: "A Windows-friendly Node engine reads the files, normalizes names, deduplicates conservatively and writes compressed shards — staged locally, then uploaded.",
  },
  {
    step: "03",
    title: "Worker answers bounded reads",
    body: "Queries touch a handful of small shard objects. Nothing scans the source files at request time, and every route verifies Cloudflare Access first.",
  },
];

const DEMO = [
  { typed: "Microsft", found: "Microsoft Corporation", tag: "Spelling corrected" },
  { typed: "Tata Consultency", found: "Tata Consultancy Services Limited", tag: "Spelling corrected" },
  { typed: "Infosys Ltd", found: "Infosys Limited", tag: "Name variant" },
  { typed: "Hindustan Uniliver", found: "Hindustan Unilever Limited", tag: "Spelling corrected" },
];

function ThemeButton() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(dark ? "light" : "dark")}>
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-5 py-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Building2 className="size-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight">CompanyIntel</span>
          <Badge variant="outline" className="ml-1 hidden text-[11px] font-normal text-muted-foreground sm:inline-flex">
            private deployment
          </Badge>
          <nav className="ml-auto flex items-center gap-1">
            <a href="#capabilities" className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground sm:block">
              Capabilities
            </a>
            <a href="#pipeline" className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground sm:block">
              Pipeline
            </a>
            <ThemeButton />
            <Button size="sm" className="gap-1.5" asChild>
              <Link to="/dashboard">
                Open console
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-40 h-96 opacity-60"
            style={{
              background:
                "radial-gradient(60% 60% at 50% 50%, color-mix(in oklch, var(--primary) 18%, transparent) 0%, transparent 70%)",
            }}
          />
          <div className="mx-auto grid w-full max-w-6xl gap-12 px-5 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:py-24">
            <div className="relative">
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5 text-primary" />
                Cloudflare Access · single approved identity
              </span>
              <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
                Company intelligence that
                <span className="text-primary"> survives typos</span>.
              </h1>
              <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">
                Search a large private company and contact database, find the people who matter, save them as leads and
                export clean prospect lists. Built entirely on Cloudflare Workers and R2 — no external database, no
                per-seat tooling.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button size="lg" className="gap-2" asChild>
                  <Link to="/companies">
                    <Search className="size-4" />
                    Search companies
                  </Link>
                </Button>
                <Button size="lg" variant="outline" className="gap-2" asChild>
                  <Link to="/dashboard">
                    <Gauge className="size-4" />
                    View dataset status
                  </Link>
                </Button>
              </div>
              <dl className="mt-10 grid max-w-lg grid-cols-3 gap-6 border-t border-border/60 pt-6">
                {[
                  { k: "Storage", v: "R2 only" },
                  { k: "Backend", v: "Workers" },
                  { k: "Index reads", v: "bounded" },
                ].map((item) => (
                  <div key={item.k}>
                    <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{item.k}</dt>
                    <dd className="mt-1 text-sm font-medium">{item.v}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Product preview */}
            <div className="relative">
              <div className="surface-raised overflow-hidden">
                <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-4 py-2.5">
                  <span className="size-2.5 rounded-full bg-destructive/50" />
                  <span className="size-2.5 rounded-full bg-chart-3/60" />
                  <span className="size-2.5 rounded-full bg-chart-2/60" />
                  <span className="ml-2 text-[11px] text-muted-foreground">companyintel · company search</span>
                </div>
                <div className="space-y-4 p-5">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <div className="flex h-10 items-center rounded-md border border-input bg-background pl-9 pr-3 text-sm">
                      Microsft
                      <span className="ml-1 inline-block h-4 w-px animate-pulse bg-primary" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    {DEMO.map((row) => (
                      <div key={row.typed} className="flex items-center gap-3 rounded-lg border border-border/70 bg-background px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-muted-foreground">“{row.typed}”</p>
                          <p className="truncate text-sm font-medium">{row.found}</p>
                        </div>
                        <Badge variant="outline" className="shrink-0 border-chart-3/50 bg-chart-3/12 text-[11px] font-normal text-chart-3">
                          {row.tag}
                        </Badge>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    Illustrative behaviour of the index — results always come from your indexed data, never from a
                    fabricated list.
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {["Exact", "Name variants", "Prefix", "Spelling corrected", "Hedged suggestions"].map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[11px] font-normal">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section id="capabilities" className="border-t border-border/60 bg-muted/25">
          <div className="mx-auto w-full max-w-6xl px-5 py-16">
            <div className="max-w-2xl">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Capabilities</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                Everything a company intelligence workspace needs — nothing it does not.
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Built for one user with two very large CSV files, so the design optimises for accurate matching, low
                operating cost and predictable reads instead of multi-tenant features you would never use.
              </p>
            </div>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="surface p-5">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <feature.icon className="size-4" />
                  </span>
                  <h3 className="mt-4 text-sm font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pipeline */}
        <section id="pipeline" className="border-t border-border/60">
          <div className="mx-auto w-full max-w-6xl px-5 py-16">
            <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Pipeline</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                  Both source files become one searchable namespace.
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  The 10&nbsp;GB and 50&nbsp;GB files may have different column structures, so each is profiled
                  independently and mapped into one canonical model. Records merge only on strong identity evidence —
                  a verified domain, a canonical LinkedIn company URL or a source-provided id. Similar names are never
                  merged, and two different companies never share contacts.
                </p>
                <div className="mt-6 flex flex-wrap gap-2">
                  {["Exact index", "Prefix index", "Token index", "Trigram index", "Manifests", "Checksums"].map((item) => (
                    <Badge key={item} variant="outline" className="text-[11px] font-normal">
                      {item}
                    </Badge>
                  ))}
                </div>
              </div>
              <ol className="space-y-3">
                {PIPELINE.map((item) => (
                  <li key={item.step} className="surface flex gap-4 p-5">
                    <span className="tabular text-sm font-semibold text-primary">{item.step}</span>
                    <div>
                      <h3 className="text-sm font-semibold">{item.title}</h3>
                      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-border/60 bg-muted/25">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-14 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Lock className="mt-0.5 size-5 text-primary" />
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Private by default</h2>
                <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">
                  There is no public registration, no guest mode and no shared cache of your contact data. Cloudflare
                  Access verifies a signed token on every request before any dataset work happens.
                </p>
              </div>
            </div>
            <Button size="lg" className="gap-2" asChild>
              <Link to="/dashboard">
                <Sparkles className="size-4" />
                Open the console
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>CompanyIntel — original branding and interface. Not affiliated with any other lead-generation platform.</p>
          <p>Cloudflare Workers · R2 · React + TypeScript</p>
        </div>
      </footer>
    </div>
  );
}
