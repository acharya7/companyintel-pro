/**
 * Company detail.
 *
 * LAYOUT (desktop)
 *   company header → four summary cards → a full-width horizontal filter bar
 *   → contacts (≈2/3) beside company information (≈1/3, sticky).
 *
 * Contacts are fetched one bounded page at a time and filtered server-side
 * against the company's contact partition, so a company with tens of thousands
 * of contacts never loads them all into the browser. Summary cards always read
 * the company's total counts, never the size of the current page.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FileDown,
  Globe,
  Linkedin,
  Mail,
  MapPin,
  Search,
  Star,
  Users,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  LongText,
  PageHeader,
  Pager,
  Section,
  StatCard,
} from "@/components/common";
import { ContactNumbers } from "@/components/contact-numbers";
import { RealDataCoverageNotice } from "@/components/realdata";
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
import type { Company, Contact, ContactFilters, ContactSortField, SortOrder } from "@/shared/models";
import { formatNumber, formatPercent } from "@/lib/format";
import { telHref } from "@/shared/phone";
import { rememberCompany } from "@/lib/recent";

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

/** Exact or case-insensitive lookup in the verbatim source attributes. */
function attributeValue(record: Company, ...keys: string[]): string | undefined {
  const attributes = record.attributes ?? {};
  for (const key of keys) {
    const direct = attributes[key];
    if (direct && direct.trim()) return direct.trim();
    const entry = Object.entries(attributes).find(([name]) => name.toLowerCase() === key.toLowerCase());
    if (entry?.[1]?.trim()) return entry[1].trim();
  }
  return undefined;
}

