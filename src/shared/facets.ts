/**
 * Contact facets for a company's complete collection.
 *
 * The active real-data index stores `person_title` in `title` and leaves the
 * canonical `designation` column empty. The stored company facets were therefore
 * built with an empty designation list, and the Company Details filter had no
 * options even though every person had a job title. This computes facets from the
 * contacts the page already reads, using the title as the designation fallback —
 * no reindex and no extra read.
 */

import type { CompanyFacets, Contact, FacetBucket } from "./models";

const TOP_N = 40;

function pushBucket(buckets: FacetBucket[], value: string | undefined): void {
  if (!value) return;
  const existing = buckets.find((bucket) => bucket.value === value);
  if (existing) existing.count += 1;
  else buckets.push({ value, count: 1 });
}

function trim(buckets: FacetBucket[]): FacetBucket[] {
  return [...buckets].sort((a, b) => b.count - a.count).slice(0, TOP_N);
}

/** Facets over every contact of a company (never just the current page). */
export function contactFacets(contacts: Contact[]): CompanyFacets {
  const designations: FacetBucket[] = [];
  const departments: FacetBucket[] = [];
  const seniority: FacetBucket[] = [];
  const countries: FacetBucket[] = [];
  const cities: FacetBucket[] = [];
  let emailAvailable = 0;
  let linkedinAvailable = 0;

  for (const contact of contacts) {
    pushBucket(designations, contact.designation || contact.title);
    pushBucket(departments, contact.department);
    pushBucket(seniority, contact.seniority);
    pushBucket(countries, contact.country);
    pushBucket(cities, contact.city);
    if (contact.email) emailAvailable += 1;
    if (contact.linkedinUrl) linkedinAvailable += 1;
  }

  return {
    designations: trim(designations),
    departments: trim(departments),
    seniority: trim(seniority),
    countries: trim(countries),
    cities: trim(cities),
    emailAvailable,
    linkedinAvailable,
  };
}
