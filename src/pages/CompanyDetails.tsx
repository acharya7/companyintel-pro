/**
 * Company detail.
 *
 * Contacts are fetched one bounded page at a time and filtered server-side
 * against the company's contact partition, so a company with tens of thousands
 * of contacts never loads them all into the browser.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import {
  ArrowLeft,
  Building2,
  Copy,
  ExternalLink,
  FileDown,
  Globe,
  Linkedin,
  Mail,
  Phone,
  Star,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  EmptyState,
  ErrorBlock,
  FacetList,
  InfoRow,
  LoadingBlock,
  PageHeader,
  Pager,
  Section,
  StatCard,
} from "@/components/common";
import {
  downloadExportFile,
  useCompany,
  useCompanyContacts,
  useCompanyUnassigned,
  useCreateExport,
  useDatasetStatus,
  useSaveLead,
  recordActivity,
} from "@/hooks/use-api";
import {
  ASSOCIATION_CATEGORY_HINTS,
  ASSOCIATION_CATEGORY_LABELS,
  type AssociationCategory,
} from "@/shared/association";
import { formatNumber, formatPercent } from "@/lib/format";
import { rememberCompany } from "@/lib/recent";
import type { ContactFilters, ContactSortField, SortOrder } from "@/shared/models";

/**
 * How many candidate companies an association decision left open.
 *
 * A stored record keeps at most `MAX_CANDIDATE_IDS` ids plus the real count, because
 * a shared name can have thousands of members; records written before the cap carry
 * the complete list. Both report the same number to a reviewer.
 */
function candidateCount(association: { candidateCompanyIds?: string[]; candidateCount?: number }): number {
  return association.candidateCount ?? association.candidateCompanyIds?.length ?? 0;
}

