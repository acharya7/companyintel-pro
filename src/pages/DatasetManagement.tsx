/**
 * Dataset management.
 *
 * This screen reports what R2 actually contains. There is no button that claims
 * to run a 60 GB index inside a Worker — indexing is a local, resumable process,
 * and the commands to run it are shown here verbatim.
 */

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Database, HardDrive, Layers, RefreshCw, RotateCcw, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader, Section, StatCard, StatusPill } from "@/components/common";
import { useActivateDataset, useDatasetStatus, useValidateDataset } from "@/hooks/use-api";
import { formatBytes, formatDate, formatNumber, relativeTime } from "@/lib/format";

const INDEX_COMMANDS = [
  {
    label: "1 · Profile both CSV files",
    command: "bun tools/indexer/src/cli.ts profile --config tools/indexer/indexer.config.json",
    note: "Prints headers, sample values, encoding and row estimates for each file before any indexing work starts.",
  },
  {
    label: "2 · Sample index (10k / 100k rows)",
    command:
      "bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --sample 100000 --version v1-sample",
    note: "Validates schema mapping, dedup rules and shard output on representative samples of both files.",
  },
  {
    label: "3 · Full index (both files, resumable)",
    command:
      "bun tools/indexer/src/cli.ts run --config tools/indexer/indexer.config.json --version v1 --upload",
    note: "Streams both files, writes checkpoints, uploads shards to R2 and publishes the version only after validation passes.",
  },
  {
    label: "4 · Verify the published version",
    command: "bun tools/indexer/src/cli.ts validate --version v1",
    note: "Re-checks object counts, sizes and checksums against the manifest.",
  },
];

