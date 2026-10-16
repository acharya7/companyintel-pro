/**
 * Settings: search defaults, caching layers and privacy controls.
 */

import { useEffect, useState } from "react";
import { Database, HardDrive, Layers, Lock, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageHeader, Section, StatCard } from "@/components/common";
import { apiBaseUrl, apiMode, useSettings, useUpdateSettings } from "@/hooks/use-api";
import { clearPersistentCache, persistentCache, configurePersistentCache } from "@/lib/api/client";
import { cacheMetrics } from "@/lib/cache/persistent-cache";
import { formatBytes, formatNumber } from "@/lib/format";
import type { CompanySortField, SortOrder, UserSettings } from "@/shared/models";

export default function Settings() {
  const settings = useSettings();
  const update = useUpdateSettings();
  /**
   * Edits made on this screen. `null` means "show what the server returned".
   *
   * Deriving the form value this way (`localDraft ?? server`) instead of copying
   * the server value into state from an effect means: no double render on load,
   * no effect to keep the two in sync, and a background refetch can never
   * clobber what the user has typed.
   */
  const [localDraft, setLocalDraft] = useState<UserSettings | null>(null);
  const [cacheStats, setCacheStats] = useState<{ entries: number; bytes: number; redactedEntries: number } | null>(null);

  useEffect(() => {
    // `cacheStats` is browser state (IndexedDB), not server state: read it once
    // after mount and after an explicit refresh, never during render.
    let active = true;
    void persistentCache.stats().then((stats) => {
      if (active) setCacheStats(stats);
    });
    return () => {
      active = false;
    };
  }, []);

  const draft = localDraft ?? settings.data ?? null;

  if (!draft) {
    return (
      <>
        <PageHeader title="Settings" description="Loading preferences…" />
      </>
    );
  }

  const totalLookups = cacheMetrics.hits + cacheMetrics.misses;
  const hitRate = totalLookups ? cacheMetrics.hits / totalLookups : 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.data);

  /**
   * Apply one field edit. `draft` already resolves to `localDraft ?? server`, so
   * building the next value from it keeps edits on top of each other; `set` is
   * only reachable below the `!draft` guard above.
   */
  const base = draft;
  function set<K extends keyof UserSettings>(key: K, value: UserSettings[K]) {
    setLocalDraft({ ...base, [key]: value });
  }

  /** Re-read the browser cache counters (after clearing, or on demand). */
  async function refreshStats() {
    setCacheStats(await persistentCache.stats());
  }

  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Search behaviour, caching layers, and what gets retained in your browser."
        actions={
          <Button
            className="gap-2"
            disabled={!dirty || update.isPending}
            onClick={() =>
              update.mutate({
                theme: draft.theme,
                pageSize: draft.pageSize,
                fuzzySearch: draft.fuzzySearch,
                defaultSort: draft.defaultSort,
                defaultOrder: draft.defaultOrder,
                resultBudget: draft.resultBudget,
                cacheEnabled: draft.cacheEnabled,
                cacheMaxEntries: draft.cacheMaxEntries,
                cacheTtlMinutes: draft.cacheTtlMinutes,
                edgeCacheEnabled: draft.edgeCacheEnabled,
                retainContactFieldsInCache: draft.retainContactFieldsInCache,
              })
            }
          >
            <Save className="size-4" />
            {dirty ? "Save changes" : "Saved"}
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="API mode"
          value={apiMode === "worker" ? "Cloudflare Worker" : "Sample (preview)"}
          hint={apiMode === "worker" ? apiBaseUrl || "same origin" : "Synthetic data only — not your dataset"}
          icon={<Database className="size-4" />}
          tone={apiMode === "worker" ? "default" : "accent"}
        />
        <StatCard
          label="Browser cache entries"
          value={cacheStats ? formatNumber(cacheStats.entries) : "—"}
          hint={cacheStats ? `${formatBytes(cacheStats.bytes)} stored in IndexedDB` : "Reading cache…"}
          icon={<HardDrive className="size-4" />}
        />
        <StatCard
          label="Cache hit rate"
          value={`${(hitRate * 100).toFixed(1)}%`}
          hint={`${formatNumber(cacheMetrics.hits)} hits · ${formatNumber(cacheMetrics.misses)} misses · ${formatNumber(cacheMetrics.evictions)} evictions`}
          icon={<Layers className="size-4" />}
        />
        <StatCard
          label="Access control"
          value="Cloudflare Access"
          hint="Every API route verifies a signed Access JWT before touching data."
          icon={<ShieldCheck className="size-4" />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Search defaults" description="Applied when you open the company search screen">
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="page-size">Rows per page</Label>
              <Input
                id="page-size"
                type="number"
                min={5}
                max={100}
                value={draft.pageSize}
                onChange={(event) => set("pageSize", Number(event.target.value))}
                className="h-9 w-32"
              />
              <p className="text-[11px] text-muted-foreground">Between 5 and 100 rows.</p>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="fuzzy-default" className="text-sm">
                  Fuzzy matching by default
                </Label>
                <p className="text-[11px] text-muted-foreground">Enables typo and transposition tolerance.</p>
              </div>
              <Switch id="fuzzy-default" checked={draft.fuzzySearch} onCheckedChange={(checked) => set("fuzzySearch", checked)} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="default-sort">Default sort</Label>
                <select
                  id="default-sort"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={draft.defaultSort}
                  onChange={(event) => set("defaultSort", event.target.value as CompanySortField)}
                >
                  <option value="relevance">Relevance</option>
                  <option value="name">Company name</option>
                  <option value="contactCount">Contact count</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="default-order">Direction</Label>
                <select
                  id="default-order"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={draft.defaultOrder}
                  onChange={(event) => set("defaultOrder", event.target.value as SortOrder)}
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="result-budget">Scoring budget (candidates per search)</Label>
              <Input
                id="result-budget"
                type="number"
                min={100}
                max={2000}
                step={50}
                value={draft.resultBudget}
                onChange={(event) => set("resultBudget", Number(event.target.value))}
                className="h-9 w-40"
              />
              <p className="text-[11px] leading-5 text-muted-foreground">
                A hard ceiling on how many candidates are scored. Larger values improve recall on vague queries and cost
                more CPU; 800 is a good balance for this dataset size.
              </p>
            </div>
          </div>
        </Section>

        <Section title="Caching" description="Four layers: TanStack Query, IndexedDB, edge (opt-in) and immutable R2 objects">
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="cache-enabled" className="text-sm">
                  Persistent browser cache
                </Label>
                <p className="text-[11px] text-muted-foreground">Reuse search results and company pages across reloads.</p>
              </div>
              <Switch
                id="cache-enabled"
                checked={draft.cacheEnabled}
                onCheckedChange={(checked) => {
                  set("cacheEnabled", checked);
                  configurePersistentCache({ enabled: checked });
                }}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="cache-ttl">Entry lifetime (minutes)</Label>
                <Input
                  id="cache-ttl"
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.cacheTtlMinutes}
                  onChange={(event) => set("cacheTtlMinutes", Number(event.target.value))}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cache-entries">Maximum entries</Label>
                <Input
                  id="cache-entries"
                  type="number"
                  min={0}
                  max={5000}
                  value={draft.cacheMaxEntries}
                  onChange={(event) => set("cacheMaxEntries", Number(event.target.value))}
                  className="h-9"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="cache-contacts" className="text-sm">
                  Keep email and phone in the browser cache
                </Label>
                <p className="text-[11px] leading-5 text-muted-foreground">
                  Off by default: cached contact pages have email and phone stripped so a shared machine does not
                  accumulate contactable data.
                </p>
              </div>
              <Switch
                id="cache-contacts"
                checked={draft.retainContactFieldsInCache}
                onCheckedChange={(checked) => {
                  set("retainContactFieldsInCache", checked);
                  configurePersistentCache({ redactContacts: !checked });
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="edge-cache" className="text-sm">
                  Edge caching of search responses
                </Label>
                <p className="text-[11px] leading-5 text-muted-foreground">
                  Disabled by default. Cloudflare Access runs before the Worker on cache hits too, but this app keeps
                  private contact data out of shared caches unless you deliberately opt in.
                </p>
              </div>
              <Switch id="edge-cache" checked={draft.edgeCacheEnabled} onCheckedChange={(checked) => set("edgeCacheEnabled", checked)} />
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
              <Button variant="outline" size="sm" className="gap-2" onClick={() => void refreshStats()}>
                <RefreshCw className="size-3.5" />
                Refresh cache stats
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={async () => {
                  await clearPersistentCache();
                  await refreshStats();
                }}
              >
                <Trash2 className="size-3.5" />
                Clear browser cache
              </Button>
              {cacheStats ? (
                <Badge variant="outline" className="font-normal">
                  {formatNumber(cacheStats.entries)} entries · {formatBytes(cacheStats.bytes)}
                  {cacheStats.redactedEntries ? ` · ${formatNumber(cacheStats.redactedEntries)} redacted` : ""}
                </Badge>
              ) : null}
            </div>
          </div>
        </Section>
      </div>

      <Section title="Privacy and security" description="What this deployment does and does not do">
        <ul className="grid gap-4 sm:grid-cols-2">
          {[
            {
              icon: Lock,
              title: "No internal login system",
              body: "Access is granted by Cloudflare Access for one approved identity. The app has no signup, password or guest flow to attack.",
            },
            {
              icon: ShieldCheck,
              title: "Signed-token verification",
              body: "The Worker verifies the Access JWT signature, issuer, audience and expiry on every API request — a forged header is rejected.",
            },
            {
              icon: Database,
              title: "Private object storage",
              body: "The R2 bucket is private and only reached through the Worker binding. No public r2.dev URL and no S3 keys inside the Worker.",
            },
            {
              icon: HardDrive,
              title: "Bounded browser retention",
              body: "IndexedDB entries are capped, expire, and are evicted least-recently-used first. Clearing them never affects your saved leads.",
            },
          ].map((item) => (
            <li key={item.title} className="flex gap-3 rounded-lg border border-border/70 bg-muted/20 p-4">
              <item.icon className="mt-0.5 size-4 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
