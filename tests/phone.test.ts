/**
 * Phone/mobile extraction and the contact filter that uses it.
 *
 * The active real-data index was built before `mobile` existed as a contact
 * field, but it stores the original source row in `attributes`. These tests pin
 * the behaviour that makes those numbers visible without reindexing: the values
 * come from the stored attributes, keep their country code and extension, stay
 * separate from a mobile when the source names both, and are never invented from
 * an id, date, postal code or fax column.
 */

import { describe, expect, test } from "bun:test";

import {
  contactPhoneNumbers,
  extractPhoneNumbers,
  isPlausiblePhone,
  phoneKindOfHeader,
  splitPhoneExtension,
  telHref,
} from "../src/shared/phone";
import { contactMatchesFilters, contactMatchesQuery } from "../src/shared/contact-filter";
import type { Contact } from "../src/shared/models";

describe("phone columns and values", () => {
  test("recognises the headers real exports use, and refuses non-phone columns", () => {
    for (const header of ["phone", "person_phone", "person_sanitized_phone", "work_phone", "telephone", "contact_number", "direct_phone"]) {
      expect(phoneKindOfHeader(header)).toBe("phone");
    }
    for (const header of ["mobile", "person_mobile", "cell", "cell_phone", "mobile_number"]) {
      expect(phoneKindOfHeader(header)).toBe("mobile");
    }
    for (const header of ["fax", "person_fax", "person_num_linkedin_connections", "_id", "person_location_postal_code", "organization_domain", "person_phone_score"]) {
      expect(phoneKindOfHeader(header)).toBeNull();
    }
  });

  test("keeps the source formatting, country code and extension", () => {
    expect(isPlausiblePhone("+1 (503) 443-7070 ext. 42")).toBe(true);
    expect(splitPhoneExtension("+1 (503) 443-7070 ext. 42")).toEqual({
      base: "+1 (503) 443-7070",
      extension: "42",
    });
    expect(telHref("+1 (503) 443-7070 ext. 42")).toBe("tel:+15034437070;ext=42");
    expect(telHref("0044 20 7946 0958")).toBe("tel:+442079460958");
  });

  test("a mobile and a landline stay separate, and duplicates are listed once", () => {
    const numbers = extractPhoneNumbers({
      attributes: {
        person_phone: "+1 503 443 7070",
        person_sanitized_phone: "1 503 443 7070",
        person_mobile: "+1 503 555 0199",
      },
    });
    expect(numbers.phone).toBe("+1 503 443 7070");
    expect(numbers.mobile).toBe("+1 503 555 0199");
    expect(numbers.all).toEqual(["+1 503 443 7070", "+1 503 555 0199"]);
  });

  test("several distinct numbers are all preserved", () => {
    const numbers = extractPhoneNumbers({ phone: "+44 20 7946 0958; +44 20 7946 0999" });
    expect(numbers.all).toEqual(["+44 20 7946 0958", "+44 20 7946 0999"]);
    expect(numbers.additional).toEqual(["+44 20 7946 0999"]);
  });

  test("an id, a date, a postcode and a fax never become a phone number", () => {
    const numbers = extractPhoneNumbers({
      attributes: {
        _id: "5034437070",
        person_num_linkedin_connections: "123456",
        person_fax: "+1 503 443 7070",
        person_location_postal_code: "98052",
        job_start_date: "2013-02-01",
      },
    });
    expect(numbers.all).toEqual([]);
  });

  test("the active index case: a canonical phone is absent but the original column is present", () => {
    const numbers = contactPhoneNumbers({
      attributes: { person_phone: "(503) 443-7070", person_mobile: "503.555.0199" },
    });
    expect(numbers.phone).toBe("(503) 443-7070");
    expect(numbers.mobile).toBe("503.555.0199");
  });
});

describe("contact filtering", () => {
  const contact: Contact = {
    id: "p_1",
    companyId: "c_1",
    fullName: "Alex Khan",
    title: "Head of Sales",
    department: "['sales']",
    email: "alex@example.com",
    country: "United States",
    attributes: { person_phone: "+1 (503) 443-7070", person_mobile: "+1 (503) 555 0199" },
    source: { source: "csv2", row: 1 },
  };

  test("Has phone matches a mobile-only record", () => {
    const mobileOnly: Contact = { ...contact, attributes: { person_mobile: "+1 503 555 0199" } };
    expect(contactMatchesFilters(contact, { hasPhone: true })).toBe(true);
    expect(contactMatchesFilters(mobileOnly, { hasPhone: true })).toBe(true);
    expect(contactMatchesFilters({ ...contact, attributes: {} }, { hasPhone: true })).toBe(false);
  });

  test("the in-company search covers name, title and number", () => {
    expect(contactMatchesQuery(contact, "alex")).toBe(true);
    expect(contactMatchesQuery(contact, "head of sales")).toBe(true);
    expect(contactMatchesQuery(contact, "443-7070")).toBe(true);
    expect(contactMatchesQuery(contact, "no such person")).toBe(false);
  });

  test("filters combine with AND", () => {
    expect(contactMatchesFilters(contact, { hasPhone: true, hasEmail: true, country: "United States" })).toBe(true);
    expect(contactMatchesFilters({ ...contact, country: "Canada" }, { hasPhone: true, country: "United States" })).toBe(false);
  });
});