export default function DatasetManagement() {
  const status = useDatasetStatus();
  const validate = useValidateDataset();
  const activate = useActivateDataset();
  const [activateTarget, setActivateTarget] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  if (status.isLoading) {
    return (
      <>
        <PageHeader title="Dataset management" description="Checking R2 state…" />
        <LoadingBlock label="Reading R2 manifests" rows={5} />
      </>
    );
  }

  if (status.error || !status.data) {
    return (
      <>
        <PageHeader title="Dataset management" />
        <ErrorBlock error={(status.error as Error) ?? new Error("No dataset status available")} onRetry={() => status.refetch()} />
      </>
    );
  }

  const data = status.data;
  const activeVersion = data.versions.find((version) => version.version === data.activeVersion);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Dataset management"
        description="R2 connectivity, source files, index versions and validation state. Every value here comes from stored objects or an R2 read."
        actions={
          <>
            <Button variant="outline" className="gap-2" onClick={() => status.refetch()}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            {data.activeVersion ? (
              <Button
                variant="outline"
                className="gap-2"
                disabled={validate.isPending}
                onClick={() => validate.mutate(data.activeVersion!)}
              >
                <CheckCircle2 className="size-4" />
                Validate active version
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Bucket"
          value={data.bucket}
          hint={data.bucketOk ? "Binding reachable" : data.bucketError ?? "Binding not reachable"}
          icon={<Database className="size-4" />}
        />
        <StatCard
          label="Active version"
          value={data.activeVersion ?? "none"}
          hint={data.indexed ? `Published ${relativeTime(data.lastIndexedAt)}` : "No validated version published"}
          icon={<Layers className="size-4" />}
        />
        <StatCard
          label="Index size"
          value={activeVersion ? formatBytes(activeVersion.bytes) : "—"}
          hint={activeVersion ? `${formatNumber(activeVersion.objectCount)} objects` : "Nothing published"}
          icon={<HardDrive className="size-4" />}
        />
        <StatCard
          label="Data origin"
          value={data.dataOrigin === "sample" ? "Sample" : "R2 index"}
          hint={data.dataOrigin === "sample" ? "Preview only — not your dataset" : "Serving the published index"}
          icon={<Database className="size-4" />}
          tone={data.dataOrigin === "sample" ? "accent" : "default"}
        />
      </div>

      <Section
        title="Source files in R2"
        description="The two original CSV files under raw/. Sizes are read from object metadata; validation confirms existence."
      >
        {data.sources.length === 0 ? (
          <EmptyState
            icon={<HardDrive className="size-5" />}
            title="No source objects reported"
            description="The dataset manifest lists the sources used to build a version. Until a version is published (or the Worker can reach R2), file names and sizes are unknown rather than assumed."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/70">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source id</TableHead>
                  <TableHead>Object key</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Last modified</TableHead>
                  <TableHead>Verified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sources.map((source) => (
                  <TableRow key={source.id}>
                    <TableCell className="font-mono text-xs">{source.id}</TableCell>
                    <TableCell className="font-mono text-xs">{source.key}</TableCell>
                    <TableCell className="tabular">{source.sizeBytes === null ? "—" : formatBytes(source.sizeBytes)}</TableCell>
                    <TableCell>{source.lastModified ? formatDate(source.lastModified) : "—"}</TableCell>
                    <TableCell>
                      <StatusPill ok={source.verified} label={source.verified ? "verified" : "not verified"} />
                      {source.error ? (
                        <p className="mt-1 max-w-md text-[11px] leading-4 text-muted-foreground">{source.error}</p>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Section title="Index versions" description="Immutable, versioned objects. Switching versions is atomic and reversible.">
          {data.versions.length === 0 ? (
            <EmptyState
              icon={<Layers className="size-5" />}
              title="No index versions found"
              description="Publish a version with the local indexer to populate manifests/. Rollback is available as soon as a second version exists."
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border/70">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Companies</TableHead>
                    <TableHead>Contacts</TableHead>
                    <TableHead>Rejected</TableHead>
                    <TableHead>Published</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.versions.map((version) => (
                    <TableRow key={version.version}>
                      <TableCell className="font-mono text-xs">
                        {version.version}
                        {version.version === data.activeVersion ? (
                          <Badge className="ml-2 text-[10px]" variant="secondary">
                            active
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {version.state}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular">{formatNumber(version.counters.uniqueCompanies)}</TableCell>
                      <TableCell className="tabular">{formatNumber(version.counters.uniqueContacts)}</TableCell>
                      <TableCell className="tabular">{formatNumber(version.counters.rowsRejected)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {version.completedAt ? relativeTime(version.completedAt) : formatDate(version.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => validate.mutate(version.version)} disabled={validate.isPending}>
                            Validate
                          </Button>
                          {version.version !== data.activeVersion ? (
                            <Button
                              size="sm"
                              className="gap-1.5"
                              disabled={!version.validationPassed}
                              title={version.validationPassed ? "Activate this version" : "Only validated versions can be activated"}
                              onClick={() => {
                                setConfirmText("");
                                setActivateTarget(version.version);
                              }}
                            >
                              <RotateCcw className="size-3.5" />
                              Activate
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>

        <div className="space-y-6">
          <Section title="Indexing status" description="Written by the local indexer while it runs">
            {data.indexing ? (
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Version</dt>
                  <dd className="font-mono">{data.indexing.version}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Stage</dt>
                  <dd>{data.indexing.stage}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Rows read</dt>
                  <dd className="tabular">{formatNumber(data.indexing.rowsRead)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Rate</dt>
                  <dd className="tabular">{data.indexing.rowsPerSecond ? `${formatNumber(Math.round(data.indexing.rowsPerSecond))} rows/s` : "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">ETA</dt>
                  <dd className="tabular">
                    {data.indexing.etaSeconds ? `${Math.round(data.indexing.etaSeconds / 60)} min` : "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd>{relativeTime(data.indexing.updatedAt)}</dd>
                </div>
                <p className="pt-2 text-[11px] leading-5 text-muted-foreground">{data.indexing.message}</p>
              </dl>
            ) : (
              <div className="flex gap-2 rounded-lg border border-border/70 bg-muted/25 p-3 text-[11px] leading-5 text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <p>
                  No indexing job is running. Indexing happens on your own machine against the local CSV files; the
                  Worker only reads the finished, published index.
                </p>
              </div>
            )}
          </Section>

          <Section title="How to index" description="Windows-compatible commands, run from the project root">
            <ol className="space-y-4">
              {INDEX_COMMANDS.map((step) => (
                <li key={step.label}>
                  <p className="text-xs font-medium">{step.label}</p>
                  <pre className="mt-1.5 overflow-x-auto rounded-md border border-border/70 bg-muted/40 p-2.5 text-[11px] leading-5">
                    <code>{step.command}</code>
                  </pre>
                  <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{step.note}</p>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Terminal className="size-3.5" />
              <span>
                Paths live in <span className="font-mono">tools/indexer/indexer.config.json</span>. Set them to your two
                local CSV files; nothing is hard-coded.
              </span>
            </div>
          </Section>
        </div>
      </div>

      <Dialog open={Boolean(activateTarget)} onOpenChange={(open) => (!open ? setActivateTarget(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activate dataset version {activateTarget}</DialogTitle>
            <DialogDescription>
              This flips the active-version pointer. The previous version stays in R2 and can be reactivated at any
              time. Cached search and contact pages are invalidated automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground" htmlFor="confirm-version">
              Type the version id to confirm
            </label>
            <Input id="confirm-version" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} placeholder={activateTarget ?? ""} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActivateTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={confirmText !== activateTarget}
              onClick={() => {
                if (!activateTarget) return;
                activate.mutate(activateTarget, { onSuccess: () => setActivateTarget(null) });
              }}
            >
              Activate version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
