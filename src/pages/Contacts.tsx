/**
 * Contacts.
 *
 * Global contact browsing is deliberately scoped: it lists contacts for the
 * companies you have selected (saved leads, recently viewed, or picked from
 * search). A full-dataset contact scan is not offered, because it would require
 * an index this deployment does not build — the API says so explicitly instead
 * of pretending.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Building2, Copy, FileDown, Linkedin, Mail, Search, Star, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ASSOCIATION_CATEGORY_HINTS, ASSOCIATION_CATEGORY_LABELS } from "@/shared/association";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader, Pager, Section } from "@/components/common";
import { ContactNumbers } from "@/components/contact-numbers";
import {
  api,
  downloadExportFile,
  useCompanySearch,
  useContacts,
  useCreateExport,
  useDatasetStatus,
  useLeads,
  useSaveLead,
} from "@/hooks/use-api";
import { formatNumber } from "@/lib/format";
import { readRecentCompanies } from "@/lib/recent";
import { RealDataCoverageNotice } from "@/components/realdata";
import type { ContactFilters, ContactSortField, SortOrder } from "@/shared/models";

interface PickedCompany {
  id: string;
  name: string;
}

export default function Contacts() {
  const leads = useLeads();
  const dataset = useDatasetStatus();
  const saveLead = useSaveLead();
  const createExport = useCreateExport();

  const savedCompanies = useMemo<PickedCompany[]>(
    () =>
      (leads.data?.leads ?? [])
        .filter((lead) => lead.kind === "company")
        .map((lead) => ({ id: lead.kind === "company" ? lead.companyId : "", name: lead.kind === "company" ? lead.name : "" })),
    [leads.data],
  );
  const recentCompanies = useMemo<PickedCompany[]>(() => readRecentCompanies().map((c) => ({ id: c.id, name: c.name })), []);

  const [picked, setPicked] = useState<PickedCompany[]>([]);
  const [pickerQuery, setPickerQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<ContactSortField>("name");
  const [order, setOrder] = useState<SortOrder>("asc");
  const [filters, setFilters] = useState<ContactFilters>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const picker = useCompanySearch({
    query: pickerQuery.trim().length >= 2 ? pickerQuery : "",
    page: 1,
    pageSize: 8,
    sort: "relevance",
    order: "desc",
    fuzzy: true,
    resultBudget: 200,
    filters: {},
  });

  const companyIds = picked.map((company) => company.id);
  const contacts = useContacts({ companyIds, page, pageSize, sort, order, filters }, companyIds.length > 0);

  const datasetVersion = contacts.data?.datasetVersion ?? dataset.data?.activeVersion ?? "unknown";
  const rows = contacts.data?.contacts ?? [];
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  function addCompany(company: PickedCompany) {
    setPicked((current) => (current.some((item) => item.id === company.id) ? current : [...current, company]));
    setPickerQuery("");
    setPage(1);
  }

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Contacts"
        description="Browse and filter the people attached to the companies you are working on, then save or export them."
        actions={
          <>
            {selected.size > 0 ? (
              <>
                <Button
                  variant="outline"
                  className="gap-2"
                  disabled={createExport.isPending}
                  onClick={() =>
                    createExport.mutate(
                      {
                        kind: "contacts",
                        contactIds: [...selected],
                        columns: [
                          "fullName",
                          "title",
                          "designation",
                          "seniority",
                          "department",
                          "email",
                          "phone",
                          "mobile",
                          "additionalPhones",
                          "linkedinUrl",
                          "companyName",
                          "country",
                          "city",
                        ],
                      },
                      { onSuccess: (job) => void downloadExportFile(job.id) },
                    )
                  }
                >
                  <FileDown className="size-4" />
                  Export {selected.size}
                </Button>
                <Button
                  className="gap-2"
                  onClick={() => {
                    void Promise.all(
                      [...selected].map((id) =>
                        api.getContact(id).then(({ contact, companyName }) =>
                          saveLead.mutateAsync({
                            kind: "contact",
                            targetId: contact.id,
                            datasetVersion,
                            snapshot: { fullName: contact.fullName, companyName: companyName ?? null, title: contact.title ?? null },
                          }),
                        ),
                      ),
                    ).then(() => setSelected(new Set()));
                  }}
                >
                  <Star className="size-4" />
                  Save {selected.size}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <RealDataCoverageNotice className="mb-4" compact />

      <Section
        title="Companies in scope"
        description="Add companies from search, your saved leads or recently viewed history"
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {picked.length === 0 ? (
              <p className="text-xs text-muted-foreground">No companies selected yet — contact lists are scoped per company.</p>
            ) : (
              picked.map((company) => (
                <span key={company.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs">
                  <Building2 className="size-3 text-muted-foreground" />
                  <Link to={`/companies/${company.id}`} className="max-w-[200px] truncate hover:text-primary">
                    {company.name}
                  </Link>
                  <button
                    type="button"
                    aria-label={`Remove ${company.name}`}
                    onClick={() => setPicked((current) => current.filter((item) => item.id !== company.id))}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))
            )}
          </div>

          <div className="relative max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={pickerQuery}
              onChange={(event) => setPickerQuery(event.target.value)}
              placeholder="Add a company by name…"
              aria-label="Add a company"
            />
            {pickerQuery.trim().length >= 2 && (picker.data?.hits.length ?? 0) > 0 ? (
              <div className="surface-raised absolute left-0 right-0 top-[calc(100%+6px)] z-30 p-1.5">
                {picker.data!.hits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-accent"
                    onClick={() => addCompany({ id: hit.id, name: hit.name })}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{hit.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[hit.industry, hit.country].filter(Boolean).join(" · ") || "No metadata"}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-[11px] text-muted-foreground">{formatNumber(hit.contactCount)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            {savedCompanies.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setPicked((current) => dedupe([...current, ...savedCompanies]))}>
                Add {savedCompanies.length} saved companies
              </Button>
            ) : null}
            {recentCompanies.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setPicked((current) => dedupe([...current, ...recentCompanies]))}>
                Add {recentCompanies.length} recently viewed
              </Button>
            ) : null}
            {picked.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setPicked([])}>
                Clear selection
              </Button>
            ) : null}
          </div>
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <Section
          title="Contacts"
          description={
            companyIds.length
              ? `${formatNumber(contacts.data?.page.total ?? 0)} contacts across ${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"}`
              : "Add at least one company to list contacts"
          }
        >
          {companyIds.length === 0 ? (
            <EmptyState
              icon={<Users className="size-5" />}
              title="No companies selected"
              description="Contact retrieval is company-scoped by design: the index stores contacts grouped by company, so a bounded read returns exactly the people you asked for."
            />
          ) : contacts.isLoading ? (
            <LoadingBlock label="Loading contacts" rows={6} />
          ) : contacts.error ? (
            <ErrorBlock error={contacts.error as Error} onRetry={() => contacts.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState title="No contacts match these filters" description="Clear a filter to widen the result set." />
          ) : (
            <div className="space-y-4">
              <div className="overflow-hidden rounded-lg border border-border/70">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={() =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (allSelected) rows.forEach((row) => next.delete(row.id));
                              else rows.forEach((row) => next.add(row.id));
                              return next;
                            })
                          }
                          aria-label="Select all rows on this page"
                        />
                      </TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead className="hidden md:table-cell">Company</TableHead>
                      <TableHead className="hidden lg:table-cell">Location</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((contact) => {
                      const companyName = picked.find((company) => company.id === contact.companyId)?.name ?? "";
                      return (
                        <TableRow key={contact.id}>
                          <TableCell>
                            <Checkbox
                              checked={selected.has(contact.id)}
                              onCheckedChange={(checked) =>
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (checked) next.add(contact.id);
                                  else next.delete(contact.id);
                                  return next;
                                })
                              }
                              aria-label={`Select ${contact.fullName}`}
                            />
                          </TableCell>
                          <TableCell>
                            <p className="font-medium">{contact.fullName}</p>
                            <p className="text-[11px] text-muted-foreground">{contact.title ?? "—"}</p>
                            <ContactNumbers contact={contact} className="mt-1" showLabels={false} />
                            {contact.association && contact.association.category !== "high_confidence" ? (
                              <Badge
                                variant="outline"
                                className="mt-1 border-chart-3/50 bg-chart-3/12 text-[10px] font-normal text-chart-3"
                                title={ASSOCIATION_CATEGORY_HINTS[contact.association.category]}
                              >
                                {ASSOCIATION_CATEGORY_LABELS[contact.association.category]}
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell className="hidden max-w-[200px] truncate md:table-cell">
                            <Link to={`/companies/${contact.companyId}`} className="hover:text-primary">
                              {companyName || contact.companyId}
                            </Link>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            {[contact.city, contact.country].filter(Boolean).join(", ") || "—"}
                          </TableCell>
                          <TableCell>
                            {contact.email ? (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1.5 text-primary hover:underline"
                                onClick={() => void navigator.clipboard?.writeText(contact.email!)}
                              >
                                <Mail className="size-3.5" />
                                <span className="max-w-[180px] truncate">{contact.email}</span>
                              </button>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              {contact.linkedinUrl ? (
                                <Button variant="ghost" size="icon-sm" asChild title="Open LinkedIn profile">
                                  <a href={contact.linkedinUrl} target="_blank" rel="noreferrer noopener">
                                    <Linkedin className="size-3.5" />
                                  </a>
                                </Button>
                              ) : null}
                              <Button variant="ghost" size="icon-sm" title="Copy contact id" onClick={() => void navigator.clipboard?.writeText(contact.id)}>
                                <Copy className="size-3.5" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                                onClick={() =>
                                  saveLead.mutate({
                                    kind: "contact",
                                    targetId: contact.id,
                                    datasetVersion,
                                    snapshot: { fullName: contact.fullName, companyName, title: contact.title ?? null },
                                  })
                                }
                              >
                                <Star className="size-3.5" />
                                Save
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Sort</span>
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    value={sort}
                    onChange={(event) => {
                      setSort(event.target.value as ContactSortField);
                      setPage(1);
                    }}
                    aria-label="Sort contacts"
                  >
                    <option value="name">Contact name</option>
                    <option value="title">Job title</option>
                    <option value="country">Country</option>
                  </select>
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    value={order}
                    onChange={(event) => {
                      setOrder(event.target.value as SortOrder);
                      setPage(1);
                    }}
                    aria-label="Sort direction"
                  >
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                </div>
                <Pager
                  page={contacts.data!.page.page}
                  pageSize={contacts.data!.page.pageSize}
                  total={contacts.data!.page.total}
                  hasMore={contacts.data!.page.hasMore}
                  onPage={setPage}
                  onPageSize={(size) => {
                    setPageSize(size);
                    setPage(1);
                  }}
                />
              </div>
            </div>
          )}
        </Section>

        <Section title="Filters" description="Applied per company">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="contacts-email" className="text-xs font-normal">
                Email available
              </Label>
              <Switch
                id="contacts-email"
                checked={Boolean(filters.hasEmail)}
                onCheckedChange={(checked) => {
                  setFilters((current) => ({ ...current, hasEmail: checked || undefined }));
                  setPage(1);
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="contacts-phone" className="text-xs font-normal">
                Phone / mobile available
              </Label>
              <Switch
                id="contacts-phone"
                checked={Boolean(filters.hasPhone)}
                onCheckedChange={(checked) => {
                  setFilters((current) => ({ ...current, hasPhone: checked || undefined }));
                  setPage(1);
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="contacts-linkedin" className="text-xs font-normal">
                LinkedIn available
              </Label>
              <Switch
                id="contacts-linkedin"
                checked={Boolean(filters.hasLinkedin)}
                onCheckedChange={(checked) => {
                  setFilters((current) => ({ ...current, hasLinkedin: checked || undefined }));
                  setPage(1);
                }}
              />
            </div>
            {(
              [
                { key: "designation", label: "Designation" },
                { key: "department", label: "Department" },
                { key: "seniority", label: "Seniority" },
                { key: "country", label: "Country" },
                { key: "city", label: "City" },
              ] as const
            ).map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`contacts-${field.key}`} className="text-xs">
                  {field.label}
                </Label>
                <Input
                  id={`contacts-${field.key}`}
                  className="h-8 text-xs"
                  value={filters[field.key] ?? ""}
                  placeholder="Exact value"
                  onChange={(event) => {
                    setFilters((current) => ({ ...current, [field.key]: event.target.value || undefined }));
                    setPage(1);
                  }}
                />
              </div>
            ))}
            {Object.values(filters).some(Boolean) ? (
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => {
                  setFilters({});
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            ) : null}
            <p className="text-[11px] leading-5 text-muted-foreground">
              Filters are applied to each company's contact partition, which is bounded, so they are exact for the
              companies in scope.
            </p>
            {contacts.data ? (
              <Badge variant="outline" className="font-normal">
                Dataset {contacts.data.datasetVersion}
              </Badge>
            ) : null}
          </div>
        </Section>
      </div>
    </>
  );
}

function dedupe(companies: PickedCompany[]): PickedCompany[] {
  const seen = new Set<string>();
  return companies.filter((company) => {
    if (seen.has(company.id)) return false;
    seen.add(company.id);
    return true;
  });
}
