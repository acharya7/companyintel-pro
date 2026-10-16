/**
 * Saved leads.
 *
 * Leads are stored in R2 through the Worker (one small shard object per lead
 * partition, written with compare-and-set). In preview mode the sample adapter
 * keeps them in localStorage, and the banner above the page makes that clear.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Building2, Copy, FileDown, Linkedin, Mail, NotebookPen, Star, Trash2, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, PageHeader, Section, StatCard } from "@/components/common";
import { downloadExportFile, useCreateExport, useDeleteLead, useLeads, useUpdateLead } from "@/hooks/use-api";
import { formatNumber, leadStatusLabel, relativeTime } from "@/lib/format";
import { LEAD_STATUSES } from "@/shared/models";
import type { LeadStatus, SavedLead } from "@/shared/models";
import { Checkbox } from "@/components/ui/checkbox";

const PAGE_SIZE = 20;

export default function SavedLeads() {
  const leads = useLeads();
  const updateLead = useUpdateLead();
  const deleteLead = useDeleteLead();
  const createExport = useCreateExport();

  const [status, setStatus] = useState<LeadStatus | "all">("all");
  const [kind, setKind] = useState<"all" | "company" | "contact">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noteFor, setNoteFor] = useState<SavedLead | null>(null);
  const [noteText, setNoteText] = useState("");
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});

  // Memoised so the `?? []` fallback cannot hand `useMemo` a brand-new array on
  // every render, which would re-run the filters and the status count below for
  // nothing (react-hooks/exhaustive-deps flags exactly that).
  const all = useMemo(() => leads.data?.leads ?? [], [leads.data]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter((lead) => {
      if (status !== "all" && lead.status !== status) return false;
      if (kind !== "all" && lead.kind !== kind) return false;
      if (!term) return true;
      const haystack = lead.kind === "company" ? `${lead.name} ${lead.industry ?? ""}` : `${lead.fullName} ${lead.companyName} ${lead.title ?? ""}`;
      return haystack.toLowerCase().includes(term);
    });
  }, [all, status, kind, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const rows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const counts = useMemo(() => {
    const map = new Map<LeadStatus, number>();
    for (const lead of all) map.set(lead.status, (map.get(lead.status) ?? 0) + 1);
    return map;
  }, [all]);

  const companyLeads = all.filter((lead) => lead.kind === "company");
  const contactLeads = all.filter((lead) => lead.kind === "contact");

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="Pipeline"
        title="Saved leads"
        description="Companies and people you are working. Statuses are personal workflow labels — the application never claims outreach happened."
        actions={
          <>
            <Button
              variant="outline"
              className="gap-2"
              disabled={createExport.isPending || all.length === 0}
              onClick={() =>
                createExport.mutate(
                  {
                    kind: "leads",
                    leadIds: selected.size ? [...selected] : undefined,
                    columns: ["kind", "name", "companyName", "title", "email", "linkedinUrl", "status", "tags", "notes", "savedAt"],
                  },
                  { onSuccess: (job) => void downloadExportFile(job.id) },
                )
              }
            >
              <FileDown className="size-4" />
              {selected.size ? `Export ${selected.size} leads` : "Export all leads"}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Saved companies" value={formatNumber(companyLeads.length)} hint="Companies in your pipeline" icon={<Building2 className="size-4" />} />
        <StatCard label="Saved contacts" value={formatNumber(contactLeads.length)} hint="People in your pipeline" icon={<User className="size-4" />} />
        <StatCard label="With notes" value={formatNumber(all.filter((lead) => lead.notes.length > 0).length)} hint="Leads carrying research notes" icon={<NotebookPen className="size-4" />} />
        <StatCard label="Qualified" value={formatNumber(counts.get("qualified") ?? 0)} hint="Marked as qualified in your workflow" icon={<Star className="size-4" />} />
      </div>

      <Section
        title="Leads"
        description={`${formatNumber(filtered.length)} of ${formatNumber(all.length)} leads`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-48 text-xs"
              placeholder="Search leads…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              aria-label="Search saved leads"
            />
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as typeof kind);
                setPage(1);
              }}
              aria-label="Filter by lead type"
            >
              <option value="all">All types</option>
              <option value="company">Companies</option>
              <option value="contact">Contacts</option>
            </select>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as LeadStatus | "all");
                setPage(1);
              }}
              aria-label="Filter by status"
            >
              <option value="all">All statuses</option>
              {LEAD_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {leadStatusLabel(value)} ({(counts.get(value) ?? 0).toString()})
                </option>
              ))}
            </select>
          </div>
        }
      >
        {leads.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading saved leads…</p>
        ) : all.length === 0 ? (
          <EmptyState
            icon={<Star className="size-5" />}
            title="No saved leads yet"
            description="Save companies from search results, or individual contacts from a company page, and they will appear here with status, tags and notes."
            action={
              <Button asChild>
                <Link to="/companies">Search companies</Link>
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="No leads match these filters" description="Try a different status or clear the search box." />
        ) : (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg border border-border/70">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Lead</TableHead>
                    <TableHead className="hidden md:table-cell">Company</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Tags</TableHead>
                    <TableHead className="hidden lg:table-cell">Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((lead) => (
                    <TableRow key={lead.id}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(lead.id)}
                          onCheckedChange={(checked) => toggle(lead.id, Boolean(checked))}
                          aria-label={`Select ${lead.kind === "company" ? lead.name : lead.fullName}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {lead.kind === "company" ? <Building2 className="size-3.5 text-muted-foreground" /> : <User className="size-3.5 text-muted-foreground" />}
                          {lead.kind === "company" ? (
                            <Link to={`/companies/${lead.companyId}`} className="font-medium hover:text-primary">
                              {lead.name}
                            </Link>
                          ) : (
                            <div>
                              <p className="font-medium">{lead.fullName}</p>
                              <p className="text-[11px] text-muted-foreground">{lead.title ?? "—"}</p>
                            </div>
                          )}
                        </div>
                        {lead.notes.length ? (
                          <p className="mt-1 max-w-[280px] truncate text-[11px] text-muted-foreground">
                            {lead.notes[lead.notes.length - 1].text}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden max-w-[200px] truncate md:table-cell">
                        {lead.kind === "company" ? lead.name : lead.companyName}
                      </TableCell>
                      <TableCell>
                        <select
                          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                          value={lead.status}
                          aria-label={`Status for ${lead.kind === "company" ? lead.name : lead.fullName}`}
                          onChange={(event) => updateLead.mutate({ id: lead.id, status: event.target.value as LeadStatus })}
                        >
                          {LEAD_STATUSES.map((value) => (
                            <option key={value} value={value}>
                              {leadStatusLabel(value)}
                            </option>
                          ))}
                        </select>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <div className="flex flex-wrap items-center gap-1">
                          {lead.tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-[10px] font-normal">
                              {tag}
                            </Badge>
                          ))}
                          <Input
                            className="h-6 w-20 text-[10px]"
                            placeholder="+ tag"
                            value={tagDraft[lead.id] ?? ""}
                            onChange={(event) => setTagDraft((current) => ({ ...current, [lead.id]: event.target.value }))}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              const value = (tagDraft[lead.id] ?? "").trim();
                              if (!value) return;
                              updateLead.mutate({ id: lead.id, tags: [...lead.tags, value] });
                              setTagDraft((current) => ({ ...current, [lead.id]: "" }));
                            }}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-[11px] text-muted-foreground lg:table-cell">
                        {relativeTime(lead.updatedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {lead.kind === "contact" && lead.email ? (
                            <Button variant="ghost" size="icon-sm" title={lead.email} onClick={() => void navigator.clipboard?.writeText(lead.email!)}>
                              <Mail className="size-3.5" />
                            </Button>
                          ) : null}
                          {lead.kind === "contact" && lead.linkedinUrl ? (
                            <Button variant="ghost" size="icon-sm" asChild title="Open LinkedIn profile">
                              <a href={lead.linkedinUrl} target="_blank" rel="noreferrer noopener">
                                <Linkedin className="size-3.5" />
                              </a>
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Add note"
                            aria-label="Add note"
                            onClick={() => {
                              setNoteFor(lead);
                              setNoteText("");
                            }}
                          >
                            <NotebookPen className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Copy lead id"
                            onClick={() => void navigator.clipboard?.writeText(lead.id)}
                          >
                            <Copy className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Remove lead"
                            aria-label="Remove lead"
                            onClick={() => deleteLead.mutate(lead.id)}
                          >
                            <Trash2 className="size-3.5 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {noteFor ? (
              <div className="rounded-lg border border-border/70 bg-muted/25 p-3">
                <p className="text-xs font-medium">
                  Notes · {noteFor.kind === "company" ? noteFor.name : noteFor.fullName}
                </p>
                {noteFor.notes.length ? (
                  <ul className="mt-2 space-y-1.5">
                    {noteFor.notes.map((note) => (
                      <li key={note.at} className="flex items-start justify-between gap-3 text-xs">
                        <span>{note.text}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(note.at)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">No notes yet.</p>
                )}
              </div>
            ) : null}

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Page {currentPage} of {pageCount}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </Section>

      <Dialog open={Boolean(noteFor)} onOpenChange={(open) => (!open ? setNoteFor(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a note</DialogTitle>
            <DialogDescription>
              Notes are stored with the lead in R2 and are never sent anywhere else.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="lead-note">Note</Label>
            <Textarea
              id="lead-note"
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              placeholder="What did you learn about this lead?"
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={!noteText.trim()}
              onClick={() => {
                if (!noteFor) return;
                updateLead.mutate(
                  { id: noteFor.id, addNote: noteText.trim() },
                  { onSuccess: () => setNoteFor(null) },
                );
              }}
            >
              Save note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
