/**
 * Association report helpers.
 *
 * These are the numbers the specification asks for after a sample run:
 * confirmed associations, ambiguous ones, name-only companies, unmatched
 * contacts, duplicate entities, rejected records and their reasons. The helpers
 * are pure, so they are tested with synthetic records — no source file, no
 * index, no credentials.
 */

import { describe, expect, test } from "bun:test";

import { rejectionSummary, sharedNameRisk, summariseAssociation } from "../scripts/lib/sample-report.mjs";

function company(overrides: Record<string, unknown>) {
  return {
    id: "c_x",
    name: "Acme",
    normalizedName: "acme",
    contactCount: 0,
    sources: [{ source: "csv1", row: 1 }],
    ...overrides,
  };
}

describe("cross-file join risk", () => {
  test("counts only companies whose normalized name is shared", () => {
    const companies = [
      { ref: 0, company: company({ id: "c_1", name: "Delta Systems", normalizedName: "delta", domain: "delta.example" }) },
      { ref: 1, company: company({ id: "c_2", name: "Delta Ltd", normalizedName: "delta" }) },
      { ref: 2, company: company({ id: "c_3", name: "Globex", normalizedName: "globex", domain: "globex.example" }) },
    ];
    const risk = sharedNameRisk({ companies, contactsByRef: new Map() });
    expect(risk.families).toBe(1);
    expect(risk.companiesInFamilies).toBe(2);
    expect(risk.largestFamily).toBe(2);
  });

  test("classifies contacts on a shared name by the country evidence", () => {
    const companies = [
      { ref: 0, company: company({ id: "c_1", normalizedName: "delta", country: "United States" }) },
      { ref: 1, company: company({ id: "c_2", normalizedName: "delta", country: "Germany" }) },
      { ref: 2, company: company({ id: "c_3", normalizedName: "globex" }) },
    ];
    const contactsByRef = new Map<number, unknown[]>([
      // Exactly one record in the family is in the United States → disambiguable.
      // A second contact on the same company has no country at all.
      [0, [{ country: "United States" }, { country: undefined }]],
      // A country none of the family has.
      [1, [{ country: "India" }]],
      // A unique-named company: never counted as risk, whatever evidence it has.
      [2, [{ country: "Germany" }]],
    ]);

    const risk = sharedNameRisk({ companies, contactsByRef });
    expect(risk.contactsOnSharedName).toBe(3);
    expect(risk.disambiguableByCountry).toBe(1);
    expect(risk.countryMatchesNone).toBe(1);
    expect(risk.noCountryEvidence).toBe(1);
  });

  test("the same seed is deterministic", () => {
    const companies = [
      { ref: 0, company: company({ normalizedName: "same" }) },
      { ref: 1, company: company({ normalizedName: "same" }) },
    ];
    const contactsByRef = new Map<number, unknown[]>([
      [0, [{ country: "France" }]],
      [1, [{ country: "France" }]],
    ]);
    const first = sharedNameRisk({ companies, contactsByRef });
    expect(sharedNameRisk({ companies, contactsByRef })).toEqual(first);
    // Neither record carries a country, so the contact's country matches none of
    // the family — never silently treated as a confirmed match.
    expect(first.countryMatchesNone).toBe(2);
    expect(first.disambiguableByCountry).toBe(0);
    expect(first.noCountryEvidence).toBe(0);
  });
});

describe("rejected rows", () => {
  test("groups by reason and by source, largest first", () => {
    const summary = rejectionSummary([
      { source: "csv1", reason: "missing_company_name" },
      { source: "csv2", reason: "missing_company_name" },
      { source: "csv2", reason: "missing_company_name" },
      { source: "csv2", reason: "unterminated_quote" },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.byReason).toEqual([
      ["missing_company_name", 3],
      ["unterminated_quote", 1],
    ]);
    expect(summary.bySource).toEqual([
      ["csv2", 3],
      ["csv1", 1],
    ]);
  });

  test("a row without a reason is counted as unknown, never dropped", () => {
    const summary = rejectionSummary([{}, { source: "csv1", reason: "missing_company_name" }]);
    expect(summary.total).toBe(2);
    expect(summary.byReason).toContainEqual(["unknown", 1]);
    expect(summary.bySource).toContainEqual(["unknown", 1]);
    expect(summary.bySource).toContainEqual(["csv1", 1]);
  });

  test("no rejections is an honest zero, not an error", () => {
    expect(rejectionSummary([])).toEqual({ total: 0, byReason: [], bySource: [] });
  });
});

describe("association summary", () => {
  test("contacts on an ambiguous company are counted separately", () => {
    const companies = [
      { ref: 0, company: company({ id: "c_1", domain: "acme.example" }) },
      { ref: 1, company: company({ id: "c_2", ambiguous: true }) },
    ];
    const contactsByRef = new Map<number, unknown[]>([[1, [{ email: "a@b.example" }, { email: "c@d.example" }]]]);
    const summary = summariseAssociation({ companies, contactsByRef });
    expect(summary.contacts.onAmbiguousCompany).toBe(2);
    expect(summary.contacts.onNameOnlyCompany).toBe(2);
    expect(summary.contacts.onIdentifiedCompany).toBe(0);
    expect(summary.associationRate).toBe(0);
  });
});
