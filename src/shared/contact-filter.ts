/**
 * One contact-filter rule shared by the Worker, the preview adapter and tests.
 *
 * The company profile filters its contacts server-side: the Worker reads the
 * company's contact partition, applies these rules and only then paginates, so
 * `page.total` is the number of matching contacts in the whole collection — not
 * the number on the current page. The preview uses the same function, which is
 * what keeps the two data paths from disagreeing about a filter.
 */

import { associationMatchesFilter } from "./association";
import type { Contact, ContactFilters } from "./models";
import { contactPhoneNumbers } from "./phone";

/** Normalize a value for a case-insensitive `includes` comparison. */
function fold(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Free-text search inside one company's contacts.
 *
 * Deliberately covers the fields a person actually searches by — name, title,
 * designation, department, email and the visible phone numbers — and matches on
 * substrings, so "head of sales" finds a title that contains it.
 */
export function contactMatchesQuery(contact: Contact, query: string | undefined | null): boolean {
  const term = fold(query).trim();
  if (!term) return true;
  const numbers = contactPhoneNumbers(contact);
  const haystack = [
    contact.fullName,
    contact.firstName,
    contact.lastName,
    contact.title,
    contact.designation,
    contact.seniority,
    contact.department,
    contact.email,
    ...numbers.all,
  ]
    .map((value) => fold(value))
    .join(" ");
  return haystack.includes(term);
}

/** Apply every active filter. All conditions are ANDed; absent fields are ignored. */
export function contactMatchesFilters(contact: Contact, filters?: ContactFilters): boolean {
  if (!filters) return true;
  if (!contactMatchesQuery(contact, filters.query)) return false;
  if (filters.designation && contact.designation !== filters.designation) return false;
  if (filters.department && contact.department !== filters.department) return false;
  if (filters.seniority && contact.seniority !== filters.seniority) return false;
  if (filters.country && contact.country !== filters.country) return false;
  if (filters.city && contact.city !== filters.city) return false;
  if (filters.hasEmail && !contact.email) return false;
  // Phone covers mobile too: both are contact numbers, and the UI labels which
  // one it is. A record with only a mobile must not be hidden by "Has phone".
  if (filters.hasPhone && contactPhoneNumbers(contact).all.length === 0) return false;
  if (filters.hasLinkedin && !contact.linkedinUrl) return false;
  // One shared rule with the Worker (see `associationMatchesFilter`), so the
  // preview and production cannot disagree about which contacts are trusted.
  if (!associationMatchesFilter(contact.association?.category, filters.association)) return false;
  return true;
}