/** A company LinkedIn URL, including the list-shaped source column. */
function linkedInUrl(record: Company): string | undefined {
  if (record.linkedinUrl) return record.linkedinUrl;
  for (const [key, value] of Object.entries(record.attributes ?? {})) {
    if (!/linkedin/i.test(key)) continue;
    const match = /https?:\/\/[^\s'"\],]+linkedin\.com\/[^\s'"\],]+/i.exec(value);
    if (match) return match[0];
  }
  return undefined;
}

/** Present a source list (`['software']`) as its values, without changing storage. */
function friendly(value: string | undefined): string | undefined {
  if (!value) return value;
  const text = value.trim();
  const list = /^\[['"](.*)['"]\]$/.exec(text);
  if (!list) return text;
  return list[1]
    .split(/['"]\s*,\s*['"]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

/** Drop empty entries so "no filter" and "filter set to empty" cannot diverge. */
function pruneFilters(filters: ContactFilters): ContactFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => {
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }),
  ) as ContactFilters;
}

type ActiveFilter = { key: string; label: string; clear: () => void };

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
  const [queryDraft, setQueryDraft] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewUnassigned, setReviewUnassigned] = useState(false);
  const [showAllAttributes, setShowAllAttributes] = useState(false);

  const contacts = useCompanyContacts(companyId, { page, pageSize, sort, order, filters });
  // Fetched only after the user asks to review the uncertain rows, so a company
  // profile never pays for a second object read it does not show.
  const unassigned = useCompanyUnassigned(companyId, { page: 1, pageSize: 25 }, reviewUnassigned);

  // Typing in the contact search box is applied after a short pause instead of a
  // request per keystroke; the filter still runs server-side over every contact.
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = queryDraft.trim();
      setFilters((current) => {
        if ((current.query ?? "") === next) return current;
        return pruneFilters({ ...current, query: next || undefined });
      });
      setPage(1);
    }, 250);
    return () => clearTimeout(handle);
  }, [queryDraft]);

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
  // The stored facets were built when the active version was indexed; the page's
  // own facet projection also covers records whose role lives in `title` (see
  // src/shared/facets.ts). Prefer the complete, current projection.
  const facets = contacts.data?.facets ?? company.data!.facets;
  const capturedAttributes = Object.entries(record.attributes ?? {});
  const rows = contacts.data?.contacts ?? [];
  const allSelected = rows.length > 0 && rows.every((contact) => selected.has(contact.id));
  const filteredTotal = contacts.data?.page.total ?? null;
  const activeFilterCount = Object.keys(pruneFilters(filters)).length;
  const hasFilters = activeFilterCount > 0;
  const totalContacts = record.contactCount;
  const associationCounts = record.associations;
  const sourceNames = [...new Set(record.sources.map((source) => source.source))];
  const location = [record.city, record.state, record.country].filter(Boolean).join(", ");
  const companyLinkedIn = linkedInUrl(record);

  function updateFilters(patch: Partial<ContactFilters>) {
    setFilters((current) => pruneFilters({ ...current, ...patch }));
    setPage(1);
  }

  function clearFilters() {
    setFilters({});
    setQueryDraft("");
    setPage(1);
  }

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) rows.forEach((contact) => next.delete(contact.id));
      else rows.forEach((contact) => next.add(contact.id));
      return next;
    });
  }

  const activeFilters: ActiveFilter[] = [];
  if (filters.query) activeFilters.push({ key: "query", label: `Search: ${filters.query}`, clear: () => {
    setQueryDraft("");
    updateFilters({ query: undefined });
  } });
  for (const field of ["designation", "department", "seniority", "country", "city"] as const) {
    const value = filters[field];
    if (value) {
      activeFilters.push({
        key: field,
        label: `${field === "country" ? "Country" : field[0].toUpperCase() + field.slice(1)}: ${friendly(value)}`,
        clear: () => updateFilters({ [field]: undefined } as Partial<ContactFilters>),
      });
    }
  }
  if (filters.hasEmail) activeFilters.push({ key: "hasEmail", label: "Has email", clear: () => updateFilters({ hasEmail: undefined }) });
  if (filters.hasPhone) activeFilters.push({ key: "hasPhone", label: "Has phone / mobile", clear: () => updateFilters({ hasPhone: undefined }) });
  if (filters.hasLinkedin) activeFilters.push({ key: "hasLinkedin", label: "Has LinkedIn", clear: () => updateFilters({ hasLinkedin: undefined }) });
  if (filters.association?.length) {
    activeFilters.push({
      key: "association",
      label: filters.association.map((category) => ASSOCIATION_CATEGORY_LABELS[category]).join(", "),
      clear: () => updateFilters({ association: undefined }),
    });
  }

  const infoRows: { label: string; value?: string; href?: string; long?: boolean; copy?: boolean }[] = [
    { label: "Website", value: record.website, href: record.website },
    { label: "LinkedIn", value: companyLinkedIn, href: companyLinkedIn },
    { label: "Domain", value: record.domain },
    { label: "Industry", value: friendly(record.industry) },
    { label: "Sub-industry", value: friendly(record.subIndustry) },
    {
      label: "Headquarters",
      value: attributeValue(record, "organization_hq_location_city_with_state_or_country", "headquarters"),
    },
    { label: "City", value: record.city },
    { label: "State / region", value: record.state },
    { label: "Country", value: record.country },
    { label: "Postal code", value: attributeValue(record, "organization_hq_location_postal_code") },
    { label: "Company size", value: record.companySize },
    { label: "Employee count", value: attributeValue(record, "organization_num_current_employees") },
    { label: "Company phone", value: attributeValue(record, "organization_phone") },
    { label: "Revenue (source units)", value: record.revenue },
    { label: "Founded", value: attributeValue(record, "organization_founded_year") },
    { label: "Public symbol", value: attributeValue(record, "organization_public_symbol") },
    {
      label: "Description",
      value: attributeValue(record, "organization_short_description", "organization_description", "description"),
      long: true,
    },
  ].filter((row) => Boolean(row.value));

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

      <RealDataCoverageNotice className="mb-4" compact />

      <PageHeader
        eyebrow="Company"
        title={record.name}
        description={
          [friendly(record.industry), friendly(record.subIndustry), location].filter(Boolean).join(" · ") ||
          "No industry or location recorded in the source row."
        }
        actions={
          <>
            {record.website ? (
              <Button variant="outline" className="gap-2" asChild>
                <a href={record.website} target="_blank" rel="noreferrer noopener">
                  <Globe className="size-4" />
                  Website
                  <ExternalLink className="size-3" />
                </a>
              </Button>
            ) : null}
            {companyLinkedIn ? (
              <Button variant="outline" className="gap-2" asChild>
                <a href={companyLinkedIn} target="_blank" rel="noreferrer noopener">
                  <Linkedin className="size-4" />
                  LinkedIn
                  <ExternalLink className="size-3" />
                </a>
              </Button>
            ) : null}
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
              disabled={createExport.isPending || totalContacts === 0}
              onClick={() =>
                createExport.mutate(
                  {
                    kind: "contacts",
                    companyId: record.id,
                    ...(hasFilters
                      ? { filters: { ...filters, association: filters.association?.join(",") } }
                      : {}),
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
              {hasFilters ? "Export filtered contacts" : "Export all contacts"}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total contacts"
          value={formatNumber(totalContacts)}
          hint={
            associationCounts
              ? `${formatNumber(associationCounts.highConfidence)} verified · ${formatNumber(associationCounts.plausible)} possible · ${formatNumber(associationCounts.conflicting)} disputed`
              : "Records associated with this company"
          }
          icon={<Users className="size-4" />}
        />
        <StatCard
          label="Email coverage"
          value={facets && totalContacts ? formatPercent(facets.emailAvailable / Math.max(1, totalContacts)) : "—"}
          hint={
            facets
              ? `${formatNumber(facets.emailAvailable)} of ${formatNumber(totalContacts)} contacts have an email`
              : "Facet metadata not available"
          }
          icon={<Mail className="size-4" />}
        />
        <StatCard
          label="LinkedIn coverage"
          value={facets && totalContacts ? formatPercent(facets.linkedinAvailable / Math.max(1, totalContacts)) : "—"}
          hint={
            facets
              ? `${formatNumber(facets.linkedinAvailable)} of ${formatNumber(totalContacts)} contacts have a profile`
              : "Facet metadata not available"
          }
          icon={<Linkedin className="size-4" />}
        />
        <StatCard
          label="Source files"
          value={sourceNames.length}
          hint={
            sourceNames.length
              ? `${sourceNames.join(", ")} · ${formatNumber(record.sources.length)} source-row reference${record.sources.length === 1 ? "" : "s"}`
              : "No source reference"
          }
          icon={<Building2 className="size-4" />}
        />
      </div>

      {/* Horizontal filter bar — full content width, above both columns. */}
      <div className="surface space-y-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1 lg:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="Search this company's contacts…"
              aria-label="Search within this company's contacts"
              className="h-9 pl-9 text-sm"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 max-w-[190px] rounded-md border border-input bg-background px-2 text-xs"
              value={filters.designation ?? ""}
              onChange={(event) => updateFilters({ designation: event.target.value || undefined })}
              aria-label="Filter by designation"
            >
              <option value="">All designations</option>
              {facets?.designations.map((bucket) => (
                <option key={bucket.value} value={bucket.value}>
                  {friendly(bucket.value)} ({bucket.count})
                </option>
              ))}
            </select>
            <select
              className="h-9 max-w-[190px] rounded-md border border-input bg-background px-2 text-xs"
              value={filters.department ?? ""}
              onChange={(event) => updateFilters({ department: event.target.value || undefined })}
              aria-label="Filter by department"
            >
              <option value="">All departments</option>
              {facets?.departments.map((bucket) => (
                <option key={bucket.value} value={bucket.value}>
                  {friendly(bucket.value)} ({bucket.count})
                </option>
              ))}
            </select>
            <select
              className="h-9 max-w-[190px] rounded-md border border-input bg-background px-2 text-xs"
              value={filters.country ?? ""}
              onChange={(event) => updateFilters({ country: event.target.value || undefined })}
              aria-label="Filter by country"
            >
              <option value="">All countries</option>
              {facets?.countries.map((bucket) => (
                <option key={bucket.value} value={bucket.value}>
                  {friendly(bucket.value)} ({bucket.count})
                </option>
              ))}
            </select>
            <select
              className="h-9 max-w-[170px] rounded-md border border-input bg-background px-2 text-xs"
              value={filters.city ?? ""}
              onChange={(event) => updateFilters({ city: event.target.value || undefined })}
              aria-label="Filter by city"
            >
              <option value="">All cities</option>
              {facets?.cities.map((bucket) => (
                <option key={bucket.value} value={bucket.value}>
                  {friendly(bucket.value)} ({bucket.count})
                </option>
              ))}
            </select>
            <select
              className="h-9 max-w-[170px] rounded-md border border-input bg-background px-2 text-xs"
              value={filters.association?.length === 1 ? filters.association[0] : ""}
              onChange={(event) =>
                updateFilters({
                  association: event.target.value ? [event.target.value as AssociationCategory] : undefined,
                })
              }
              aria-label="Filter by association evidence"
            >
              <option value="">Any evidence</option>
              {(["high_confidence", "plausible", "conflicting"] as AssociationCategory[]).map((category) => (
                <option key={category} value={category}>
                  {ASSOCIATION_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { key: "hasEmail", label: "Has email" },
                { key: "hasPhone", label: "Has phone / mobile" },
                { key: "hasLinkedin", label: "Has LinkedIn" },
              ] as const
            ).map((toggle) => (
              <Button
                key={toggle.key}
                type="button"
                size="sm"
                variant={filters[toggle.key] ? "secondary" : "outline"}
                aria-pressed={Boolean(filters[toggle.key])}
                onClick={() => updateFilters({ [toggle.key]: filters[toggle.key] ? undefined : true })}
              >
                {toggle.label}
              </Button>
            ))}
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={clearFilters} disabled={!hasFilters}>
              <X className="size-3.5" />
              Clear all
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
          <span>
            <span className="tabular font-medium text-foreground">{formatNumber(filteredTotal ?? 0)}</span> matching
            {hasFilters ? ` of ${formatNumber(totalContacts)} total` : " contacts"}
          </span>
          {activeFilters.map((filter) => (
            <span key={filter.key} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5">
              <span className="max-w-[220px] truncate">{filter.label}</span>
              <button type="button" onClick={filter.clear} aria-label={`Remove filter ${filter.label}`} className="hover:text-foreground">
                <X className="size-3" />
              </button>
            </span>
          ))}
          {associationCounts ? (
            <span className="ml-auto">
              {formatNumber(associationCounts.highConfidence)} verified · {formatNumber(associationCounts.plausible)} possible ·{" "}
              {formatNumber(associationCounts.conflicting)} disputed
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,13fr)_minmax(0,7fr)] lg:items-start">
        {/* Contacts — main column */}
        <Section
          title="Associated contacts"
          description={
            contacts.data
              ? hasFilters
                ? `${formatNumber(filteredTotal ?? 0)} of ${formatNumber(totalContacts)} contacts match the active filters`
                : `${formatNumber(filteredTotal ?? totalContacts)} contacts, filtered server-side across the whole collection`
              : "Loading contact collection"
          }
          actions={
            <>
              {selected.size > 0 ? (
                <Badge variant="secondary" className="font-normal">
                  {selected.size} selected
                </Badge>
              ) : null}
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
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={selected.size === 0 || createExport.isPending}
                onClick={() =>
                  createExport.mutate(
                    {
                      kind: "contacts",
                      contactIds: [...selected],
                      columns: [
                        "fullName",
                        "title",
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
                <FileDown className="size-3.5" />
                Export selected
              </Button>
            </>
          }
        >
          {contacts.isLoading ? (
            <LoadingBlock label="Loading contacts" rows={6} />
          ) : contacts.error ? (
            <ErrorBlock error={contacts.error as Error} onRetry={() => contacts.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Users className="size-5" />}
              title={hasFilters ? "No contacts match these filters" : "No contacts in the indexed coverage"}
              description={
                hasFilters
                  ? "Clear a filter to widen the result. Filters never change the company's stored associations."
                  : "This company has no attached contact rows in the activated index coverage."
              }
              action={hasFilters ? <Button variant="outline" onClick={clearFilters}>Clear all filters</Button> : undefined}
            />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all contacts on this page" />
                  Select this page
                </label>
                <span className="text-[11px] text-muted-foreground">
                  Page {contacts.data!.page.page} · {formatNumber(rows.length)} shown
                </span>
              </div>

              <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
                {rows.map((contact) => (
                  <ContactRow
                    key={contact.id}
                    contact={contact}
                    companyName={record.name}
                    companyId={record.id}
                    selected={selected.has(contact.id)}
                    onSelected={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(contact.id);
                        else next.delete(contact.id);
                        return next;
                      })
                    }
                    onSave={() =>
                      saveLead.mutate({
                        kind: "contact",
                        targetId: contact.id,
                        datasetVersion,
                        snapshot: { fullName: contact.fullName, companyName: record.name, title: contact.title ?? null },
                      })
                    }
                  />
                ))}
              </ul>

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
          )}
        </Section>

        {/* Company information — right column, parallel to the contact list. */}
        <aside className="min-w-0 lg:sticky lg:top-20">
          <Section
            title="Company information"
            description="Original source values. Missing fields are omitted rather than shown as empty."
          >
            <dl className="divide-y divide-border/60">
              {infoRows.map((row) => (
                <div key={row.label} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
                  <dt className="w-36 shrink-0 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{row.label}</dt>
                  <dd className="min-w-0 break-words text-sm">
                    {row.href ? (
                      <a className="inline-flex items-center gap-1.5 text-primary hover:underline" href={row.href} target="_blank" rel="noreferrer noopener">
                        <LongText text={row.value!} limit={row.long ? 220 : 120} />
                      </a>
                    ) : row.label === "Company phone" ? (
                      <a className="text-primary hover:underline" href={telHref(row.value) ?? undefined}>
                        {row.value}
                      </a>
                    ) : row.long ? (
                      <LongText text={row.value!} limit={220} />
                    ) : (
                      <span>{row.value}</span>
                    )}
                  </dd>
                </div>
              ))}
              {!infoRows.length ? <p className="py-2 text-xs text-muted-foreground">No mapped company attributes are present in the source row.</p> : null}
            </dl>

            {capturedAttributes.length ? (
              <div className="mt-4 border-t border-border/60 pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-between gap-2"
                  aria-expanded={showAllAttributes}
                  onClick={() => setShowAllAttributes((value) => !value)}
                >
                  <span>
                    All original attributes
                    <span className="ml-2 text-[11px] font-normal text-muted-foreground">{capturedAttributes.length} fields</span>
                  </span>
                  {showAllAttributes ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                </Button>
                {showAllAttributes ? (
                  <dl className="mt-3 max-h-[520px] space-y-0 overflow-y-auto pr-1">
                    {capturedAttributes.map(([label, value]) => (
                      <div key={label} className="border-b border-border/50 py-2 last:border-b-0">
                        <dt className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
                        <dd className="mt-0.5 flex items-start justify-between gap-2 text-[11px] leading-5">
                          <span className="min-w-0 break-words">
                            {/^https?:\/\//i.test(value) ? (
                              <a className="text-primary hover:underline" href={value} target="_blank" rel="noreferrer noopener">
                                <LongText text={value} limit={160} />
                              </a>
                            ) : (
                              <LongText text={value} limit={220} />
                            )}
                          </span>
                          <button
                            type="button"
                            className="shrink-0 text-muted-foreground/70 hover:text-foreground"
                            title={`Copy ${label}`}
                            aria-label={`Copy ${label}`}
                            onClick={() => void navigator.clipboard?.writeText(value)}
                          >
                            <Copy className="size-3" />
                          </button>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-4">
              <Button variant="outline" size="sm" className="gap-2" onClick={() => void navigator.clipboard?.writeText(record.id)}>
                <Copy className="size-3.5" />
                Copy company ID
              </Button>
              {record.ambiguous ? (
                <Badge variant="outline" className="border-chart-3/50 bg-chart-3/12 text-[10px] font-normal text-chart-3">
                  Ambiguous identity — kept separate from similar names
                </Badge>
              ) : null}
            </div>
          </Section>
        </aside>
      </div>

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
              {formatNumber(unassigned.data!.totals.unresolved)} contact(s) name this company but could belong to any of its
              namesakes. Shown with their claimed company name and the candidates that remained.
            </p>
            <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
              {unassigned.data!.contacts.map((contact) => (
                <li key={contact.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <Link to={`/contacts/${contact.id}`} className="font-medium hover:text-primary">
                      {contact.fullName}
                    </Link>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {[contact.title, contact.claimedCompanyName, [contact.city, contact.country].filter(Boolean).join(", ")]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <ContactNumbers contact={contact} className="mt-1" showLabels={false} />
                  </div>
                  <Badge variant="outline" className="w-fit text-[10px] font-normal">
                    {ASSOCIATION_CATEGORY_LABELS[contact.association.category]}
                    {candidateCount(contact.association) ? ` · ${formatNumber(candidateCount(contact.association))} candidates` : ""}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </>
  );
}

/** One compact, complete contact row: identity, role, email, numbers, links. */
function ContactRow({
  contact,
  companyName,
  companyId,
  selected,
  onSelected,
  onSave,
}: {
  contact: Contact;
  companyName: string;
  companyId: string;
  selected: boolean;
  onSelected: (checked: boolean) => void;
  onSave: () => void;
}) {
  const location = [contact.city, contact.state, contact.country].filter(Boolean).join(", ");
  return (
    <li className="flex gap-3 px-4 py-3.5 transition-colors hover:bg-muted/25">
      <Checkbox
        className="mt-1"
        checked={selected}
        onCheckedChange={(checked) => onSelected(Boolean(checked))}
        aria-label={`Select ${contact.fullName}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/contacts/${contact.id}`} className="truncate font-medium hover:text-primary">
                {contact.fullName}
              </Link>
              {contact.association && contact.association.category !== "high_confidence" ? (
                <Badge
                  variant="outline"
                  className="border-chart-3/50 bg-chart-3/12 text-[10px] font-normal text-chart-3"
                  title={ASSOCIATION_CATEGORY_HINTS[contact.association.category]}
                >
                  {ASSOCIATION_CATEGORY_LABELS[contact.association.category]}
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {[contact.title, contact.designation, friendly(contact.department)].filter(Boolean).join(" · ") || "No title recorded"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon-sm" title="Save contact" aria-label={`Save ${contact.fullName}`} onClick={onSave}>
              <Star className="size-3.5" />
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" asChild>
              <Link to={`/contacts/${contact.id}`}>
                View
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          {contact.email ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Mail className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <a href={`mailto:${contact.email}`} className="max-w-[260px] truncate text-primary hover:underline" title={contact.email}>
                {contact.email}
              </a>
              <button
                type="button"
                className="shrink-0 text-muted-foreground/70 hover:text-foreground"
                title="Copy email"
                aria-label={`Copy email ${contact.email}`}
                onClick={() => void navigator.clipboard?.writeText(contact.email!)}
              >
                <Copy className="size-3" />
              </button>
            </span>
          ) : null}

          <ContactNumbers contact={contact} showLabels copyable />

          {contact.linkedinUrl ? (
            <a
              href={contact.linkedinUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 text-primary hover:underline"
            >
              <Linkedin className="size-3.5" />
              LinkedIn
            </a>
          ) : null}

          {location ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <MapPin className="size-3.5" />
              {location}
            </span>
          ) : null}

          <Link to={`/companies/${companyId}`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
            <Building2 className="size-3.5" />
            {companyName}
          </Link>
        </div>
      </div>
    </li>
  );
}
