/**
 * Lead Lists.
 *
 * A list is a tag on the saved leads themselves, which keeps lists inside the
 * application's existing durable store (the Worker's `app-data/leads/*` objects in
 * R2) instead of inventing a second database. Consequences that matter:
 *
 *   - a list always describes real saved leads, so it can never contain a
 *     dangling reference to a record that was removed;
 *   - adding or removing an item edits exactly those leads, with the same
 *     compare-and-set write the Saved Leads screen uses;
 *   - the name of an empty list is kept in this browser only, because there is no
 *     lead to carry it. It becomes durable the moment the first lead is added.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Building2, FileDown, ListPlus, Pencil, Plus, Search, Trash2, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, LoadingBlock, PageHeader } from "@/components/common";
import { downloadExportFile, useCreateExport, useLeads, useUpdateLead } from "@/hooks/use-api";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SavedLead } from "@/shared/models";

const EMPTY_LISTS_KEY = "companyintel.empty-lead-lists";

function readEmptyLists(): string[] {
  try {
    const raw = window.localStorage.getItem(EMPTY_LISTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function writeEmptyLists(names: string[]) {
  try {
    window.localStorage.setItem(EMPTY_LISTS_KEY, JSON.stringify([...new Set(names)]));
  } catch {
    /* storage can be unavailable; the tag-backed lists still persist in R2 */
  }
}

function leadTitle(lead: SavedLead): string {
  return lead.kind === "company" ? lead.name : lead.fullName;
}

function leadSubtitle(lead: SavedLead): string {
  return lead.kind === "company" ? (lead.industry ?? "Company") : `${lead.title ?? "Contact"} · ${lead.companyName}`;
}

