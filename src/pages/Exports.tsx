/**
 * Exports: create and download CSV files.
 *
 * Rows are capped server-side, text values are defended against spreadsheet
 * formula injection, and the finished file is stored in R2 so a re-download
 * never re-runs the query.
 */

import { useState } from "react";
import { Link } from "react-router";
import { Download, FileDown, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader, Section } from "@/components/common";
import { RealDataCoverageNotice } from "@/components/realdata";
import { COMPANY_EXPORT_FIELDS, CONTACT_EXPORT_FIELDS } from "@/lib/api/types";
import { downloadExportFile, useCreateExport, useExports, useLeads, useSavedSearches } from "@/hooks/use-api";
import { formatBytes, formatNumber, relativeTime } from "@/lib/format";
import type { ExportRequestBody } from "@/shared/api-contract";

const COMPANY_COLUMNS = [...COMPANY_EXPORT_FIELDS];
const CONTACT_COLUMNS = [...CONTACT_EXPORT_FIELDS];

export default function Exports() {
  const exports = useExports();
  const leads = useLeads();
  const searches = useSavedSearches();
  const createExport = useCreateExport();

  const [kind, setKind] = useState<ExportRequestBody["kind"]>("leads");
  const [columns, setColumns] = useState<string[]>([
    "kind",
    "name",
    "companyName",
    "title",
    "email",
    "phone",
    "mobile",
    "status",
    "tags",
    "savedAt",
  ]);

  const availableColumns =
    kind === "contacts"
      ? CONTACT_COLUMNS
      : kind === "companies"
        ? COMPANY_COLUMNS
        : [
            "kind",
            "name",
            "companyName",
            "title",
            "email",
            "phone",
            "mobile",
            "additionalPhones",
            "linkedinUrl",
            "status",
            "tags",
            "notes",
            "savedAt",
          ];

  function toggleColumn(column: string) {
    setColumns((current) => (current.includes(column) ? current.filter((value) => value !== column) : [...current, column]));
  }

  function runExport() {
    const body: ExportRequestBody = { kind, columns };
    if (kind === "companies") {
      const ids = (leads.data?.leads ?? []).filter((lead) => lead.kind === "company").map((lead) => lead.kind === "company" ? lead.companyId : "");
      if (!ids.length) return;
      body.companyIds = ids;
    }
    createExport.mutate(body, { onSuccess: (job) => void downloadExportFile(job.id) });
  }

  return (
    <>
      <PageHeader
        eyebrow="Deliverables"
        title="Exports"
        description="Generate CSV files for selected leads, companies or contacts. Files are staged in R2 and can be re-downloaded."
        actions={
          <Button className="gap-2" onClick={runExport} disabled={createExport.isPending || columns.length === 0}>
            <FileDown className="size-4" />
            Create export
          </Button>
        }
      />

      <RealDataCoverageNotice className="mb-4" compact />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Section title="Export history" description="Newest first; stored under app-data/exports/ in the R2 bucket">
          {exports.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading exports…</p>
          ) : (exports.data?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<FileDown className="size-5" />}
              title="No exports yet"
              description="Create one from the panel on the right, or export directly from a company page, the contacts screen or your saved leads."
            />
          ) : (
            <ul className="divide-y divide-border/60">
              {(exports.data ?? []).map((job) => (
                <li key={job.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs">{job.filename}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {formatNumber(job.rowCount)} rows
                      </Badge>
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {formatBytes(job.bytes)}
                      </Badge>
                      {job.truncated ? (
                        <Badge variant="outline" className="border-chart-3/50 bg-chart-3/12 text-[10px] font-normal text-chart-3">
                          truncated at safety limit
                        </Badge>
                      ) : null}
                      <span className="text-[11px] text-muted-foreground">{relativeTime(job.createdAt)}</span>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" className="shrink-0 gap-2" onClick={() => void downloadExportFile(job.id)}>
                    <Download className="size-3.5" />
                    Download
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="space-y-6">
          <Section title="New export" description="Only columns that exist in the indexed data are offered">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="export-kind">What to export</Label>
                <select
                  id="export-kind"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={kind}
                  onChange={(event) => {
                    const next = event.target.value as ExportRequestBody["kind"];
                    setKind(next);
                    setColumns(
                      next === "contacts"
                        ? ["fullName", "title", "email", "phone", "mobile", "linkedinUrl", "companyName", "country", "city"]
                        : next === "companies"
                          ? ["name", "domain", "industry", "country", "city", "contactCount"]
                          : ["kind", "name", "companyName", "title", "email", "status", "tags", "savedAt"],
                    );
                  }}
                >
                  <option value="leads">Saved leads</option>
                  <option value="companies">Saved companies</option>
                  <option value="contacts">Contacts (selected companies)</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label>Columns</Label>
                <div className="grid max-h-64 grid-cols-1 gap-1.5 overflow-y-auto rounded-md border border-border/70 p-3 sm:grid-cols-2">
                  {availableColumns.map((column) => (
                    <label key={column} className="flex items-center gap-2 text-xs">
                      <Checkbox checked={columns.includes(column)} onCheckedChange={() => toggleColumn(column)} />
                      <span className="font-mono text-[11px]">{column}</span>
                    </label>
                  ))}
                </div>
              </div>

              <Button className="w-full gap-2" onClick={runExport} disabled={createExport.isPending || columns.length === 0}>
                <FileDown className="size-4" />
                Create and download
              </Button>

              <div className="flex gap-2 rounded-lg border border-border/70 bg-muted/25 p-3 text-[11px] leading-5 text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <p>
                  Exports are capped at 50,000 rows per file to keep the Worker request bounded. Text starting with
                  <span className="font-mono"> = + - @</span> is prefixed so spreadsheets cannot execute it as a formula.
                </p>
              </div>

              <div className="space-y-1.5 text-xs text-muted-foreground">
                <p>
                  Saved leads available: <span className="tabular font-medium text-foreground">{formatNumber(leads.data?.total ?? 0)}</span>
                </p>
                <p>
                  Saved searches available: <span className="tabular font-medium text-foreground">{formatNumber(searches.data?.length ?? 0)}</span>
                </p>
                <p>
                  For contact exports scoped to one company, open the company and use{" "}
                  <Link to="/companies" className="text-primary hover:underline">
                    its export action
                  </Link>
                  .
                </p>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