export default function CompanyDetails() {
  const { companyId } = useParams<{ companyId: string }>();
  const company = useCompany(companyId);
  const dataset = useDatasetStatus();
  const saveLead = useSaveLead();
  const createExport = useCreateExport();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<ContactSortField>("name");
  const [order, setOrder] = useState<SortOrder>("asc");
  const [filters, setFilters] = useState<ContactFilters>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewUnassigned, setReviewUnassigned] = useState(false);

  const contacts = useCompanyContacts(companyId, { page, pageSize, sort, order, filters });
  // Fetched only after the user asks to review the uncertain rows, so a company
  // profile never pays for a second object read it does not show.
  const unassigned = useCompanyUnassigned(companyId, { page: 1, pageSize: 25 }, reviewUnassigned);

  function toggleAssociation(category: AssociationCategory) {
    setFilters((current) => {
      const list = current.association ?? [];
      const next = list.includes(category) ? list.filter((item) => item !== category) : [...list, category];
      return { ...current, association: next.length ? next : undefined };
    });
    setPage(1);
  }

  useEffect(() => {
    if (company.data) {
      rememberCompany({ id: company.data.company.id, name: company.data.company.name });
      recordActivity({
        kind: "company-view",
        label: company.data.company.name,
        detail: `${formatNumber(company.data.company.contactCount)} contacts`,
        href: `/companies/${company.data.company.id}`,
      });
    }
  }, [company.data]);

  const datasetVersion = company.data?.datasetVersion ?? dataset.data?.activeVersion ?? "unknown";
  const facetCount = useMemo(() => company.data?.facets, [company.data]);

  if (company.isLoading) {
    return (
      <>
        <PageHeader title="Company" description="Loading company record…" />
        <LoadingBlock label="Reading company profile" rows={5} />
      </>
    );
  }

  if (company.error) {
    return (
      <>
        <PageHeader title="Company" />
        <ErrorBlock error={company.error as Error} onRetry={() => company.refetch()} />
      </>
    );
  }

  const record = company.data!.company;
  const rows = contacts.data?.contacts ?? [];
  const allSelected = rows.length > 0 && rows.every((contact) => selected.has(contact.id));

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) rows.forEach((contact) => next.delete(contact.id));
      else rows.forEach((contact) => next.add(contact.id));
      return next;
    });
  }

  return (
    <>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/companies" className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Back to search
        </Link>
        <span aria-hidden>·</span>
        <span className="truncate">Company ID {record.id}</span>
      </div>

      <PageHeader
        eyebrow="Company"
        title={record.name}
        description={[record.industry, record.subIndustry, [record.city, record.state, record.country].filter(Boolean).join(", ")]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Button
              className="gap-2"
              onClick={() =>
                saveLead.mutate({
                  kind: "company",
                  targetId: record.id,
                  datasetVersion,
                  snapshot: {
                    name: record.name,
                    industry: record.industry ?? null,
                    country: record.country ?? null,
                    contactCount: record.contactCount,
                  },
                })
              }
            >
              <Star className="size-4" />
              Save company
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              disabled={createExport.isPending}
              onClick={() =>
                createExport.mutate(
                  {
                    kind: "contacts",
                    companyId: record.id,
                    columns: [
                      "fullName",
                      "title",
                      "designation",
                      "seniority",
                      "department",
                      "email",
                      "phone",
                      "linkedinUrl",
                      "country",
                      "city",
                    ],
                  },
                  { onSuccess: (job) => void downloadExportFile(job.id) },
                )
              }
            >
              <FileDown className="size-4" />
              Export all contacts
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Contacts" value={formatNumber(record.contactCount)} hint="Records associated with this company" icon={<Users className="size-4" />} />
        <StatCard
          label="Email coverage"
          value={facetCount ? formatPercent(facetCount.emailAvailable / Math.max(1, record.contactCount)) : "—"}
          hint={facetCount ? `${formatNumber(facetCount.emailAvailable)} contacts with an email` : "Facet metadata not available"}
          icon={<Mail className="size-4" />}
        />
        <StatCard
          label="LinkedIn coverage"
          value={facetCount ? formatPercent(facetCount.linkedinAvailable / Math.max(1, record.contactCount)) : "—"}
          hint={facetCount ? `${formatNumber(facetCount.linkedinAvailable)} contacts with a profile` : "Facet metadata not available"}
          icon={<Linkedin className="size-4" />}
        />
        <StatCard
          label="Source files"
          value={record.sources.length ? new Set(record.sources.map((source) => source.source)).size : 0}
          hint={record.sources.map((source) => `${source.source} (row ${formatNumber(source.row)})`).join(", ") || "No source reference"}
          icon={<Building2 className="size-4" />}
        />
      </div>

      {record.associations ? (
        <p className="text-xs text-muted-foreground">
          Association evidence: <span className="text-foreground">{formatNumber(record.associations.highConfidence)}</span> verified ·{" "}
          <span className="text-foreground">{formatNumber(record.associations.plausible)}</span> possible ·{" "}
          <span className="text-foreground">{formatNumber(record.associations.conflicting)}</span> disputed.{" "}
          {ASSOCIATION_CATEGORY_HINTS.high_confidence}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Section
          title="Company information"
          description="Mapped attributes from the indexed dataset. Missing values are shown as — rather than invented."
        >
          <dl className="divide-y divide-border/60">
            <InfoRow label="Website">
              {record.website ? (
                <a className="inline-flex items-center gap-1.5 text-primary hover:underline" href={record.website} target="_blank" rel="noreferrer noopener">
                  <Globe className="size-3.5" />
                  {record.domain ?? record.website}
                </a>
              ) : (
                "—"
              )}
            </InfoRow>
            <InfoRow label="LinkedIn">
              {record.linkedinUrl ? (
                <a className="inline-flex items-center gap-1.5 text-primary hover:underline" href={record.linkedinUrl} target="_blank" rel="noreferrer noopener">
                  <Linkedin className="size-3.5" />
                  Company page
                </a>
              ) : (
                "—"
              )}
            </InfoRow>
            <InfoRow label="Industry">{record.industry ?? "—"}</InfoRow>
            <InfoRow label="Sub industry">{record.subIndustry ?? "—"}</InfoRow>
            <InfoRow label="Location">
              {[record.city, record.state, record.country].filter(Boolean).join(", ") || "—"}
            </InfoRow>
            <InfoRow label="Company size">{record.companySize ?? "—"}</InfoRow>
            <InfoRow label="Revenue">{record.revenue ?? "—"}</InfoRow>
            <InfoRow label="Normalized name">
              <span className="font-mono text-xs">{record.normalizedName}</span>
            </InfoRow>
            <InfoRow label="Name variants">
              {record.aliases?.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {record.aliases.slice(0, 8).map((alias) => (
                    <Badge key={alias} variant="outline" className="font-mono text-[10px] font-normal">
                      {alias}
                    </Badge>
                  ))}
                </span>
              ) : (
                "—"
              )}
            </InfoRow>
            {record.ambiguous ? (
              <InfoRow label="Identity">
                <Badge variant="outline" className="border-chart-3/50 bg-chart-3/12 text-[11px] font-normal text-chart-3">
                  Ambiguous identity — kept separate from similar names
                </Badge>
              </InfoRow>
            ) : null}
          </dl>
        </Section>

        <Section title="Contact filters" description="Server-side filters across the company's contacts">
          {!facetCount || facetCount.designations.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              This company has no facet metadata yet, so filter buckets are unavailable. Filters still apply by exact
              value below.
            </p>
          ) : (
            <div className="space-y-5">
              <FacetList
                title="Designation"
                buckets={facetCount.designations}
                selected={filters.designation}
                onSelect={(value) => {
                  setFilters((current) => ({ ...current, designation: value }));
                  setPage(1);
                }}
              />
              <FacetList
                title="Department"
                buckets={facetCount.departments}
                selected={filters.department}
                onSelect={(value) => {
                  setFilters((current) => ({ ...current, department: value }));
                  setPage(1);
                }}
              />
              <FacetList
                title="Seniority"
                buckets={facetCount.seniority}
                selected={filters.seniority}
                onSelect={(value) => {
                  setFilters((current) => ({ ...current, seniority: value }));
                  setPage(1);
                }}
              />
              <FacetList
                title="Country"
                buckets={facetCount.countries}
                selected={filters.country}
                onSelect={(value) => {
                  setFilters((current) => ({ ...current, country: value }));
                  setPage(1);
                }}
              />
            </div>
          )}

          <div className="mt-5 space-y-2 border-t border-border/60 pt-4">
            <p className="text-xs font-medium">Association evidence</p>
            <div className="flex flex-wrap gap-1.5">
              {(["high_confidence", "plausible", "conflicting"] as AssociationCategory[]).map((category) => (
                <Button
                  key={category}
                  variant={filters.association?.includes(category) ? "secondary" : "outline"}
                  size="sm"
                  title={ASSOCIATION_CATEGORY_HINTS[category]}
                  onClick={() => toggleAssociation(category)}
                >
                  {ASSOCIATION_CATEGORY_LABELS[category]}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              No selection shows every attached contact. Disputed rows are never shown as verified.
            </p>
          </div>

          <div className="mt-5 space-y-3 border-t border-border/60 pt-4">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="only-email" className="text-xs font-normal">
                Email available
              </Label>
              <Switch
                id="only-email"
                checked={Boolean(filters.hasEmail)}
                onCheckedChange={(checked) => {
                  setFilters((current) => ({ ...current, hasEmail: checked || undefined }));
                  setPage(1);
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="only-linkedin" className="text-xs font-normal">
                LinkedIn available
              </Label>
              <Switch
                id="only-linkedin"
                checked={Boolean(filters.hasLinkedin)}
                onCheckedChange={(checked) => {
                  setFilters((current) => ({ ...current, hasLinkedin: checked || undefined }));
                  setPage(1);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-city" className="text-xs">
                City
              </Label>
              <Input
                id="contact-city"
                className="h-8 text-xs"
                value={filters.city ?? ""}
                placeholder="Exact city value"
                onChange={(event) => {
                  setFilters((current) => ({ ...current, city: event.target.value || undefined }));
                  setPage(1);
                }}
              />
            </div>
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
          </div>
        </Section>
      </div>

      <Section
        title="Associated contacts"
        description={`${formatNumber(contacts.data?.page.total ?? 0)} contacts match the current filters`}
        actions={
          <>
            {selected.size > 0 ? (
              <Badge variant="secondary" className="font-normal">
                {selected.size} selected
              </Badge>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={selected.size === 0 || createExport.isPending}
              onClick={() =>
                createExport.mutate(
                  { kind: "contacts", contactIds: [...selected], columns: ["fullName", "title", "email", "phone", "linkedinUrl", "companyName", "country", "city"] },
                  { onSuccess: (job) => void downloadExportFile(job.id) },
                )
              }
            >
              <FileDown className="size-3.5" />
              Export selected
            </Button>
          </>
        }
      >
        {contacts.isLoading ? (
          <LoadingBlock label="Loading contacts" rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title="No contacts match these filters"
            description="Clear a filter to widen the result, or confirm that this company has contact rows in the indexed dataset."
          />
        ) : (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg border border-border/70">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all rows on this page" />
                    </TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead className="hidden md:table-cell">Title</TableHead>
                    <TableHead className="hidden lg:table-cell">Department</TableHead>
                    <TableHead className="hidden lg:table-cell">Location</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((contact) => (
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
                        <p className="text-[11px] text-muted-foreground">
                          {[contact.seniority, contact.designation].filter(Boolean).join(" · ") || "—"}
                        </p>
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
                      <TableCell className="hidden max-w-[240px] truncate md:table-cell">{contact.title ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell">{contact.department ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {[contact.city, contact.country].filter(Boolean).join(", ") || "—"}
                      </TableCell>
                      <TableCell>
                        {contact.email ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1.5 text-primary hover:underline"
                            onClick={() => void navigator.clipboard?.writeText(contact.email!)}
                            title="Copy email"
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
                          {contact.phone ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title={contact.phone}
                              aria-label="Copy phone number"
                              onClick={() => void navigator.clipboard?.writeText(contact.phone!)}
                            >
                              <Phone className="size-3.5" />
                            </Button>
                          ) : null}
                          {contact.linkedinUrl ? (
                            <Button variant="ghost" size="icon-sm" asChild title="Open LinkedIn profile">
                              <a href={contact.linkedinUrl} target="_blank" rel="noreferrer noopener">
                                <Linkedin className="size-3.5" />
                              </a>
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Copy contact id"
                            aria-label="Copy contact id"
                            onClick={() => void navigator.clipboard?.writeText(contact.id)}
                          >
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
                                snapshot: { fullName: contact.fullName, companyName: record.name, title: contact.title ?? null },
                              })
                            }
                          >
                            <Star className="size-3.5" />
                            Save
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
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
                  aria-label="Sort contacts by"
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

      <Section
        title="Contacts kept without a resolved employer"
        description="Rows that named this company but carried no evidence strong enough to attach them. Preserved for review — never presented as employees."
        actions={
          <Button variant="outline" size="sm" className="gap-2" onClick={() => setReviewUnassigned((value) => !value)}>
            <Users className="size-3.5" />
            {reviewUnassigned ? "Hide" : "Review"}
          </Button>
        }
      >
        {!reviewUnassigned ? (
          <p className="text-xs text-muted-foreground">
            Nothing is loaded until you ask: reviewing these rows reads one extra object for this company's name family.
          </p>
        ) : unassigned.isLoading ? (
          <LoadingBlock label="Reading preserved contacts" rows={4} />
        ) : unassigned.error ? (
          <ErrorBlock error={unassigned.error as Error} onRetry={() => unassigned.refetch()} />
        ) : (unassigned.data?.contacts.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title="Nothing unresolved for this company"
            description="Every contact that named this company could be associated with a specific company record."
          />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {formatNumber(unassigned.data!.totals.unresolved)} contact(s) name this company but could belong to any of its namesakes. Shown with
              their claimed company name and the candidates that remained.
            </p>
            <div className="overflow-hidden rounded-lg border border-border/70">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contact</TableHead>
                    <TableHead className="hidden md:table-cell">Title</TableHead>
                    <TableHead className="hidden md:table-cell">Claimed company name</TableHead>
                    <TableHead className="hidden lg:table-cell">Location</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unassigned.data!.contacts.map((contact) => (
                    <TableRow key={contact.id}>
                      <TableCell className="font-medium">{contact.fullName}</TableCell>
                      <TableCell className="hidden md:table-cell">{contact.title ?? "—"}</TableCell>
                      <TableCell className="hidden max-w-[220px] truncate md:table-cell">{contact.claimedCompanyName}</TableCell>
                      <TableCell className="hidden lg:table-cell">{[contact.city, contact.country].filter(Boolean).join(", ") || "—"}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {ASSOCIATION_CATEGORY_LABELS[contact.association.category]}
                          {candidateCount(contact.association)
                            ? ` · ${formatNumber(candidateCount(contact.association))} candidates`
                            : ""}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </Section>

      <Section title="Related links" description="Open the source systems for this company">
        <div className="flex flex-wrap gap-2">
          {record.website ? (
            <Button variant="outline" size="sm" className="gap-2" asChild>
              <a href={record.website} target="_blank" rel="noreferrer noopener">
                <Globe className="size-3.5" />
                Company website
                <ExternalLink className="size-3" />
              </a>
            </Button>
          ) : null}
          {record.linkedinUrl ? (
            <Button variant="outline" size="sm" className="gap-2" asChild>
              <a href={record.linkedinUrl} target="_blank" rel="noreferrer noopener">
                <Linkedin className="size-3.5" />
                Company LinkedIn
                <ExternalLink className="size-3" />
              </a>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" className="gap-2" onClick={() => void navigator.clipboard?.writeText(record.id)}>
            <Copy className="size-3.5" />
            Copy company ID
          </Button>
        </div>
      </Section>
    </>
  );
}