export default function LeadLists() {
  const leads = useLeads();
  const updateLead = useUpdateLead();
  const createExport = useCreateExport();
  const [active, setActive] = useState<string | null>(null);
  const [emptyLists, setEmptyLists] = useState<string[]>(() => (typeof window === "undefined" ? [] : readEmptyLists()));
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set());
  const [listSearch, setListSearch] = useState("");

  const all = useMemo(() => leads.data?.leads ?? [], [leads.data]);

  const lists = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lead of all) {
      for (const tag of lead.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    for (const name of emptyLists) if (!counts.has(name)) counts.set(name, 0);
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [all, emptyLists]);

  const selectedList = active && lists.some((list) => list.name === active) ? active : (lists[0]?.name ?? null);
  const items = useMemo(() => {
    if (!selectedList) return [];
    const term = listSearch.trim().toLowerCase();
    return all.filter((lead) => {
      if (!lead.tags.includes(selectedList)) return false;
      if (!term) return true;
      return `${leadTitle(lead)} ${leadSubtitle(lead)}`.toLowerCase().includes(term);
    });
  }, [all, selectedList, listSearch]);

  const addable = useMemo(() => {
    if (!selectedList) return [];
    return all.filter((lead) => !lead.tags.includes(selectedList));
  }, [all, selectedList]);

  function persistEmpty(next: string[]) {
    setEmptyLists(next);
    writeEmptyLists(next);
  }

  function createList() {
    const name = newName.trim();
    if (!name) return;
    if (lists.some((list) => list.name.toLowerCase() === name.toLowerCase())) {
      toast.error("A list with that name already exists.");
      return;
    }
    persistEmpty([...emptyLists, name]);
    setActive(name);
    setNewName("");
    setCreateOpen(false);
    toast.success(`Created “${name}”. Add saved leads to it now.`);
  }

  function renameList() {
    if (!selectedList) return;
    const name = renameValue.trim();
    if (!name) return;
    if (lists.some((list) => list.name !== selectedList && list.name.toLowerCase() === name.toLowerCase())) {
      toast.error("A list with that name already exists.");
      return;
    }
    const affected = all.filter((lead) => lead.tags.includes(selectedList));
    for (const lead of affected) {
      updateLead.mutate({ id: lead.id, tags: [...new Set(lead.tags.map((tag) => (tag === selectedList ? name : tag)))] });
    }
    persistEmpty(emptyLists.map((existing) => (existing === selectedList ? name : existing)));
    setActive(name);
    setRenameOpen(false);
    toast.success(`Renamed to “${name}”.`);
  }

  function deleteList() {
    if (!selectedList) return;
    for (const lead of all.filter((entry) => entry.tags.includes(selectedList))) {
      updateLead.mutate({ id: lead.id, tags: lead.tags.filter((tag) => tag !== selectedList) });
    }
    persistEmpty(emptyLists.filter((name) => name !== selectedList));
    setActive(null);
    setDeleteOpen(false);
    toast.success("List deleted. The leads themselves were not removed.");
  }

  function addLeads() {
    if (!selectedList) return;
    for (const id of addSelected) {
      const lead = all.find((entry) => entry.id === id);
      if (!lead) continue;
      updateLead.mutate({ id, tags: [...new Set([...lead.tags, selectedList])] });
    }
    setAddSelected(new Set());
    setAddOpen(false);
    toast.success(`Added ${addSelected.size} lead${addSelected.size === 1 ? "" : "s"} to “${selectedList}”.`);
  }

  function removeFromList(lead: SavedLead) {
    if (!selectedList) return;
    updateLead.mutate({ id: lead.id, tags: lead.tags.filter((tag) => tag !== selectedList) });
  }

  return (
    <>
      <PageHeader
        eyebrow="Pipeline"
        title="Lead lists"
        description="Organise saved companies and contacts into focused working lists. Lists are stored with the leads themselves, so they survive reloads and are private to this deployment."
        actions={
          <Button className="gap-2" onClick={() => setCreateOpen(true)}>
            <ListPlus className="size-4" />
            New list
          </Button>
        }
      />

      {leads.isLoading ? (
        <LoadingBlock label="Reading saved leads" rows={6} />
      ) : lists.length === 0 ? (
        <EmptyState
          icon={<ListPlus className="size-5" />}
          title="No lead lists yet"
          description="Create a list, then add saved leads to it. Save a company or a person from search first if your pipeline is empty."
          action={
            <div className="flex gap-2">
              <Button onClick={() => setCreateOpen(true)}>Create a list</Button>
              <Button variant="outline" asChild>
                <Link to="/companies">Find companies</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="surface h-fit overflow-hidden">
            <div className="border-b border-border/70 px-4 py-3">
              <p className="text-sm font-semibold">Your lists</p>
              <p className="text-[11px] text-muted-foreground">{lists.length} list{lists.length === 1 ? "" : "s"}</p>
            </div>
            <ul className="max-h-[60vh] overflow-y-auto p-1.5">
              {lists.map((list) => (
                <li key={list.name}>
                  <button
                    type="button"
                    onClick={() => {
                      setActive(list.name);
                      setListSearch("");
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      selectedList === list.name ? "bg-primary/10 text-primary" : "hover:bg-accent",
                    )}
                  >
                    <span className="truncate">{list.name}</span>
                    <span className="tabular ml-auto rounded-full bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-border">
                      {list.count}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <div className="min-w-0 space-y-4">
            {selectedList ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold tracking-tight">{selectedList}</h2>
                  <Badge variant="outline" className="font-normal">
                    {formatNumber(items.length)} records
                  </Badge>
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setAddOpen(true)}>
                      <Plus className="size-3.5" />
                      Add leads
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={() => {
                        setRenameValue(selectedList);
                        setRenameOpen(true);
                      }}
                    >
                      <Pencil className="size-3.5" />
                      Rename
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground" onClick={() => setDeleteOpen(true)}>
                      <Trash2 className="size-3.5" />
                      Delete
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 gap-1.5"
                      disabled={items.length === 0 || createExport.isPending}
                      onClick={() =>
                        createExport.mutate(
                          {
                            kind: "leads",
                            leadIds: items.map((lead) => lead.id),
                            columns: ["kind", "name", "companyName", "title", "email", "phone", "linkedinUrl", "status", "tags", "notes", "savedAt"],
                          },
                          { onSuccess: (job) => void downloadExportFile(job.id) },
                        )
                      }
                    >
                      <FileDown className="size-3.5" />
                      Export
                    </Button>
                  </div>
                </div>

                <div className="relative max-w-sm">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={listSearch}
                    onChange={(event) => setListSearch(event.target.value)}
                    placeholder="Search within this list"
                    className="h-8 pl-8 text-xs"
                    aria-label="Search within this list"
                  />
                </div>

                <div className="surface overflow-hidden">
                  {items.length === 0 ? (
                    <div className="px-5 py-10 text-center">
                      <p className="text-sm font-medium">This list is empty</p>
                      <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                        Add saved leads to it, or save new companies and people from search.
                      </p>
                      <Button className="mt-4" size="sm" onClick={() => setAddOpen(true)}>
                        Add saved leads
                      </Button>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="min-w-[220px]">Record</TableHead>
                            <TableHead className="min-w-[180px]">Company / title</TableHead>
                            <TableHead className="w-28">Status</TableHead>
                            <TableHead className="min-w-[160px]">Tags</TableHead>
                            <TableHead className="w-10" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {items.map((lead) => (
                            <TableRow key={lead.id} className="text-[13px]">
                              <TableCell>
                                <Link
                                  to={lead.kind === "company" ? `/companies/${lead.companyId}` : `/contacts/${lead.contactId}`}
                                  className="inline-flex items-center gap-2 font-medium hover:text-primary"
                                >
                                  {lead.kind === "company" ? (
                                    <Building2 className="size-3.5 text-muted-foreground" />
                                  ) : (
                                    <UserRound className="size-3.5 text-muted-foreground" />
                                  )}
                                  {leadTitle(lead)}
                                </Link>
                              </TableCell>
                              <TableCell className="max-w-[260px] truncate text-muted-foreground">{leadSubtitle(lead)}</TableCell>
                              <TableCell className="capitalize text-muted-foreground">{lead.status.replace("-", " ")}</TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {lead.tags.map((tag) => (
                                    <Badge key={tag} variant="outline" className="font-normal">
                                      {tag}
                                    </Badge>
                                  ))}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7 text-muted-foreground"
                                  aria-label={`Remove ${leadTitle(lead)} from ${selectedList}`}
                                  onClick={() => removeFromList(lead)}
                                >
                                  <X className="size-3.5" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New lead list</DialogTitle>
            <DialogDescription>Name the list, then add saved leads to it from the list screen.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="list-name">List name</Label>
            <Input
              id="list-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="e.g. Q4 logistics prospects"
              onKeyDown={(event) => {
                if (event.key === "Enter") createList();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createList} disabled={!newName.trim()}>
              Create list
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename list</DialogTitle>
            <DialogDescription>The new name is applied to every lead currently in this list.</DialogDescription>
          </DialogHeader>
          <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={renameList} disabled={!renameValue.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{selectedList}”?</DialogTitle>
            <DialogDescription>
              The list tag is removed from {items.length} lead{items.length === 1 ? "" : "s"}. The leads themselves stay in your pipeline.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteList}>
              Delete list
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setAddSelected(new Set());
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add leads to “{selectedList}”</DialogTitle>
            <DialogDescription>Only saved leads can be added. Save records from company or people search first.</DialogDescription>
          </DialogHeader>
          {addable.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every saved lead is already in this list.</p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border/70 p-1.5">
              {addable.map((lead) => (
                <li key={lead.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                    <Checkbox
                      checked={addSelected.has(lead.id)}
                      onCheckedChange={() =>
                        setAddSelected((current) => {
                          const next = new Set(current);
                          if (next.has(lead.id)) next.delete(lead.id);
                          else next.add(lead.id);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{leadTitle(lead)}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{leadSubtitle(lead)}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addLeads} disabled={addSelected.size === 0}>
              Add {addSelected.size || ""} lead{addSelected.size === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
