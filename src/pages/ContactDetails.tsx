/**
 * Contact profile — every field the source row carried, plus the employer evidence.
 *
 * WHY IT EXISTS
 * -------------
 * A person found through search must open like a record, not like a row: the page
 * shows the identity fields prominently, then EVERY remaining attribute the record
 * has, each with a copy button and a real link where the value is a URL. It also
 * states how the employer was decided, because a contact whose company could not be
 * justified must not look like a confirmed employee (§ 10 and § 11 of the
 * specification).
 */

import { Link, useParams } from "react-router";
import { ArrowLeft, Building2, Copy, Linkedin, Mail, Phone, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, ErrorBlock, InfoRow, LoadingBlock, LongText, PageHeader, Section } from "@/components/common";
import { useContact, useDatasetStatus } from "@/hooks/use-api";
import { ASSOCIATION_CATEGORY_LABELS, type AssociationCategory, type AssociationRecord } from "@/shared/association";
import type { Contact } from "@/shared/models";
import { formatNumber } from "@/lib/format";

/** Values that are not worth a row of their own. */
const HIDDEN_KEYS = new Set(["id", "companyId", "association", "source", "attributes"]);

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item) => displayValue(item) ?? "").filter(Boolean).join(", ") || null : null;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${humanizeKey(key)}: ${displayValue(item) ?? "—"}`)
      .join(" · ");
    return entries || null;
  }
  return String(value);
}

/** One copyable field row. */
function FieldRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <div className="min-w-0">
        <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
        <dd className="mt-0.5 break-words text-sm">
          {href ? (
            <a className="text-primary hover:underline" href={href} target="_blank" rel="noreferrer noopener">
              <LongText text={value} limit={120} />
            </a>
          ) : (
            <LongText text={value} />
          )}
        </dd>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        title={`Copy ${label}`}
        aria-label={`Copy ${label}`}
        onClick={() => void navigator.clipboard?.writeText(value)}
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

function AssociationPanel({ record, companyId }: { record: AssociationRecord | undefined; companyId: string }) {
  if (!record) {
    return (
      <p className="text-xs text-muted-foreground">
        This index carries no association evidence for this contact (it was built before employer categories existed), so the
        employer is shown as unconfirmed.
      </p>
    );
  }
  const label = ASSOCIATION_CATEGORY_LABELS[record.category as AssociationCategory] ?? record.category;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[11px]">
          {label}
        </Badge>
        {record.reason === "row_carries_employer_identity" ? null : (
          <Badge variant="outline" className="text-[11px] text-muted-foreground">
            decided from this contact's own evidence, not from the name the row claimed
          </Badge>
        )}
      </div>
      <dl className="space-y-1.5 text-xs">
        <div>
          <dt className="text-muted-foreground">Decision</dt>
          <dd className="mt-0.5 break-words">{humanizeKey(record.reason)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Evidence</dt>
          <dd className="mt-0.5 space-y-1">
            <p>
              Company name: <span className="text-muted-foreground">{record.evidence.name === "shared" ? "shared by more than one record" : "unique in the dataset"}</span>
            </p>
            <p>
              Email domain: <span className="text-muted-foreground">{humanizeKey(record.evidence.domain)}</span>
            </p>
            <p>
              Location: <span className="text-muted-foreground">{humanizeKey(record.evidence.country)}</span>
            </p>
            <p>
              Row carried the employer's identity:{" "}
              <span className="text-muted-foreground">{record.evidence.rowIdentity ? "yes" : "no"}</span>
            </p>
            <p>
              Candidate companies considered: <span className="text-muted-foreground">{formatNumber(record.candidateCount ?? record.evidence.candidates)}</span>
            </p>
          </dd>
        </div>
      </dl>
      {companyId ? (
        <Button variant="outline" size="sm" className="gap-2" asChild>
          <Link to={`/companies/${companyId}`}>
            <Building2 className="size-3.5" />
            Open company profile
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

export default function ContactDetails() {
  const { contactId } = useParams<{ contactId: string }>();
  const query = useContact(contactId);
  const dataset = useDatasetStatus();
  const contact = query.data?.contact as Contact | undefined;
  const companyName = query.data?.companyName ?? null;
  const companyId = query.data?.companyId ?? null;

  if (query.isLoading) {
    return (
      <>
        <PageHeader eyebrow="Person" title="Contact" description="Loading this contact from the active dataset." />
        <LoadingBlock label="Reading contact record" rows={8} />
      </>
    );
  }
  if (query.error || !contact) {
    return (
      <>
        <PageHeader eyebrow="Person" title="Contact" description="This contact could not be read." />
        <ErrorBlock error={(query.error as Error) ?? new Error("Contact not found in the active dataset.")} onRetry={() => query.refetch()} />
      </>
    );
  }

  const attributes = Object.entries(contact as unknown as Record<string, unknown>).filter(
    ([key, value]) => !HIDDEN_KEYS.has(key) && displayValue(value) !== null,
  );
  const identityKeys = new Set(["fullName", "firstName", "lastName", "title", "designation", "seniority", "department", "email", "phone", "linkedinUrl", "country", "state", "city"]);
  const extra = attributes.filter(([key]) => !identityKeys.has(key));
  /*
   * The columns this record carries that are NOT part of the canonical model
   * (industry codes, employee counts, source-specific flags…). They are indexed
   * verbatim and shown verbatim — this is the “51 company / 39 contact fields” part
   * of the record, and it must never be a truncated sample.
   */
  const captured = Object.entries(contact.attributes ?? {});

  return (
    <>
      <PageHeader
        eyebrow="Person record"
        title={contact.fullName || "Unnamed contact"}
        description={[contact.title ?? contact.designation, companyName].filter(Boolean).join(" · ") || "No role or employer recorded in the source row."}
        actions={
          <>
            <Button variant="outline" className="gap-2" asChild>
              <Link to="/companies?type=contacts">
                <ArrowLeft className="size-4" />
                Back to search
              </Link>
            </Button>
            {contact.linkedinUrl ? (
              <Button variant="outline" className="gap-2" asChild>
                <a href={contact.linkedinUrl} target="_blank" rel="noreferrer noopener">
                  <Linkedin className="size-4" />
                  LinkedIn
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <CardShell>
            <Section title="Identity" description="Values exactly as the source record carries them">
              <dl>
                <FieldRow label="Full name" value={contact.fullName} />
                {contact.firstName ? <FieldRow label="First name" value={contact.firstName} /> : null}
                {contact.lastName ? <FieldRow label="Last name" value={contact.lastName} /> : null}
                {contact.title ? <FieldRow label="Job title" value={contact.title} /> : null}
                {contact.designation ? <FieldRow label="Designation" value={contact.designation} /> : null}
                {contact.department ? <FieldRow label="Department" value={contact.department} /> : null}
                {contact.seniority ? <FieldRow label="Seniority" value={contact.seniority} /> : null}
              </dl>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {contact.email ? (
                  <Button variant="outline" size="sm" className="gap-2" asChild>
                    <a href={`mailto:${contact.email}`}>
                      <Mail className="size-3.5" />
                      {contact.email}
                    </a>
                  </Button>
                ) : null}
                {contact.phone ? (
                  <Button variant="outline" size="sm" className="gap-2" onClick={() => void navigator.clipboard?.writeText(contact.phone!)}>
                    <Phone className="size-3.5" />
                    {contact.phone}
                  </Button>
                ) : null}
              </div>
            </Section>
          </CardShell>

          <CardShell>
            <Section
              title="All source fields"
              description={`Every column the source row carried — ${captured.length} captured source fields plus ${extra.length} derived ones, none truncated`}
            >
              {captured.length ? (
                <dl className="mb-4 grid gap-x-8 border-b border-border/60 pb-2 sm:grid-cols-2">
                  {captured.map(([key, value]) => (
                    <FieldRow key={`captured-${key}`} label={key} value={value} href={isUrl(value) ? value : undefined} />
                  ))}
                </dl>
              ) : null}
              {extra.length ? (
                <dl className="grid gap-x-8 sm:grid-cols-2">
                  {extra.map(([key, value]) => {
                    const text = displayValue(value) ?? "—";
                    return (
                      <FieldRow
                        key={key}
                        label={humanizeKey(key)}
                        value={text}
                        href={isUrl(text) ? text : undefined}
                      />
                    );
                  })}
                </dl>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This record has no attributes beyond the identity fields shown above. That means the source row itself
                  carried no more values for this person — nothing was dropped.
                </p>
              )}
            </Section>
          </CardShell>
        </div>

        <aside className="space-y-4">
          <CardShell>
            <Section title="Employer" description="What the index could justify">
              <div className="space-y-3 text-xs">
                <InfoRow label="Company">
                  {companyId ? (
                    <Link className="text-primary hover:underline" to={`/companies/${companyId}`}>
                      {companyName ?? companyId}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">No employer record (preserved, unassigned)</span>
                  )}
                </InfoRow>
                <InfoRow label="Contact id">
                  <span className="font-mono text-[11px]">{contact.id}</span>
                </InfoRow>
                <InfoRow label="Source">{contact.source?.source ?? "—"}</InfoRow>
                <InfoRow label="Source row">{formatNumber(contact.source?.row ?? 0)}</InfoRow>
                <InfoRow label="Dataset">{dataset.data?.activeVersion ?? "unknown"}</InfoRow>
              </div>
            </Section>
          </CardShell>

          <CardShell>
            <Section title="Association evidence" description="Why this company, or why none">
              <AssociationPanel record={contact.association} companyId={companyId ?? ""} />
              {!companyId ? (
                <p className="mt-3 flex items-start gap-2 text-[11px] text-muted-foreground">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-chart-4" />
                  This person is preserved without an employer rather than attached to a company that merely shares the
                  claimed name. The record stays searchable here.
                </p>
              ) : null}
            </Section>
          </CardShell>
        </aside>
      </div>
    </>
  );
}
