/**
 * Contact facets for the Company Details filter bar.
 *
 * The active index has `person_title` in `title` and no canonical designation,
 * so stored facets came back empty. These assertions pin the fallback and the rule
 * that facets describe the whole collection, not the visible page.
 */

import { describe, expect, test } from "bun:test";

import { contactFacets } from "../src/shared/facets";
import type { Contact } from "../src/shared/models";

function contact(overrides: Partial<Contact>): Contact {
  return {
    id: `p_${Math.random().toString(16).slice(2, 10)}`,
    companyId: "c_1",
    fullName: "Person",
    source: { source: "csv2", row: 1 },
    ...overrides,
  };
}

describe("contactFacets", () => {
  test("uses the title as the designation when the canonical field is empty", () => {
    const facets = contactFacets([
      contact({ title: "Software Engineer", department: "['engineering']", country: "United States" }),
      contact({ title: "Software Engineer", department: "['engineering']", country: "India" }),
      contact({ title: "Director", designation: "Director", department: "['sales']" }),
    ]);
    expect(facets.designations).toEqual([
      { value: "Software Engineer", count: 2 },
      { value: "Director", count: 1 },
    ]);
    expect(facets.departments[0]).toEqual({ value: "['engineering']", count: 2 });
    expect(facets.countries).toHaveLength(2);
  });

  test("never counts only the visible page", () => {
    const all = Array.from({ length: 30 }, (_, index) =>
      contact({ title: `Role ${index % 3}`, email: index % 2 === 0 ? `p${index}@example.com` : undefined }),
    );
    const facets = contactFacets(all);
    expect(facets.designations.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(30);
    expect(facets.emailAvailable).toBe(15);
    expect(facets.linkedinAvailable).toBe(0);
  });
});
